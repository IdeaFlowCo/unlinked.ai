import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountGrantService, accountGrantTools, ACCOUNT_GRANT_TOOL_VERSIONS, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))

const header = 'First Name,Last Name,URL,Email Address,Company,Position\n'
const csv = header + [
  'Ada,Lovelace,https://www.linkedin.com/in/synthetic-ada,ada@private.invalid,Analytical,Engineer',
  'Grace,Hopper,https://www.linkedin.com/in/synthetic-grace,grace@private.invalid,Navy,Rear Admiral',
  'Edsger,Dijkstra,https://www.linkedin.com/in/synthetic-edsger,edsger@private.invalid,THE,Professor',
].join('\n') + '\n'

const publicProfile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const publishedSnapshot = () => ({ state: 'published', complete: true, revision: 'public-fixture-v1',
  profiles: [publicProfile('anchor-a', 'Anchor Owner'), publicProfile('legacy-b', 'Graph Engineer', { headline: 'Engineer' }), publicProfile('legacy-c', 'Index Designer')],
  connections: [{ fromId: 'anchor-a', toId: 'legacy-b' }, { fromId: 'legacy-b', toId: 'legacy-c' }] })

function fixture() {
  const owners = new Map(), resources = new Map(), assets = new Map()
  const key = x => JSON.stringify([x.ownerId, x.userId])
  const register = owner => owners.set(key(owner), owner)
  const getBackend = async owner => {
    if (!owners.has(key(owner))) throw new Error('owner_denied')
    const own = () => [...resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted)
    const readResource = async (_type, id) => {
      const value = resources.get(id)
      return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null
    }
    const writeResource = async value => {
      const prior = resources.get(value.sourceId)
      if (prior && (prior.sourceOwnerId !== owner.ownerId || prior.deleted || prior.sourceRevision !== value.expectedRevision)) throw new Error('cas_conflict')
      resources.set(value.sourceId, structuredClone(value))
    }
    return { readResource, writeResource,
      listImportIds: async () => own().filter(x => x.payload?.id === x.sourceId && !x.payload?.kind && !x.payload?.receiptOf && ['indexed', 'partial'].includes(x.payload.status)).map(x => x.sourceId).sort(),
      listAccountGrantIds: async () => own().filter(x => x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
      adapter: { withImport: async (caller, id, work) => work({ getJob: async () => (await readResource('import', id))?.payload,
        putAsset: async (hash, bytes) => assets.set(`${owner.ownerId}/${hash}`, Buffer.from(bytes)),
        publicationStatus: 'indexed',
        saveJob: async job => resources.set(id, { sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, payload: structuredClone(job) }),
        publish: async (job, assertions) => {
          job.assertionIds = assertions.map(x => x.id)
          resources.set(id, { sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, payload: structuredClone(job) })
          for (const row of assertions) resources.set(row.id, { sourceId: row.id, sourceOwnerId: owner.ownerId, payload: structuredClone(row) })
        },
      }) },
    }
  }
  return { register, getBackend, resources, assets }
}

async function launch(t, { f, readPublishedSnapshot, complete, limits }) {
  const owner = { ownerId: 'synthetic-agent-owner', userId: 'synthetic-agent-user' }
  const bindings = new Map()
  const signingKey = randomBytes(32)
  let browser, mcp, api
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'https://placeholder.invalid').pathname
    void (pathname === '/mcp' ? mcp(req, res) : pathname.startsWith('/api/agent/') ? api(req, res) : browser(req, res))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const grants = createAccountGrantService({ issuer: baseUrl, signingKey, getBackend: f.getBackend, publicSearchEnabled: typeof readPublishedSnapshot === 'function' })
  const service = createAccountToolService({ getBackend: f.getBackend, complete, readPublishedSnapshot, limits })
  browser = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'exact-opaque-subject', clientId: 'synthetic-client', verifiedAt: Math.floor(Date.now() / 1000), provenanceReceiptId: 'synthetic-callback-proof' }) },
    resolveOwner: async identity => bindings.get(`${identity.issuer}:${identity.subject}`),
    signup: async identity => { bindings.set(`${identity.issuer}:${identity.subject}`, owner); f.register(owner); return owner },
    getBackend: f.getBackend, complete, issueAccountGrant: grants.issueGrant, revokeAccountGrant: grants.revoke, mcpEndpoint: `${baseUrl}/mcp` })
  mcp = createAccountHostedHandler({ authenticateGrant: grants.authenticateGrant, getBackend: f.getBackend, complete, readPublishedSnapshot, origin: baseUrl, service })
  api = createAccountAgentApiHandler({ authenticateGrantDetailed: grants.authenticateGrantDetailed, authenticateGrant: grants.authenticateGrant, service, origin: baseUrl })
  const signIn = async () => {
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=synthetic`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    assert.equal(callback.status, 303)
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
    return { cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] }
  }
  const upload = async signed => {
    const form = new FormData(); form.set('csrf', signed.csrf); form.set('syntheticConsent', 'yes'); form.set('archive', new Blob([csv]), 'Connections.csv')
    const uploaded = await fetch(`${endpoint}/upload`, { method: 'POST', redirect: 'manual', headers: { Cookie: signed.cookie, Origin: baseUrl }, body: form })
    assert.equal(uploaded.status, 303)
  }
  return { owner, endpoint, baseUrl, grants, service, signIn, upload, f }
}

const call = (endpoint, token, path, options = {}) => fetch(`${endpoint}/api/agent/v1/${path}`, {
  ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) } })

test('HTTP agent API: whoami, deterministic listings, pagination, typed errors, privacy fences and revocation', async t => {
  const f = fixture()
  const complete = async ({ input, candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'Synthetic ranked reason' }] })
  const app = await launch(t, { f, readPublishedSnapshot: async () => publishedSnapshot(), complete })
  const signed = await app.signIn()
  await app.upload(signed)
  const { accessToken, grantId } = await app.grants.issueGrant(app.owner)

  // Fail closed on linkage: no token and malformed tokens are not_linked.
  for (const headers of [{}, { Authorization: 'Bearer not-a-grant' }]) {
    const denied = await fetch(`${app.endpoint}/api/agent/v1/whoami`, { headers })
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).error.code, 'not_linked')
  }

  // whoami returns the stable owner id and grant shape; no email anywhere.
  const who = await call(app.endpoint, accessToken, 'whoami')
  assert.equal(who.status, 200)
  const whoami = await who.json()
  assert.equal(whoami.ownerId, app.owner.ownerId)
  assert.equal(whoami.grant.version, CURRENT_ACCOUNT_GRANT_VERSION)
  assert.deepEqual(whoami.grant.tools, [...ACCOUNT_GRANT_TOOL_VERSIONS[2].owner_network_and_public])
  assert.equal(whoami.importCount, 1)
  assert.equal(whoami.publicIndexAvailable, true)

  // Degree-1 connections include owner-imported contacts without any legacy
  // anchor, deterministically ordered, with typed provenance and no contact email.
  const first = await call(app.endpoint, accessToken, 'connections?limit=2')
  assert.equal(first.status, 200)
  const page1 = await first.json()
  assert.equal(page1.degree, 1)
  assert.equal(page1.total, 3)
  assert.equal(page1.connections.length, 2)
  assert.deepEqual(page1.connections.map(x => x.name), ['Ada Lovelace', 'Edsger Dijkstra'])
  assert.equal(page1.connections[0].provenance.type, 'owner_import')
  assert.equal(page1.connections[0].linkedinUrl, 'https://www.linkedin.com/in/synthetic-ada')
  assert.ok(!JSON.stringify(page1).includes('private.invalid'))
  assert.ok(!JSON.stringify(page1).toLowerCase().includes('email'))
  const second = await call(app.endpoint, accessToken, `connections?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`)
  const page2 = await second.json()
  assert.deepEqual(page2.connections.map(x => x.name), ['Grace Hopper'])
  assert.equal(page2.nextCursor, undefined)
  // A cursor is bound to its query: reusing it with another filter is typed.
  const crossed = await call(app.endpoint, accessToken, `connections?limit=2&q=Navy&cursor=${encodeURIComponent(page1.nextCursor)}`)
  assert.equal(crossed.status, 400)
  assert.equal((await crossed.json()).error.code, 'cursor_invalid')
  const filtered = await (await call(app.endpoint, accessToken, 'connections?q=navy')).json()
  assert.deepEqual(filtered.connections.map(x => x.name), ['Grace Hopper'])

  // Second degree without a confirmed anchor is typed degree_unproven, never inferred.
  const unproven = await call(app.endpoint, accessToken, 'connections?degree=2')
  assert.equal(unproven.status, 409)
  assert.equal((await unproven.json()).error.code, 'degree_unproven')

  // Public People listing is deterministic with revision, total and cursor.
  const people = await (await call(app.endpoint, accessToken, 'people?limit=2')).json()
  assert.equal(people.revision, 'public-fixture-v1')
  assert.equal(people.total, 3)
  assert.deepEqual(people.profiles.map(x => x.id), ['anchor-a', 'legacy-b'])
  const peoplePage2 = await (await call(app.endpoint, accessToken, `people?limit=2&cursor=${encodeURIComponent(people.nextCursor)}`)).json()
  assert.deepEqual(peoplePage2.profiles.map(x => x.id), ['legacy-c'])
  const searched = await (await call(app.endpoint, accessToken, 'people?q=graph')).json()
  assert.deepEqual(searched.profiles.map(x => x.id), ['legacy-b'])
  assert.equal(searched.total, 1)

  // Profile detail with public connections; unknown ids are typed not_found.
  const detail = await (await call(app.endpoint, accessToken, 'people/legacy-b')).json()
  assert.equal(detail.profile.name, 'Graph Engineer')
  assert.deepEqual(detail.profile.connections.map(x => x.id), ['anchor-a', 'legacy-c'])
  const missing = await call(app.endpoint, accessToken, 'people/absent-id')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'not_found')

  // unlinked_ask over the owner's own network and over everyone.
  const mine = await (await call(app.endpoint, accessToken, 'ask', { method: 'POST', body: JSON.stringify({ query: 'who is an engineer?', scope: 'mine' }) })).json()
  assert.equal(mine.scope, 'mine')
  assert.equal(mine.considered, 3)
  assert.equal(mine.matches[0].reason, 'Synthetic ranked reason')
  assert.ok(!JSON.stringify(mine).includes('private.invalid'))
  const everyone = await (await call(app.endpoint, accessToken, 'ask', { method: 'POST', body: JSON.stringify({ query: 'graph engineer' }) })).json()
  assert.equal(everyone.scope, 'everyone')
  assert.equal(everyone.considered, 3)
  assert.equal(everyone.matches.length, 1)

  // The launch tools stay reachable over HTTP with the same names.
  const network = await (await call(app.endpoint, accessToken, 'search-network', { method: 'POST', body: JSON.stringify({ query: 'Engineer' }) })).json()
  assert.equal(network.scope, 'owner_network')
  const shared = await (await call(app.endpoint, accessToken, 'search-everyone', { method: 'POST', body: JSON.stringify({ query: 'graph' }) })).json()
  assert.equal(shared.scope, 'everyone')

  // Unknown routes and invalid input are typed, not free text.
  const unknown = await call(app.endpoint, accessToken, 'exports')
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'not_found')
  const invalid = await call(app.endpoint, accessToken, 'people?limit=0')
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'invalid_input')
  const unknownParameter = await call(app.endpoint, accessToken, 'people?mystery=1')
  assert.equal(unknownParameter.status, 400)

  // Revocation ends the session for every surface with a typed grant_revoked.
  await app.grants.revoke(app.owner, grantId)
  const revoked = await call(app.endpoint, accessToken, 'whoami')
  assert.equal(revoked.status, 401)
  assert.equal((await revoked.json()).error.code, 'grant_revoked')
})

test('old v1 grant records keep working unchanged: narrow MCP tool list, stateless JSON-RPC tools/call, no new tools over HTTP', async t => {
  const f = fixture()
  const complete = async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'Synthetic ranked reason' }] })
  const app = await launch(t, { f, readPublishedSnapshot: async () => publishedSnapshot(), complete })
  const signed = await app.signIn()
  await app.upload(signed)
  const { accessToken, grantId } = await app.grants.issueGrant(app.owner)

  // Rewrite the stored record to the exact shape the v1 issuer produced; the
  // bearer token is unchanged. This is what production grants look like today.
  const record = f.resources.get(grantId)
  record.payload.version = 1
  record.payload.tools = [...accountGrantTools(1, record.payload.scope)]
  assert.deepEqual(record.payload.tools, ['unlinked_search_network', 'unlinked_search_everyone'])
  const grant = await app.grants.authenticateGrant({ headers: { authorization: `Bearer ${accessToken}` } })
  assert.equal(grant.version, 1)
  assert.deepEqual(grant.tools, ['unlinked_search_network', 'unlinked_search_everyone'])

  // MCP listTools shows exactly the tools the grant was issued with.
  const client = new Client({ name: 'synthetic-v1-compat', version: '1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${app.endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })
  try {
    await client.connect(transport)
    assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['unlinked_search_network', 'unlinked_search_everyone'])
    const result = await client.callTool({ name: 'unlinked_search_network', arguments: { query: 'Engineer' } })
    assert.ok(!result.isError)
    assert.equal(JSON.parse(result.content[0].text).scope, 'owner_network')
  } finally { await client.close() }

  // The exact OpenChat integration shape: a bare stateless JSON-RPC POST.
  const stateless = await fetch(`${app.endpoint}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'unlinked_search_everyone', arguments: { query: 'graph engineer' } } }) })
  assert.equal(stateless.status, 200)
  const payload = await stateless.json()
  assert.equal(payload.id, 7)
  assert.ok(!payload.result.isError)
  assert.equal(JSON.parse(payload.result.content[0].text).scope, 'everyone')

  // v1 grants do not gain the new tools on any surface.
  const who = await call(app.endpoint, accessToken, 'whoami')
  assert.equal(who.status, 403)
  assert.equal((await who.json()).error.code, 'scope_not_granted')
})

