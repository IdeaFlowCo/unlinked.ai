import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { manualKeyFixture } from './helpers/manual-key-fixture.mjs'
const auth = (service, token) => service.authenticateGrant({ headers: { authorization: `Bearer ${token}` } })
const tokenFrom = page => page.match(/id="agent-setup-token"[^>]*value="([^"]+)"/)?.[1]

test('signed-in named keys: revisit, fresh sign-in, rename, replace and revoke preserve other clients', async t => {
  const f = await manualKeyFixture(); t.after(f.close)
  const session = await f.signIn(), initial = await (await f.page(session)).text()
  const defaultToken = tokenFrom(initial), defaultGrant = await auth(f.grants, defaultToken)
  assert.ok(defaultGrant)
  const oauth = await f.grants.issueGrant(f.owner, undefined, { connection: { kind: 'oauth', app: 'Claude', clientName: null, redirectHost: 'claude.ai', clientKey: 'a'.repeat(64), resource: null } })
  const created = await f.post(session, { action: 'create', name: 'Muse' }); assert.equal(created.status, 303)
  const id = new URL(created.headers.get('location'), f.baseUrl).searchParams.get('key')
  const token = tokenFrom(await (await f.page(session, id)).text())
  assert.ok(await auth(f.grants, token))
  assert.equal((await f.grants.listGrants(f.owner)).length, 3)
  const again = await f.signIn()
  assert.equal(tokenFrom(await (await f.page(again, id)).text()), token)
  const restarted = createAccountGrantService(f.options)
  assert.equal((await restarted.readKey(f.owner, id)).accessToken, token)
  assert.equal((await f.post(again, { action: 'rename', grantId: id, name: 'Muse personal' })).status, 303)
  assert.equal((await restarted.readKey(f.owner, id)).accessToken, token)
  assert.equal((await restarted.listGrants(f.owner)).find(row => row.id === id).name, 'Muse personal')
  assert.equal((await f.post(again, { action: 'replace', grantId: id })).status, 303)
  const replacement = tokenFrom(await (await f.page(again, id)).text())
  assert.notEqual(replacement, token); assert.equal(await auth(restarted, token), null)
  assert.ok(await auth(restarted, replacement))
  assert.equal((await auth(restarted, replacement)).scope, (await restarted.readKey(f.owner, id)).scope)
  assert.ok(await auth(restarted, defaultToken)); assert.ok(await auth(restarted, oauth.accessToken))
  assert.equal((await f.post(again, { action: 'revoke', grantId: id })).status, 303)
  assert.equal(await auth(restarted, replacement), null)
  assert.ok(await auth(restarted, defaultToken)); assert.ok(await auth(restarted, oauth.accessToken))
  await f.page(again); assert.equal((await f.grants.listGrants(f.owner)).length, 2)
  await f.grants.revoke(f.owner, defaultGrant.grantId)
  await f.page(again); assert.equal((await f.grants.listGrants(f.owner)).length, 1, 'OAuth does not cause automatic key resurrection')
  for (const secret of [defaultToken, token, replacement, oauth.accessToken]) {
    assert.ok(!JSON.stringify(f.audits).includes(secret)); assert.ok(!JSON.stringify([...f.resources.values()]).includes(secret))
  }
})

test('key management requires browser session, exact CSRF and owner; validates names and excludes OAuth', async t => {
  const f = await manualKeyFixture(); t.after(f.close)
  const session = await f.signIn(), own = await f.grants.ensureGrant(f.owner)
  const foreign = await f.grants.issueGrant(f.foreign, undefined, { name: 'Foreign' })
  const oauth = await f.grants.issueGrant(f.owner, undefined, { connection: { kind: 'oauth', app: 'ChatGPT', clientName: null, redirectHost: 'chatgpt.com', clientKey: 'b'.repeat(64), resource: null } })
  for (const grantId of [foreign.grantId, oauth.grantId]) {
    for (const action of ['rename', 'replace', 'revoke']) assert.equal((await f.post(session, { action, grantId, ...(action === 'rename' ? { name: 'No' } : {}) })).status, 400)
    assert.equal((await f.page(session, grantId)).status, 400)
  }
  for (const name of ['', ' ', 'x'.repeat(81), 'bad\nname']) assert.equal((await f.post(session, { action: 'create', name })).status, 400)
  for (const input of [{ action: 'create', name: 'X', csrf: 'bad' }, { action: 'create', name: 'X', surprise: 'x' }, { action: 'create', name: 'X', access: 'connections' }]) assert.equal((await f.post(session, input)).status, 400)
  assert.equal((await f.post(session, { action: 'create', name: 'X' }, { Origin: 'https://foreign.invalid' })).status, 403)
  const agent = await fetch(`${f.endpoint}/settings/api-keys`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${own.accessToken}`, Origin: f.baseUrl }, body: new URLSearchParams({ action: 'create', name: 'No', csrf: session.csrf }) })
  assert.notEqual(agent.status, 200); assert.notEqual(agent.headers.get('location')?.includes('?key='), true)
  assert.equal((await f.grants.listGrants(f.owner)).length, 2)
  assert.ok(await auth(f.grants, foreign.accessToken)); assert.ok(await auth(f.grants, oauth.accessToken))
})

test('replacement is atomic, keeps legacy catalog, and loses safely to concurrent revoke', async t => {
  const f = await manualKeyFixture(); t.after(f.close)
  const key = await f.grants.issueGrant(f.owner, undefined, { name: 'Legacy', scope: 'owner_network' })
  const row = f.resources.get(key.grantId)
  row.payload.version = 1; row.payload.tools = ['unlinked_search_network']
  const prior = await f.grants.readKey(f.owner, key.grantId)
  f.failWrites(true)
  await assert.rejects(f.grants.replaceKey(f.owner, key.grantId), /synthetic_write_failure/)
  f.failWrites(false); assert.ok(await auth(f.grants, prior.accessToken))
  const next = await f.grants.replaceKey(f.owner, key.grantId)
  assert.equal(next.version, 1); assert.deepEqual(next.tools, ['unlinked_search_network'])
  assert.equal(await auth(f.grants, prior.accessToken), null)
  f.beforeWrite(() => f.grants.revoke(f.owner, key.grantId))
  await assert.rejects(f.grants.replaceKey(f.owner, key.grantId), /cas_conflict/)
  assert.equal(await auth(f.grants, next.accessToken), null)
  assert.equal(await f.grants.ensureGrant(f.owner), null)
})
