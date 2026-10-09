import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { renderSettings } from '../mcp-server/private-onboarding-views.mjs'
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

for (const explicitSelection of [false, true]) {
  test(`Settings hides a key revoked between credential read and grant list (${explicitSelection ? 'selected' : 'default'})`, async t => {
    const f = await manualKeyFixture(); t.after(f.close)
    const session = await f.signIn()
    const a = await f.grants.ensureGrant(f.owner)
    const issuedB = await f.grants.issueGrant(f.owner, undefined, { name: 'Independent B' })
    f.resources.get(issuedB.grantId).payload.issuedAt = f.resources.get(a.grantId).payload.issuedAt - 1
    const b = await f.grants.readKey(f.owner, issuedB.grantId)
    assert.equal((await f.grants.ensureGrant(f.owner)).grantId, a.grantId)
    assert.equal(tokenFrom(await (await f.page(session, explicitSelection ? a.grantId : undefined)).text()), a.accessToken)
    const bBefore = structuredClone(f.resources.get(b.grantId))
    let interleaved = false
    f.beforeGrantList(async () => {
      assert.ok(await auth(f.grants, a.accessToken))
      await f.grants.revoke(f.owner, a.grantId)
      interleaved = true
    })
    const response = await f.page(session, explicitSelection ? a.grantId : undefined)
    assert.equal(response.status, 200)
    const page = await response.text()
    assert.equal(interleaved, true)
    assert.match(page, /This API key is no longer available/)
    assert.match(page, /href="\/settings#api-keys">Refresh API keys/)
    assert.match(page, /Independent B/)
    assert.equal(tokenFrom(page), undefined)
    for (const forbidden of [a.accessToken, b.accessToken, 'id="onboarding-agent-configuration"', 'Access:', 'This key uses an earlier tool set', 'Your private credential has connection actions enabled.', 'name="grantId"', 'aria-current="true"']) {
      assert.ok(!page.includes(forbidden), `unavailable selection must omit ${forbidden === a.accessToken || forbidden === b.accessToken ? 'credential' : forbidden}`)
    }
    assert.equal(await auth(f.grants, a.accessToken), null)
    assert.ok(await auth(f.grants, b.accessToken))
    assert.deepEqual(f.resources.get(b.grantId), bBefore)
    assert.equal(tokenFrom(await (await f.page(session, b.grantId)).text()), b.accessToken)
    assert.deepEqual(f.resources.get(b.grantId), bBefore)
  })
}

test('Settings legacy callers without a selected key retain prepared setup and management', () => {
  const view = renderSettings({ csrf: 'synthetic-csrf', grants: [{ id: 'legacy-key', name: 'Legacy key' }], agentConfiguration: { synthetic: 'legacy-configuration' } })
  assert.match(view.content, /legacy-configuration/)
  assert.match(view.content, /Copy agent setup/)
  assert.match(view.content, /name="grantId" value="legacy-key"/)
  assert.doesNotMatch(view.content, /This API key is no longer available/)
})

test('unavailable explicit selection suppresses setup and all selected-key scope notices', () => {
  for (const grants of [[], [{ id: 'key-b', name: 'Key B' }]]) {
    const page = renderSettings({ csrf: 'synthetic-csrf', selectedKeyId: 'key-a', keyManagement: true, grants,
      agentConfiguration: { secret: 'synthetic-stale-token' }, agentSetups: { accessToken: 'synthetic-stale-token' },
      agentAccess: { scope: 'owner_network_and_public_and_write', missingTools: ['unlinked_search_network'] },
    }).content
    assert.match(page, /This API key is no longer available/)
    for (const forbidden of ['synthetic-stale-token', 'Access:', 'earlier tool set', 'connection actions enabled', 'name="grantId"', 'Copy API key', 'Copy agent setup']) assert.ok(!page.includes(forbidden))
  }
})