test('owner_network scope cannot reach public tools; anchored owners get proven second-degree paths; MCP typed errors and shared rate budgets', async t => {
  const f = fixture()
  const complete = async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'Synthetic ranked reason' }] })
  // The private-scope app issues owner_network grants (no public search).
  const narrowApp = await launch(t, { f: fixture(), readPublishedSnapshot: undefined, complete })
  const narrowSigned = await narrowApp.signIn()
  await narrowApp.upload(narrowSigned)
  const narrow = await narrowApp.grants.issueGrant(narrowApp.owner)
  const narrowWho = await (await call(narrowApp.endpoint, narrow.accessToken, 'whoami')).json()
  assert.equal(narrowWho.grant.scope, 'owner_network')
  assert.equal(narrowWho.publicIndexAvailable, false)
  for (const [path, options] of [
    ['people', {}],
    ['people/legacy-b', {}],
    ['search-everyone', { method: 'POST', body: JSON.stringify({ query: 'graph' }) }],
  ]) {
    const denied = await call(narrowApp.endpoint, narrow.accessToken, path, options)
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'scope_not_granted')
  }
  const askEveryone = await call(narrowApp.endpoint, narrow.accessToken, 'ask', { method: 'POST', body: JSON.stringify({ query: 'graph', scope: 'everyone' }) })
  assert.equal(askEveryone.status, 403)
  assert.equal((await askEveryone.json()).error.code, 'scope_not_granted')
  const askMine = await (await call(narrowApp.endpoint, narrow.accessToken, 'ask', { method: 'POST', body: JSON.stringify({ query: 'engineer', scope: 'mine' }) })).json()
  assert.equal(askMine.scope, 'mine')
  // Omitted scope defaults to the widest scope the grant covers.
  const askDefault = await (await call(narrowApp.endpoint, narrow.accessToken, 'ask', { method: 'POST', body: JSON.stringify({ query: 'engineer' }) })).json()
  assert.equal(askDefault.scope, 'mine')
  // Wrong method on an existing route is 405 with Allow, not a phantom 404.
  const wrongMethod = await call(narrowApp.endpoint, narrow.accessToken, 'whoami', { method: 'POST', body: JSON.stringify({}) })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET')

  // An anchored owner reads recorded public paths — first and second degree.
  const anchored = fixture()
  const anchor = { profileId: 'anchor-a', receiptId: 'verified-receipt', revision: 'legacy-public-v1:synthetic-source', sourceSha256: 'synthetic-source' }
  const base = anchored.getBackend
  const withAnchor = async owner => ({ ...await base(owner),
    readLegacyProfile: async () => ({ ...anchor, profile: publishedSnapshot().profiles[0], profiles: publishedSnapshot().profiles, connections: publishedSnapshot().connections.filter(e => e.fromId === 'anchor-a') }) })
  const anchoredApp = await launch(t, { f: { ...anchored, getBackend: withAnchor }, readPublishedSnapshot: async () => publishedSnapshot(), complete })
  const anchoredSigned = await anchoredApp.signIn()
  const anchoredGrant = await anchoredApp.grants.issueGrant(anchoredApp.owner)
  const degree1 = await (await call(anchoredApp.endpoint, anchoredGrant.accessToken, 'connections')).json()
  assert.equal(degree1.total, 1)
  assert.equal(degree1.connections[0].provenance.type, 'recorded_public_path')
  assert.deepEqual(degree1.connections[0].provenance.path, { fromId: 'anchor-a', toId: 'legacy-b' })
  assert.equal(degree1.connections[0].visibility, 'public')
  const degree2 = await (await call(anchoredApp.endpoint, anchoredGrant.accessToken, 'connections?degree=2')).json()
  assert.equal(degree2.degree, 2)
  assert.equal(degree2.revision, 'public-fixture-v1')
  assert.deepEqual(degree2.connections.map(x => x.id), ['legacy-c'])
  assert.deepEqual(degree2.connections[0].provenance.path, { fromId: 'anchor-a', viaId: 'legacy-b', toId: 'legacy-c' })

  // The hosted MCP surface returns the same typed errors as the HTTP API.
  const mcpClient = new Client({ name: 'synthetic-typed-errors', version: '1.0' })
  const mcpTransport = new StreamableHTTPClientTransport(new URL(`${narrowApp.endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${narrow.accessToken}` } } })
  try {
    await mcpClient.connect(mcpTransport)
    assert.deepEqual((await mcpClient.listTools()).tools.map(x => x.name), ['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ask'])
    const who = await mcpClient.callTool({ name: 'unlinked_whoami', arguments: {} })
    assert.ok(!who.isError)
    assert.equal(JSON.parse(who.content[0].text).ownerId, narrowApp.owner.ownerId)
    const unproven = await mcpClient.callTool({ name: 'unlinked_list_connections', arguments: { degree: 2 } })
    assert.equal(unproven.isError, true)
    assert.equal(JSON.parse(unproven.content[0].text).error.code, 'degree_unproven')
    const denied = await mcpClient.callTool({ name: 'unlinked_ask', arguments: { query: 'graph', scope: 'everyone' } })
    assert.equal(denied.isError, true)
    assert.equal(JSON.parse(denied.content[0].text).error.code, 'scope_not_granted')
  } finally { await mcpClient.close() }

  // Rate budgets are typed and shared across the service instance.
  const limited = createAccountToolService({ getBackend: withAnchor, complete, readPublishedSnapshot: async () => publishedSnapshot(), limits: { deterministicPerMinute: 2, aiPerMinute: 1 } })
  const grant = await anchoredApp.grants.authenticateGrant({ headers: { authorization: `Bearer ${anchoredGrant.accessToken}` } })
  await limited.call({ grant, name: 'unlinked_whoami' })
  await limited.call({ grant, name: 'unlinked_whoami' })
  await assert.rejects(limited.call({ grant, name: 'unlinked_whoami' }), error => error instanceof AccountToolError && error.code === 'rate_limited')
  await limited.call({ grant, name: 'unlinked_ask', input: { query: 'engineer', scope: 'mine' } })
  await assert.rejects(limited.call({ grant, name: 'unlinked_ask', input: { query: 'engineer', scope: 'mine' } }), error => error.code === 'rate_limited')
  // Budgets are per owner: another owner's grant is not starved.
  const otherOwner = { ownerId: 'synthetic-other-owner', userId: 'synthetic-other-user' }
  anchored.register(otherOwner)
  const otherGrant = { ...grant, ownerId: otherOwner.ownerId, userId: otherOwner.userId }
  assert.equal((await limited.call({ grant: otherGrant, name: 'unlinked_whoami' })).result.ownerId, otherOwner.ownerId)
})

