import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequestDiagnostics, diagnosticTransport } from '../mcp-server/request-diagnostics.mjs'
import { createSearchLog, safeSearchRecord, searchAccountId } from '../mcp-server/search-activity.mjs'
import { createDiagnosticsStore } from '../mcp-server/request-diagnostics-store.mjs'
import { readSearchLog } from '../scripts/read-search-log.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createIdeaflowConnectorHandler } from '../mcp-server/ideaflow-connector.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'
import { accountGrantTools } from '../mcp-server/account-grants.mjs'
const owner = { ownerId: randomUUID(), userId: randomUUID() }
const grant = { ...owner, grantId: 'test-grant', version: 4, scope: 'owner_network_and_public', tools: accountGrantTools(4, 'owner_network_and_public') }
const SECRET = 'synthetic-sensitive-never-log', gatewaySecret = 'synthetic-gateway-secret-at-least32chars'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
async function fixture(t, { complete, service, emit, enabled = true, maxPerMinute = 600, now, authError } = {}) {
  const rows = [], queries = [], searchLog = createSearchLog({ emit: row => queries.push(row) }), diagnostics = createRequestDiagnostics({ emit: emit ?? (row => rows.push(row)), maxPerMinute, ...(now ? { now } : {}) })
  let api, mcp, gateway, browser
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'https://synthetic.invalid').pathname
    const work = () => Promise.resolve(path === '/mcp' ? mcp(req, res) : path === '/api/connector/mcp' ? gateway(req, res) : path.startsWith('/api/agent/') ? api(req, res) : browser(req, res)).catch(() => { if (!res.headersSent) res.writeHead(503); res.end() })
    void searchLog.run(req, res, new URL('https://' + req.headers.host), () => enabled ? diagnostics.run(req, res, diagnosticTransport(path), work) : work())
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 7000 + Math.floor(Math.random() * 3000)
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }); break } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const host = `127.0.0.1:${server.address().port}`, origin = `https://${host}`, endpoint = `http://${host}`
  const authenticateGrant = async req => req.headers.authorization === `Bearer ${SECRET}` ? grant : null
  const getBackend = async () => ({ listImportIds: async () => [], readResource: async () => null })
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'private-revision', profiles: [{ id: 'private-profile-id', name: 'Engineer private-result-person', headline: 'Engineer', positions: [], education: [], skills: [] }], connections: [] })
  const completion = complete ?? (async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: SECRET }] }))
  const actualService = service ?? createAccountToolService({ getBackend, readPublishedSnapshot, complete: completion })
  api = createAccountAgentApiHandler({ origin, authenticateGrant, authenticateGrantDetailed: async req => { if (authError) return { error: authError }; const g = await authenticateGrant(req); return g ? { grant: g } : { error: 'not_linked' } }, service: actualService })
  mcp = createAccountHostedHandler({ origin, authenticateGrant, getBackend, readPublishedSnapshot, complete: completion, service: actualService })
  gateway = createIdeaflowConnectorHandler({ origin, secret: gatewaySecret, resolveOwner: async () => owner, getBackend, readPublishedSnapshot, complete: completion, service: actualService })
  browser = createPrivateBrowserHandler({ baseUrl: origin, login: { begin: async () => {}, finish: async () => {} }, resolveOwner: async () => null, getBackend, readPublishedSnapshot, complete: completion, autoSignIn: false })
  const rest = (path, init = {}) => fetch(endpoint + '/api/agent/v1/' + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...init.headers } })
  const rpc = (body, headers = {}, path = '/mcp') => fetch(endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
  return { rows, queries, rest, rpc, endpoint }
}
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: SECRET, method: 'tools/call', params: { name, arguments: args } })

test('real browser/public searches log text and filters once, excluding probes and unrelated routes', async t => {
  const f = await fixture(t, { enabled: false })
  for (const path of ['/search-public?q=engineer', '/api/people?q=engineer&mode=exact', '/search-suggestions?q=engineer', '/people?q=engineer&company=Analytical']) {
    const response = await fetch(f.endpoint + path)
    assert.equal(response.status, 200, path); await response.text()
  }
  assert.deepEqual(f.queries.map(row => row.surface), ['public_search', 'public_api', 'suggestions', 'directory'])
  for (const row of f.queries) { assert.equal(row.query, 'engineer'); assert.equal(row.http_status, 200); assert.equal(row.account_id, undefined); assert.equal(row.cancelled, false) }
  assert.deepEqual(f.queries.at(-1).filters, { company: 'Analytical' })
  assert.equal(f.queries[1].result_count, 1)
  for (const path of ['/search-public', '/agents?query=UNRELATED', '/messages?q=UNRELATED', '/api/private-context?q=UNRELATED']) await (await fetch(f.endpoint + path, { redirect: 'manual' })).text()
  await fetch(f.endpoint + '/search-public?q=HEAD-PROBE', { method: 'HEAD' })
  assert.equal(f.queries.length, 4)
})

