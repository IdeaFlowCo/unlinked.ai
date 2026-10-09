import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createRequestDiagnostics, diagnosticTransport, diagnosticAccountId, safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createIdeaflowConnectorHandler } from '../mcp-server/ideaflow-connector.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, createAccountGrantService } from '../mcp-server/account-grants.mjs'

const owner = { ownerId: randomUUID(), userId: randomUUID() }
const grant = { ...owner, grantId: 'test-grant', version: 4, scope: 'owner_network_and_public', tools: accountGrantTools(4, 'owner_network_and_public') }
const SECRET = 'synthetic-sensitive-never-log', gatewaySecret = 'synthetic-gateway-secret-at-least32chars'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
async function fixture(t, { complete, service, emit, enabled = true, maxPerMinute = 600, now, authError, authentication, backend, snapshot } = {}) {
  const rows = [], diagnostics = createRequestDiagnostics({ emit: emit ?? (row => rows.push(row)), maxPerMinute, ...(now ? { now } : {}) })
  let api, mcp, gateway
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'https://synthetic.invalid').pathname
    const work = () => Promise.resolve(path === '/mcp' ? mcp(req, res) : path === '/api/connector/mcp' ? gateway(req, res) : api(req, res)).catch(() => { if (!res.headersSent) res.writeHead(503); res.end() })
    if (enabled) void diagnostics.run(req, res, diagnosticTransport(path), work)
    else void work()
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 7000 + Math.floor(Math.random() * 3000)
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }); break } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const host = `127.0.0.1:${server.address().port}`, origin = `https://${host}`, endpoint = `http://${host}`
  const authenticateGrant = authentication?.authenticateGrant ?? (async req => req.headers.authorization === `Bearer ${SECRET}` ? grant : null)
  const authenticateGrantDetailed = authentication?.authenticateGrantDetailed ?? (async req => { if (authError) return { error: authError }; const g = await authenticateGrant(req); return g ? { grant: g } : { error: 'not_linked' } })
  const getBackend = backend ?? (async () => ({ listImportIds: async () => [], readResource: async () => null }))
  const readPublishedSnapshot = snapshot ?? (async () => ({ state: 'published', complete: true, revision: 'private-revision', profiles: [{ id: 'private-profile-id', name: 'Engineer private-result-person', headline: 'Engineer', positions: [], education: [], skills: [] }], connections: [] }))
  const completion = complete ?? (async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: SECRET }] }))
  const actualService = service ?? createAccountToolService({ getBackend, readPublishedSnapshot, complete: completion })
  api = createAccountAgentApiHandler({ origin, authenticateGrant, authenticateGrantDetailed, service: actualService })
  mcp = createAccountHostedHandler({ origin, authenticateGrant, authenticateGrantDetailed, getBackend, readPublishedSnapshot, complete: completion, service: actualService })
  gateway = createIdeaflowConnectorHandler({ origin, secret: gatewaySecret, resolveOwner: async () => owner, getBackend, readPublishedSnapshot, complete: completion, service: actualService })
  const rest = (path, init = {}) => fetch(endpoint + '/api/agent/v1/' + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...init.headers } })
  const rpc = (body, headers = {}, path = '/mcp') => fetch(endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
  return { rows, rest, rpc, endpoint }
}
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: SECRET, method: 'tools/call', params: { name, arguments: args } })