test('republished index invalidates cursors as typed cursor_invalid; transient backend failure is upstream_unavailable, not revocation', async t => {
  const f = fixture()
  const owner = { ownerId: 'synthetic-cursor-owner', userId: 'synthetic-cursor-user' }
  f.register(owner)
  let revision = 'public-rev-1'
  const snapshot = () => ({ ...publishedSnapshot(), revision })
  const complete = async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'Synthetic ranked reason' }] })
  const service = createAccountToolService({ getBackend: f.getBackend, complete, readPublishedSnapshot: async () => snapshot() })
  const grant = { ownerId: owner.ownerId, userId: owner.userId, grantId: 'x'.repeat(64), scope: 'owner_network_and_public', version: 2, tools: ['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ask'] }
  const first = (await service.call({ grant, name: 'unlinked_list_people', input: { limit: 1 } })).result
  assert.equal(first.revision, 'public-rev-1')
  revision = 'public-rev-2'
  await assert.rejects(service.call({ grant, name: 'unlinked_list_people', input: { limit: 1, cursor: first.nextCursor } }), error => error instanceof AccountToolError && error.code === 'cursor_invalid')
  // A fresh first page at the new revision works.
  assert.equal((await service.call({ grant, name: 'unlinked_list_people', input: { limit: 1 } })).result.revision, 'public-rev-2')
  // A garbage cursor is typed the same way.
  await assert.rejects(service.call({ grant, name: 'unlinked_list_people', input: { cursor: 'bm90LWEtY3Vyc29y' } }), error => error.code === 'cursor_invalid')

  // Grant verification distinguishes a backend blip from revocation.
  let backendDown = false
  const flaky = async o => { if (backendDown) throw new Error('backend_unreachable'); return f.getBackend(o) }
  const grants = createAccountGrantService({ issuer: 'https://synthetic-flaky.invalid', signingKey: randomBytes(32), getBackend: flaky, publicSearchEnabled: true })
  const issued = await grants.issueGrant(owner)
  const headers = { headers: { authorization: `Bearer ${issued.accessToken}` } }
  assert.ok((await grants.authenticateGrantDetailed(headers)).grant)
  backendDown = true
  assert.deepEqual(await grants.authenticateGrantDetailed(headers), { error: 'upstream_unavailable' })
  backendDown = false
  assert.ok((await grants.authenticateGrantDetailed(headers)).grant)
  assert.deepEqual(await grants.authenticateGrantDetailed({ headers: {} }), { error: 'not_linked' })
  await grants.revoke(owner, issued.grantId)
  assert.deepEqual(await grants.authenticateGrantDetailed(headers), { error: 'grant_revoked' })
})