test('REST and both MCP launch/service tools retain query text without diagnostics enabled', async t => {
  const f = await fixture(t, { enabled: false })
  await (await f.rest('people?q=engineer&limit=1&cursor=CURSOR-SECRET')).text()
  let row = f.queries.at(-1)
  assert.equal(row.query, 'engineer'); assert.equal(row.page_limit, 1); assert.equal(row.cursor_supplied, true)
  assert.equal(row.account_id, searchAccountId(owner.ownerId))
  await (await f.rest('ai-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({query:'engineer'}) })).text()
  for (const tool of ['unlinked_ai_search', 'unlinked_search_network', 'unlinked_search_everyone']) {
    const before = f.queries.length
    const response = await f.rpc(call(tool, {query:'engineer'})); await response.json()
    assert.equal(f.queries.length, before + 1)
    row = f.queries.at(-1); assert.equal(row.surface, tool); assert.equal(row.query, 'engineer'); assert.equal(row.transport, 'direct_mcp')
    assert.equal(row.account_id, searchAccountId(owner.ownerId))
  }
  assert.equal(f.rows.length, 0)
  const text = JSON.stringify(f.queries)
  for (const value of [SECRET, owner.ownerId, owner.userId, 'private-profile-id', 'private-result-person', 'CURSOR-SECRET']) assert.ok(!text.includes(value), value)
})

test('MCP failures and invalid schemas produce one bounded query record, rejected credentials have no owner', async t => {
  const f = await fixture(t, { enabled: false, service: { call: async () => { throw new AccountToolError('rate_limited', SECRET) } } })
  await (await f.rpc(call('unlinked_ai_search', {query:'engineer'}))).json()
  assert.equal(f.queries.at(-1).error_class, 'rate_limited')
  await (await f.rpc(call('unlinked_ai_search', {query:'x'.repeat(5000)}))).json()
  assert.equal(f.queries.at(-1).error_class, 'protocol_error'); assert.equal(f.queries.at(-1).query_truncated, true)
  const before = f.queries.length
  await (await f.rpc(call('unlinked_ai_search', {query:SECRET}), { Authorization:'Bearer INVALID' })).text()
  assert.equal(f.queries.length, before)
})

test('private persistence keeps only the projected search schema, supports operator reading and seven-date cleanup', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.search-log-test-')); t.after(() => rm(dir, {recursive:true,force:true}))
  let now = new Date('2026-11-11T00:00:00Z')
  await writeFile(join(dir,'requests-2026-11-04.jsonl'),'old',{mode:0o600})
  const store = await createDiagnosticsStore({directory:dir,now:()=>now,project:safeSearchRecord}); t.after(()=>store.close())
  const value = {schema:1,event:'search_query',at:now.toISOString(),request_id:randomUUID(),surface:'public_search',transport:'browser',query:'Find gaming investors',query_chars:21,headers:SECRET,results:SECRET,rawOwner:SECRET}
  store.emit(value); await store.flush()
  const result = await readSearchLog({directory:dir,since:now.toISOString()})
  assert.equal(result.records[0].query, value.query); assert.equal(result.records[0].headers, undefined)
  assert.ok(!JSON.stringify(result).includes(SECRET)); assert.equal((await stat(join(dir,'requests-2026-11-11.jsonl'))).mode & 0o777,0o600)
  await assert.rejects(readFile(join(dir,'requests-2026-11-04.jsonl')), /ENOENT/)
  await assert.rejects(readSearchLog({directory:dir}), /filter_required/)
  await chmod(dir,0o755); await assert.rejects(readSearchLog({directory:dir,since:now.toISOString()}),/not_private/); await chmod(dir,0o700)
  now = new Date('2026-11-18T00:00:00Z'); store.emit({...value,at:now.toISOString()});await store.flush()
  await assert.rejects(readFile(join(dir,'requests-2026-11-11.jsonl')), /ENOENT/)
})

test('projection bounds Unicode and filter fields below the sink row limit and never preserves extra data', () => {
  const row=safeSearchRecord({schema:1,event:'search_query',at:new Date().toISOString(),request_id:randomUUID(),surface:'directory',transport:'browser',query:'"\\🧑'.repeat(1000),filters:Object.fromEntries(['company','location','pastCompany','title','school','industry','kind','relationType','extra'].map(key=>[key,'"\\🧑'.repeat(1000)])),headers:SECRET})
  assert.ok(Buffer.byteLength(JSON.stringify(row)) < 4096)
  assert.equal(row.filters.extra,undefined); assert.equal(row.headers,undefined)
})

function assertion(body, jti) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://www.unlinked.ai/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: SECRET, jti, iat: now, exp: now + 45, scope: 'unlinked:read', body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', gatewaySecret).update(`${header}.${payload}`).digest('base64url')}`
}

test('shared connector logs verified queries once without gateway credentials or replay records', async t => {
  const f = await fixture(t, {enabled:false}), body=call('unlinked_ai_search',{query:'engineer'}), jti=randomUUID(), token=assertion(JSON.stringify(body),jti)
  const response=await f.rpc(body,{Authorization:`Bearer ${token}`},'/api/connector/mcp');assert.equal(response.status,200);await response.json()
  assert.equal(f.queries.length,1);assert.equal(f.queries[0].transport,'gateway_mcp');assert.equal(f.queries[0].query,'engineer');assert.equal(f.queries[0].account_id,searchAccountId(owner.ownerId))
  assert.equal((await f.rpc(body,{Authorization:`Bearer ${token}`},'/api/connector/mcp')).status,401);assert.equal(f.queries.length,1)
  for(const value of [token,jti,SECRET,owner.ownerId])assert.ok(!JSON.stringify(f.queries).includes(value))
})