test('REST captures only trusted metadata and server-generated IDs, never caller secrets or query/result contents', async t => {
  const f = await fixture(t)
  const forged = randomUUID(), query = 'engineer ' + SECRET
  const body = JSON.stringify({ query })
  const response = await f.rest('ai-search', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: SECRET, 'X-Request-ID': forged, 'X-Owner-ID': 'forged-owner', traceparent: SECRET }, body })
  assert.equal(response.status, 200)
  const result = await response.text(); assert.ok(result.includes(SECRET))
  assert.equal(f.rows.length, 1)
  const row = f.rows[0]
  assert.match(response.headers.get('x-request-id'), UUID); assert.notEqual(row.request_id, forged); assert.equal(response.headers.get('x-request-id'), row.request_id)
  assert.equal(row.account_id, diagnosticAccountId(owner.ownerId)); assert.equal(row.auth_outcome, 'accepted')
  assert.equal(row.route, '/api/agent/v1/ai-search'); assert.equal(row.transport, 'rest'); assert.equal(row.tool, 'unlinked_ai_search')
  assert.equal(row.query_chars, query.length); assert.equal(row.result_count, 1)
  assert.equal(row.request_bytes_observed, Buffer.byteLength(body)); assert.equal(row.response_bytes, Buffer.byteLength(result)); assert.equal(row.response_complete, true)
  assert.ok(row.duration_ms >= 0); assert.ok(Date.parse(row.at)); assert.ok(Date.parse(row.completed_at))
  const log = JSON.stringify(row)
  for (const sensitive of [SECRET, forged, 'forged-owner', owner.ownerId, owner.userId, 'private-profile-id', 'private-result-person', 'private-revision', 'Bearer', 'Cookie', 'traceparent']) assert.ok(!log.includes(sensitive), sensitive)
  const denied = await f.rest('whoami?token=' + SECRET, { headers: { Authorization: 'Bearer WRONG-' + SECRET, 'X-Owner-ID': owner.ownerId } })
  assert.equal(denied.status, 401); const rejection = f.rows.at(-1)
  assert.equal(rejection.auth_outcome, 'rejected'); assert.equal(rejection.error_class, 'not_linked'); assert.equal(rejection.account_id, undefined)
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})

test('REST typed errors, rate limits, cursor flags and unknown routes never record arbitrary strings', async t => {
  const service = { call: async ({ input }) => {
    if (input.q === 'fail') throw new AccountToolError('rate_limited', SECRET)
    return { result: { people: [{ name: SECRET }], nextCursor: SECRET, truncated: true }, text: JSON.stringify({ people: [{ name: SECRET }], nextCursor: SECRET }) }
  } }
  const f = await fixture(t, { service })
  assert.equal((await f.rest('people?q=fail')).status, 429)
  assert.equal(f.rows.at(-1).error_class, 'rate_limited'); assert.equal(f.rows.at(-1).rate_limited, true)
  await (await f.rest('people?q=' + SECRET + '&limit=2&cursor=' + SECRET)).text()
  const row = f.rows.at(-1); assert.equal(row.cursor_supplied, true); assert.equal(row.page_limit, 2); assert.equal(row.has_next_page, true); assert.equal(row.truncated, true); assert.equal(row.result_count, 1)
  assert.equal((await f.rest(SECRET + '?secret=' + SECRET)).status, 404)
  assert.equal(f.rows.at(-1).route, '/api/agent/unknown')
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})

test('MCP observes actual protocol dispatch, schema errors and typed tool errors without JSON-RPC IDs', async t => {
  const f = await fixture(t)
  const res = await f.rpc(call('unlinked_ai_search', { query: 'engineer ' + SECRET }))
  assert.equal(res.status, 200); const value = await res.json(); assert.equal(value.result.isError, undefined)
  let row = f.rows.at(-1); assert.equal(row.rpc_method, 'tools/call'); assert.equal(row.tool, 'unlinked_ai_search'); assert.equal(row.result_count, 1); assert.equal(row.account_id, diagnosticAccountId(owner.ownerId))
  await (await f.rpc(call(SECRET, { query: SECRET }))).json()
  row = f.rows.at(-1); assert.equal(row.tool, 'unknown'); assert.equal(row.error_class, 'protocol_error')
  await (await f.rpc(call('unlinked_ai_search', { query: SECRET.repeat(80) }))).json()
  assert.equal(f.rows.at(-1).error_class, 'protocol_error')
  const bad = await f.rpc(call('unlinked_whoami'), { Authorization: SECRET })
  assert.equal(bad.status, 401); assert.equal(f.rows.at(-1).account_id, undefined)
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})

