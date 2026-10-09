import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { manualKeyFixture } from './helpers/manual-key-fixture.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION, ACCOUNT_WRITE_SCOPE, ACCOUNT_OWNER_WRITE_SCOPE } from '../mcp-server/account-grants.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'

const authenticate = (f, token) => f.grants.authenticateGrant({ headers: { authorization: `Bearer ${token}` } })

test('malformed historical catalogs fail closed through authentication, REST, MCP and Settings management', async t => {
  const f = await fixture(t)
  for (const version of [1, 2]) {
    const key = await f.grants.issueGrant(f.owner, undefined, { scope: 'owner_network' })
    const record = f.resources.get(key.grantId)
    for (const tools of [null, [], [...accountGrantTools(version, 'owner_network'), 'unlinked_send_connection_request']]) {
      record.payload.version = version
      record.payload.tools = tools
      const before = structuredClone(record)
      assert.equal(await authenticate(f, key.accessToken), null)
      assert.equal((await f.rest(key.accessToken, 'whoami')).status, 401)
      const mcp = await fetch(f.mcpEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${key.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      assert.equal(mcp.status, 401)
      await mcp.text()
      await assert.rejects(f.grants.readKey(f.owner, key.grantId), /account_grant_not_found/)
      await assert.rejects(f.grants.setConnectionActions(f.owner, key.grantId, true), /account_grant_not_found/)
      assert.ok(!(await f.grants.listGrants(f.owner)).some(row => row.id === key.grantId))
      assert.deepEqual(f.resources.get(key.grantId), before)
    }
  }
  assert.equal(f.writes(), 0)
})

async function fixture(t) {
  const f = await manualKeyFixture({ connectionActions: true, connectorPreview: true }); t.after(f.close)
  let beforeCall, duringRead, beforeSend, afterWrite, writes = 0
  const getBackend = async owner => ({ ...await f.options.getBackend(owner), listImportIds: async () => { const run = duringRead; duringRead = null; await run?.(); return [] } })
  const readPublishedSnapshot = async () => { const run = beforeSend; beforeSend = null; await run?.(); return { state: 'published', complete: true, revision: 'synthetic-permissions', profiles: [{ id: 'target', name: 'Synthetic Target', positions: [], education: [], skills: [] }], members: ['target'], connections: [] } }
  const write = async () => { writes++; await afterWrite?.(); return { status: 'pending', request: { id: 'synthetic-request' } } }
  const memberConnections = { between: async () => ({ state: 'none' }), received: async () => [], sent: async () => [], send: write, respond: write, withdraw: write }
  const complete = async () => ({ matches: [] })
  const service = createAccountToolService({ getBackend, complete, readPublishedSnapshot, memberConnections,
    accountForProfile: async () => f.foreign, notifications: { list: async () => [], counts: async () => ({ unseen: 0, unread: 0 }) } })
  const wrapper = { call: async args => { const run = beforeCall; beforeCall = null; await run?.(); return service.call(args) } }
  let api, mcp
  const server = createServer((req, res) => void (req.url === '/mcp' ? mcp(req, res) : api(req, res)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  api = createAccountAgentApiHandler({ origin, authenticateGrant: f.grants.authenticateGrant, authenticateGrantDetailed: f.grants.authenticateGrantDetailed, service: wrapper })
  mcp = createAccountHostedHandler({ origin, authenticateGrant: f.grants.authenticateGrant, getBackend, complete, readPublishedSnapshot, service: wrapper })
  const rest = async (token, route, input) => { const r = await fetch(`${endpoint}/api/agent/v1/${route}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }); return { status: r.status, body: await r.json() } }
  const rpc = async (token, method, params = {}) => { const r = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json() }
  const call = async (token, name, args = {}) => { const value = await rpc(token, 'tools/call', { name, arguments: args }); return value.result?.content ? JSON.parse(value.result.content[0].text) : value }
  return { ...f, mcpEndpoint: `${endpoint}/mcp`, rest, rpc, call, writes: () => writes, beforeCall: fn => { beforeCall = fn }, duringRead: fn => { duringRead = fn }, beforeSend: fn => { beforeSend = fn }, afterWrite: fn => { afterWrite = fn } }
}

for (const version of [1, 2]) for (const scope of ['owner_network', 'owner_network_and_public']) {
  test(`v${version} ${scope}: current reads, stable bytes, explicit write toggle across Settings/REST/MCP`, async t => {
    const f = await fixture(t)
    const key = await f.grants.issueGrant(f.owner, undefined, { scope, name: 'Legacy Muse' })
    const stored = f.resources.get(key.grantId); stored.payload.version = version; stored.payload.tools = [...accountGrantTools(version, scope)]
    const original = structuredClone(stored)
    const session = await f.signIn()
    const current = accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)
    assert.equal((await f.grants.ensureGrant(f.owner)).accessToken, key.accessToken)
    assert.equal((await f.grants.readKey(f.owner, key.grantId)).accessToken, key.accessToken)
    assert.deepEqual((await authenticate(f, key.accessToken)).tools, current)
    assert.deepEqual((await f.grants.listGrants(f.owner))[0].tools, current)
    assert.deepEqual((await f.rpc(key.accessToken, 'tools/list')).result.tools.map(x => x.name), current)
    assert.deepEqual((await f.rest(key.accessToken, 'whoami')).body.grant.tools, current)
    assert.deepEqual((await f.call(key.accessToken, 'unlinked_whoami')).grant.tools, current)
    assert.equal((await f.rest(key.accessToken, 'notifications')).status, 200)
    assert.equal((await f.rest(key.accessToken, 'connection-requests/accept', { id: 'synthetic' })).status, 403)
    assert.equal(f.writes(), 0)
    assert.deepEqual(f.resources.get(key.grantId), original, 'reads and Settings never rewrite historical records')
    const other = await f.grants.issueGrant(f.owner, undefined, { name: 'Other key' })
    const otherRecord = structuredClone(f.resources.get(other.grantId))
    for (const enabled of [true, false, true]) {
      assert.equal((await f.post(session, { action: 'permissions', grantId: key.grantId, ...(enabled ? { access: 'connections' } : {}) })).status, 303)
      const expectedScope = enabled ? scope === 'owner_network' ? ACCOUNT_OWNER_WRITE_SCOPE : ACCOUNT_WRITE_SCOPE : scope
      const expected = accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, expectedScope)
      const reread = await f.grants.readKey(f.owner, key.grantId)
      assert.equal(reread.accessToken, key.accessToken)
      assert.deepEqual((await f.rest(key.accessToken, 'whoami')).body.grant.tools, expected)
      assert.deepEqual((await f.rpc(key.accessToken, 'tools/list')).result.tools.map(x => x.name), expected)
      assert.equal((await f.rest(key.accessToken, 'connection-requests/accept', { id: 'synthetic' })).status, enabled ? 200 : 403)
      const mcp = await f.rpc(key.accessToken, 'tools/call', { name: 'unlinked_accept_connection_request', arguments: { id: 'synthetic' } })
      assert.equal(mcp.result.isError === true, !enabled)
      if (enabled) assert.equal(JSON.parse(mcp.result.content[0].text).status, 'accepted')
      assert.equal((await f.rest(key.accessToken, 'people')).status, scope === 'owner_network' ? 403 : 200)
      const page = await (await f.page(session, key.grantId)).text()
      assert.equal(/id="key-connection-actions"[^>]* checked/.test(page), enabled)
      assert.ok(page.includes(key.accessToken))
      assert.deepEqual(f.resources.get(other.grantId), otherRecord)
      for (const field of ['jti', 'issuedAt', 'generation']) assert.equal(f.resources.get(key.grantId).payload[field], original.payload[field])
    }
  })
}

test('permission updates require owner browser session and exact CSRF; OAuth cannot be edited', async t => {
  const f = await fixture(t), session = await f.signIn(), key = await f.grants.ensureGrant(f.owner)
  const oauth = await f.grants.issueGrant(f.owner, undefined, { connection: { kind: 'oauth', app: 'Claude', clientName: null, redirectHost: 'claude.ai', clientKey: 'a'.repeat(64), resource: null } })
  const foreign = await f.grants.issueGrant(f.foreign)
  for (const id of [oauth.grantId, foreign.grantId]) assert.equal((await f.post(session, { action: 'permissions', grantId: id, access: 'connections' })).status, 400)
  for (const extra of [{ csrf: 'wrong' }, { access: 'all' }, { ownerId: f.foreign.ownerId }]) assert.equal((await f.post(session, { action: 'permissions', grantId: key.grantId, ...extra })).status, 400)
  assert.equal((await f.post(session, { action: 'permissions', grantId: key.grantId, access: 'connections' }, { Origin: 'https://other.invalid' })).status, 403)
  const noSession = await fetch(`${f.endpoint}/settings/api-keys`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${key.accessToken}`, Origin: f.baseUrl }, body: new URLSearchParams({ csrf: session.csrf, action: 'permissions', grantId: key.grantId, access: 'connections' }) })
  assert.notEqual(noSession.status, 303)
  const duplicate = await fetch(`${f.endpoint}/settings/api-keys`, { method: 'POST', redirect: 'manual', headers: { Cookie: session.cookie, Origin: f.baseUrl }, body: new URLSearchParams([['csrf', session.csrf], ['action', 'permissions'], ['grantId', key.grantId], ['access', 'connections'], ['access', 'connections']]) })
  assert.equal(duplicate.status, 400)
  assert.ok(!(await authenticate(f, key.accessToken)).tools.includes('unlinked_send_connection_request'))
  assert.ok(!(await authenticate(f, oauth.accessToken)).tools.includes('unlinked_send_connection_request'))
})

for (const competitor of ['revoke', 'replaceKey', 'setConnectionActions']) test(`permission CAS loses safely to ${competitor}`, async t => {
  const f = await fixture(t), key = await f.grants.issueGrant(f.owner)
  let replacement
  f.beforeWrite(async () => { replacement = await f.grants[competitor](f.owner, key.grantId, false) })
  await assert.rejects(f.grants.setConnectionActions(f.owner, key.grantId, true), /cas_conflict/)
  const live = await authenticate(f, key.accessToken)
  if (competitor === 'setConnectionActions') assert.ok(live && !live.tools.includes('unlinked_send_connection_request'))
  else assert.equal(live, null)
  if (replacement?.accessToken) assert.ok(!(await authenticate(f, replacement.accessToken)).tools.includes('unlinked_send_connection_request'))
})

for (const transport of ['rest', 'mcp']) test(`${transport}: unrelated permission change permits read; removed write denies accurately; revoked/replaced read withheld`, async t => {
  const f = await fixture(t), key = await f.grants.issueGrant(f.owner, undefined, { scope: ACCOUNT_WRITE_SCOPE })
  const who = async token => transport === 'rest' ? (await f.rest(token, 'whoami')).body : f.call(token, 'unlinked_whoami')
  const accept = async () => transport === 'rest' ? (await f.rest(key.accessToken, 'connection-requests/accept', { id: 'synthetic' })).body : f.call(key.accessToken, 'unlinked_accept_connection_request', { id: 'synthetic' })
  f.duringRead(() => f.grants.setConnectionActions(f.owner, key.grantId, false))
  const read = await who(key.accessToken)
  assert.equal(read.kind, 'unlinked_whoami')
  assert.equal(read.grant.scope, 'owner_network_and_public')
  await f.grants.setConnectionActions(f.owner, key.grantId, true)
  f.beforeCall(() => f.grants.setConnectionActions(f.owner, key.grantId, false))
  assert.equal((await accept()).error.code, 'scope_not_granted'); assert.equal(f.writes(), 0)
  let replacement
  f.duringRead(async () => { replacement = await f.grants.replaceKey(f.owner, key.grantId) })
  assert.equal((await who(key.accessToken)).error.code, 'grant_revoked')
  f.duringRead(() => f.grants.revoke(f.owner, key.grantId))
  assert.equal((await who(replacement.accessToken)).error.code, 'grant_revoked')
})

test('send rechecks permission after target lookup; a write already committed still reports success', async t => {
  const f = await fixture(t), key = await f.grants.issueGrant(f.owner, undefined, { scope: ACCOUNT_WRITE_SCOPE })
  f.beforeSend(() => f.grants.setConnectionActions(f.owner, key.grantId, false))
  const denied = await f.rest(key.accessToken, 'connection-requests/send', { profileId: 'target' })
  assert.equal(denied.body.error.code, 'scope_not_granted'); assert.equal(f.writes(), 0)
  await f.grants.setConnectionActions(f.owner, key.grantId, true)
  f.afterWrite(() => f.grants.setConnectionActions(f.owner, key.grantId, false))
  assert.equal((await f.rest(key.accessToken, 'connection-requests/accept', { id: 'synthetic' })).status, 200)
  assert.equal(f.writes(), 1)
})