test('provider errors and inner AI timeout are recorded even when converted to sanitized HTTP/MCP failures', async t => {
  let mode = 'provider'
  const f = await fixture(t, { complete: async ({ signal }) => {
    if (mode === 'provider') throw new Error('private_search_provider_http_429')
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const provider = await f.rpc(call('unlinked_ai_search', { query: 'engineer' }))
  assert.equal(provider.status, 200); assert.equal((await provider.json()).result.isError, true)
  assert.equal(f.rows.at(-1).error_class, 'upstream_unavailable'); assert.equal(f.rows.at(-1).failure_stage, 'provider_rate_limit')
  mode = 'timeout'
  const timeout = await f.rest('ai-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'engineer', timeoutMs: 1000 }) })
  assert.equal(timeout.status, 503); assert.equal(f.rows.at(-1).timed_out, true); assert.equal(f.rows.at(-1).cancelled, false); assert.equal(f.rows.at(-1).requested_timeout_ms, 1000)
})

test('client disconnect records a single cancelled request without inventing an HTTP status', async t => {
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { service: { call: async ({ signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } } })
  const req = httpRequest(f.endpoint + '/api/agent/v1/whoami', { headers: { Authorization: `Bearer ${SECRET}` } }); req.on('error', () => {}); req.end()
  await ready; req.destroy()
  for (let i = 0; !f.rows.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].cancelled, true); assert.equal(f.rows[0].response_complete, false); assert.equal(f.rows[0].http_status, null)
})

function assertion(body, jti) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://www.unlinked.ai/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: SECRET, jti, iat: now, exp: now + 45, scope: 'unlinked:read', body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', gatewaySecret).update(`${header}.${payload}`).digest('base64url')}`
}
test('gateway correlation uses only the verified assertion, rejects replay and ignores caller IDs', async t => {
  const f = await fixture(t), body = call('unlinked_ai_search', { query: 'engineer' }), jti = randomUUID(), forged = randomUUID()
  const token = assertion(JSON.stringify(body), jti)
  const response = await f.rpc(body, { Authorization: `Bearer ${token}`, 'X-Request-ID': forged }, '/api/connector/mcp')
  assert.equal(response.status, 200); await response.json()
  const row = f.rows.at(-1)
  assert.equal(row.transport, 'gateway_mcp'); assert.equal(row.auth_type, 'gateway_assertion'); assert.equal(row.auth_outcome, 'accepted')
  assert.equal(row.gateway_assertion_hash, createHash('sha256').update(jti).digest('hex'))
  assert.equal(row.account_id, diagnosticAccountId(owner.ownerId)); assert.equal(row.request_id, response.headers.get('x-request-id')); assert.notEqual(row.request_id, forged)
  assert.equal((await f.rpc(body, { Authorization: `Bearer ${token}` }, '/api/connector/mcp')).status, 401)
  assert.equal(f.rows.at(-1).gateway_assertion_hash, undefined); assert.equal(f.rows.at(-1).account_id, undefined)
  for (const value of [token, SECRET, jti, forged]) assert.ok(!JSON.stringify(f.rows).includes(value))
})

test('disabled, throwing, saturated diagnostics preserve response behavior and bounded volume', async t => {
  const disabled = await fixture(t, { enabled: false }); const response = await disabled.rest('whoami'); assert.equal(response.status, 200); assert.equal(response.headers.get('x-request-id'), null); assert.equal(disabled.rows.length, 0)
  const throwing = await fixture(t, { emit: () => { throw new Error(SECRET) } }); assert.equal((await throwing.rest('whoami')).status, 200)
  let date = new Date('2026-10-09T00:00:00Z')
  const limited = await fixture(t, { maxPerMinute: 1, now: () => date })
  for (let i = 0; i < 3; i++) assert.equal((await limited.rest('whoami')).status, 200)
  assert.equal(limited.rows.length, 1)
  date = new Date('2026-10-09T00:01:00Z'); await limited.rest('whoami')
  assert.equal(limited.rows.length, 2); assert.equal(limited.rows[1].dropped_since_last_emit, 2)
})

test('authentication infrastructure failure is unavailable, not a rejected or authenticated owner', async t => {
 const f = await fixture(t, { authError: 'upstream_unavailable' })
 assert.equal((await f.rest('whoami')).status, 503)
 assert.equal(f.rows[0].auth_outcome, 'unavailable'); assert.equal(f.rows[0].account_id, undefined)
})


test('MCP preserves legacy 401 while diagnosing durable grant rejection and infrastructure failure', async t => {
  let record, unavailable = false
  const authentication = createAccountGrantService({ issuer: 'https://synthetic.invalid', signingKey: new Uint8Array(32).fill(7), getBackend: async () => {
    if (unavailable) throw new Error(SECRET)
    return { writeResource: async value => { record = value }, readResource: async () => record }
  } })
  const { accessToken } = await authentication.issueGrant(owner)
  const f = await fixture(t, { authentication })
  for (const mode of ['accepted', 'upstream_unavailable', 'grant_revoked', 'not_linked']) {
    unavailable = mode === 'upstream_unavailable'
    if (mode === 'grant_revoked') record = { ...record, deleted: true, payload: null }
    const token = mode === 'not_linked' ? SECRET : accessToken
    const response = await f.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${token}` })
    assert.equal(response.status, mode === 'accepted' ? 200 : 401)
    await response.text()
    const row = f.rows.at(-1)
    assert.equal(row.auth_outcome, mode === 'accepted' ? 'accepted' : mode === 'upstream_unavailable' ? 'unavailable' : 'rejected')
    assert.equal(row.error_class, mode === 'accepted' ? undefined : mode)
    assert.equal(row.account_id, mode === 'accepted' ? diagnosticAccountId(owner.ownerId) : undefined)
    if (mode !== 'accepted') assert.equal(await authentication.authenticateGrant({ headers: { authorization: `Bearer ${token}` } }), null)
  }
  for (const secret of [SECRET, accessToken, owner.ownerId, owner.userId]) assert.ok(!JSON.stringify(f.rows).includes(secret))
})

test('REST preserves original timeout and cancellation flags across real service error translation', async t => {
  let failure
  const f = await fixture(t, { backend: async () => { throw failure } })
  for (const name of ['TimeoutError', 'AbortError']) {
    failure = new DOMException(SECRET, name)
    for (const [path, body] of [['search-network', { query: SECRET }], ['search-network', { query: 'connections', degree: 2 }], ['connections', null], ['connections?degree=2', null]]) {
      const response = await f.rest(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, 'upstream_unavailable')
      const row = f.rows.at(-1)
      assert.equal(row.error_class, 'upstream_unavailable')
      assert.equal(row.timed_out, name === 'TimeoutError')
      assert.equal(row.cancelled, name === 'AbortError')
    }
  }
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})

test('REST raw backend errors use outward typed class and retain request signal timeout', async t => {
  const f = await fixture(t, { backend: async () => { throw new Error(SECRET) } })
  let response = await f.rest('whoami')
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'upstream_unavailable')
  assert.equal(f.rows.at(-1).error_class, 'upstream_unavailable')
  assert.equal(f.rows.at(-1).timed_out, false)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', ms => ms === 60000 ? AbortSignal.abort(new DOMException(SECRET, 'TimeoutError')) : timeout(ms))
  response = await f.rest('whoami')
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'upstream_unavailable')
  assert.equal(f.rows.at(-1).error_class, 'upstream_unavailable')
  assert.equal(f.rows.at(-1).timed_out, true)
  assert.equal(f.rows.at(-1).cancelled, false)
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})

test('real People listing and degree-filtered search count profiles on REST and MCP', async t => {
  const profiles = ['a', 'b', 'c'].map(id => ({ id, name: SECRET + id, positions: [], education: [], skills: [] }))
  const f = await fixture(t, {
    backend: async () => ({ readLegacyProfile: async () => ({ profileId: 'a', receiptId: 'receipt', revision: 'legacy' }) }),
    snapshot: async () => ({ state: 'published', complete: true, revision: 'public', profiles, connections: [{ fromId: 'a', toId: 'b' }, { fromId: 'b', toId: 'c' }] }),
  })
  const people = await f.rest('people?limit=2')
  assert.equal(people.status, 200)
  const listing = await people.json()
  assert.equal(listing.profiles.length, 2)
  assert.equal(f.rows.at(-1).result_count, 2)
  assert.equal(f.rows.at(-1).has_next_page, true)
  const search = await f.rest('search-network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'connections', degree: 2 }) })
  assert.equal(search.status, 200)
  assert.equal((await search.json()).profiles.length, 1)
  assert.equal(f.rows.at(-1).result_count, 1)
  for (const [tool, args, count] of [['unlinked_list_people', { limit: 2 }, 2], ['unlinked_search_network', { query: 'connections', degree: 2 }, 1]]) {
    const response = await f.rpc(call(tool, args))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.result.isError, undefined)
    assert.equal(JSON.parse(result.result.content[0].text).profiles.length, count)
    assert.equal(f.rows.at(-1).result_count, count)
  }
  assert.ok(!JSON.stringify(f.rows).includes(SECRET))
})


test('concurrent MCP batches retain one request row without cross-call attribution', async t => {
  for (const mode of ['success', 'provider-error', 'timeout']) {
    const outputs = []
    for (const enabled of [true, false]) {
      let whoamiFinished
      const ready = new Promise(resolve => { whoamiFinished = resolve })
      const order = []
      const actual = createAccountToolService({
        getBackend: async () => ({ listImportIds: async () => [] }),
        readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'private-revision', profiles: [{ id: 'private-profile-id', name: SECRET, headline: 'Engineer', positions: [], education: [], skills: [] }], connections: [] }),
        complete: async ({ candidateIds }) => {
          await ready
          if (mode === 'provider-error') throw new Error('private_search_provider_http_429')
          if (mode === 'timeout') throw new DOMException(SECRET, 'TimeoutError')
          return { matches: [{ id: candidateIds[0], reason: SECRET }] }
        },
      })
      const service = { call: async args => {
        try { return await actual.call(args) }
        finally {
          order.push(args.name)
          if (args.name === 'unlinked_whoami') whoamiFinished()
        }
      } }
      const f = await fixture(t, { service, enabled })
      const batch = [
        { ...call('unlinked_ai_search', { query: 'engineer ' + SECRET }), id: SECRET + '-search' },
        { ...call('unlinked_whoami'), id: SECRET + '-whoami' },
      ]
      const response = await f.rpc(batch)
      assert.equal(response.status, 200)
      const text = await response.text(), result = JSON.parse(text)
      outputs.push(result)
      assert.deepEqual(order, ['unlinked_whoami', 'unlinked_ai_search'])
      assert.equal(result.length, 2)
      assert.equal(result.find(value => value.id.endsWith('-whoami')).result.isError, undefined)
      assert.equal(result.find(value => value.id.endsWith('-search')).result.isError, mode === 'success' ? undefined : true)
      assert.equal(f.rows.length, enabled ? 1 : 0)
      if (!enabled) continue
      const row = f.rows[0]
      assert.equal(row.rpc_batch, true)
      assert.equal(row.rpc_message_count, 2)
      assert.equal(row.account_id, diagnosticAccountId(owner.ownerId))
      assert.equal(row.auth_outcome, 'accepted')
      assert.equal(row.http_status, 200)
      assert.equal(row.request_id, response.headers.get('x-request-id'))
      assert.equal(row.request_bytes_observed, Buffer.byteLength(JSON.stringify(batch)))
      assert.equal(row.response_bytes, Buffer.byteLength(text))
      assert.equal(row.response_complete, true)
      assert.equal(row.cancelled, false)
      assert.ok(row.duration_ms >= 0)
      assert.ok(Date.parse(row.at)); assert.ok(Date.parse(row.completed_at))
      for (const field of ['tool', 'rpc_method', 'query_chars', 'result_count', 'considered', 'indexed', 'lexical_matches', 'model_candidates', 'error_class', 'failure_stage', 'timed_out', 'rate_limited', 'requested_timeout_ms', 'has_next_page', 'truncated', 'page_limit', 'cursor_supplied']) assert.equal(Object.hasOwn(row, field), false, field)
      assert.deepEqual(safeDiagnosticRecord(row), row)
      for (const secret of [SECRET, owner.ownerId, owner.userId, 'private-profile-id', 'private-revision']) assert.ok(!JSON.stringify(row).includes(secret))
    }
    assert.deepEqual(outputs[0], outputs[1])
  }
})
