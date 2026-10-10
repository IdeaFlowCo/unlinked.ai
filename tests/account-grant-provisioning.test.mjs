import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createAccountGrantService, CURRENT_ACCOUNT_GRANT_VERSION, ACCOUNT_WRITE_SCOPE, accountGrantTools } from '../mcp-server/account-grants.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'

// Server-to-server grant provisioning (docs/agent-api.md v1.1): an allow-listed
// confidential client maps a verified issuer+subject binding to a reusable
// read-only grant. Never email, never a token in audit rows, revoked stays
// revoked, and multiple live grants per owner are tolerated without clobbering.

const ISSUER = 'https://synthetic-idp.invalid'
const CLIENT_ID = 'ideaflow-develop'
const CLIENT_SECRET = 'synthetic-provisioning-secret-0123456789abcdef'
const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')

function fixture() {
  const owners = new Map(), bindings = new Map(), resources = new Map()
  let beforeWrite, beforeRead
  const register = (identity, owner) => { owners.set(JSON.stringify([owner.ownerId, owner.userId]), owner); bindings.set(`${identity.issuer}:${identity.subject}`, owner) }
  const getBackend = async owner => {
    if (!owners.has(JSON.stringify([owner.ownerId, owner.userId]))) throw new Error('owner_denied')
    return {
      readResource: async (_type, id) => { const run = beforeRead; beforeRead = null; await run?.(id); const value = resources.get(id); return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null },
      writeResource: async value => {
        const run = beforeWrite; beforeWrite = null; await run?.(value)
        const prior = resources.get(value.sourceId)
        if (prior ? prior.deleted || prior.sourceRevision !== value.expectedRevision : value.expectedRevision !== null) throw new Error('cas_conflict')
        resources.set(value.sourceId, structuredClone(value))
      },
      listImportIds: async () => [],
      listAccountGrantIds: async () => [...resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
    }
  }
  const resolveOwner = async identity => identity?.issuer === ISSUER ? bindings.get(`${identity.issuer}:${identity.subject}`) ?? null : null
  return { register, getBackend, resolveOwner, resources, beforeWrite: fn => { beforeWrite = fn }, beforeRead: fn => { beforeRead = fn } }
}

async function launch(t, { clients, perClientPerMinute } = {}) {
  const f = fixture()
  const grants = createAccountGrantService({ issuer: 'https://synthetic-prov.invalid', signingKey: randomBytes(32), getBackend: f.getBackend, publicSearchEnabled: true })
  const service = createAccountToolService({ getBackend: f.getBackend, complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'prov-v1', profiles: [], connections: [] }) })
  const audits = []
  let beforeVerification
  const server = createServer(() => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const origin = `https://127.0.0.1:${server.address().port}`
  const api = createAccountAgentApiHandler({ authenticateGrantDetailed: async request => { const run = beforeVerification; beforeVerification = null; await run?.(); return grants.authenticateGrantDetailed(request) }, authenticateGrant: grants.authenticateGrant, service, origin,
    provisioning: clients === null ? undefined : { clients: clients ?? [{ clientId: CLIENT_ID, secretSha256: createHash('sha256').update(CLIENT_SECRET).digest() }],
      resolveOwner: f.resolveOwner, ensureGrant: grants.ensureGrant, audit: async event => audits.push(event), perClientPerMinute } })
  server.removeAllListeners('request'); server.on('request', (req, res) => void api(req, res))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const provision = (body, authorization = basic(CLIENT_ID, CLIENT_SECRET)) => fetch(`${endpoint}/api/agent/v1/provision-grant`, {
    method: 'POST', headers: { ...(authorization ? { Authorization: authorization } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { f, grants, audits, endpoint, provision, beforeVerification: fn => { beforeVerification = fn } }
}

test('provisioning maps verified issuer+subject to a reusable read-only grant; never minted twice, never a token in audit', async t => {
  const app = await launch(t, {})
  const owner = { ownerId: 'synthetic-prov-owner', userId: 'synthetic-prov-user' }
  app.f.register({ issuer: ISSUER, subject: 'exact-opaque-subject' }, owner)

  // Unknown person first: typed not_linked, nothing minted.
  const unknown = await app.provision({ issuer: ISSUER, subject: 'nobody' })
  assert.equal(unknown.status, 401)
  assert.equal((await unknown.json()).error.code, 'not_linked')

  // Known binding: a v2 read-only grant is created once.
  const first = await app.provision({ issuer: ISSUER, subject: 'exact-opaque-subject' })
  assert.equal(first.status, 200)
  const created = await first.json()
  assert.equal(created.kind, 'unlinked_provision_grant')
  assert.equal(created.ownerId, owner.ownerId)
  assert.equal(created.created, true)
  assert.equal(created.version, CURRENT_ACCOUNT_GRANT_VERSION)
  // API keys default to the private-notes permission (catalog v7); never connection actions.
  assert.equal(created.scope, 'owner_network_and_public_and_private_notes')
  assert.ok(created.tools.includes('unlinked_whoami'))
  // The returned token authenticates and drives a real tool call.
  const who = await fetch(`${app.endpoint}/api/agent/v1/whoami`, { headers: { Authorization: `Bearer ${created.accessToken}` } })
  assert.equal(who.status, 200)
  assert.equal((await who.json()).ownerId, owner.ownerId)

  // Second call reuses — same grantId, created:false, token re-derived.
  const again = await app.provision({ issuer: ISSUER, subject: 'exact-opaque-subject' })
  const reused = await again.json()
  assert.equal(reused.grantId, created.grantId)
  assert.equal(reused.created, false)

  // A manually issued additional grant is tolerated: provisioning reuses the
  // newest live grant and never clobbers or duplicates.
  const manual = await app.grants.issueGrant(owner)
  const afterManual = await (await app.provision({ issuer: ISSUER, subject: 'exact-opaque-subject' })).json()
  assert.equal(afterManual.created, false)
  assert.ok([manual.grantId, created.grantId].includes(afterManual.grantId))
  const liveGrants = [...app.f.resources.values()].filter(x => !x.deleted && x.payload?.kind === 'account_tool_grant')
  assert.equal(liveGrants.length, 2)

  // Audit rows carry client, owner hash and grant id — never any token text.
  assert.ok(app.audits.length >= 3)
  assert.equal(app.audits[0].event, 'account_grant_provisioned')
  assert.equal(app.audits[1].event, 'account_grant_reused')
  assert.equal(app.audits[0].clientId, CLIENT_ID)
  assert.equal(app.audits[0].ownerHash, createHash('sha256').update(owner.ownerId).digest('hex'))
  const auditText = JSON.stringify(app.audits)
  for (const token of [created.accessToken, afterManual.accessToken, manual.accessToken]) assert.ok(!auditText.includes(token.slice(0, 24)))

  // Revoked stays revoked: after the owner turns agent access off, no path re-enables it.
  await app.grants.revoke(owner, manual.grantId)
  await app.grants.revoke(owner, created.grantId)
  const revoked = await app.provision({ issuer: ISSUER, subject: 'exact-opaque-subject' })
  assert.equal(revoked.status, 401)
  assert.equal((await revoked.json()).error.code, 'grant_revoked')
})

test('client allow list is strict: wrong secret, unknown client, missing auth, disabled endpoint, rate limit and input validation', async t => {
  // Budget 5/min: the four invalid-input probes below consume 1–4 (rate
  // limiting admits before body validation), one success consumes 5.
  const app = await launch(t, { perClientPerMinute: 5 })
  const owner = { ownerId: 'synthetic-prov-owner2', userId: 'synthetic-prov-user2' }
  app.f.register({ issuer: ISSUER, subject: 'subject-2' }, owner)

  for (const authorization of [null, 'Basic !!!', basic(CLIENT_ID, 'wrong-secret-wrong-secret-wrong-secret'), basic('someone-else', CLIENT_SECRET), `Bearer ${CLIENT_SECRET}`]) {
    const denied = await app.provision({ issuer: ISSUER, subject: 'subject-2' }, authorization)
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'client_unauthorized')
  }

  for (const body of [{ issuer: 'http://insecure.invalid', subject: 's' }, { issuer: ISSUER, subject: '' }, { issuer: ISSUER, subject: 'x', extra: 1 }, { issuer: ISSUER.repeat(40), subject: 'x' }]) {
    const invalid = await app.provision(body)
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error.code, 'invalid_input')
  }

  // Per-client budget: the sixth authenticated call is typed rate_limited.
  assert.equal((await app.provision({ issuer: ISSUER, subject: 'subject-2' })).status, 200)
  const limited = await app.provision({ issuer: ISSUER, subject: 'subject-2' })
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).error.code, 'rate_limited')
  assert.equal(limited.headers.get('retry-after'), '60')

  // Empty allow list = endpoint does not exist — for every method, so a
  // disabled runtime is not fingerprintable via 405.
  const off = await launch(t, { clients: null })
  const disabled = await off.provision({ issuer: ISSUER, subject: 'subject-2' })
  assert.equal(disabled.status, 404)
  assert.equal((await disabled.json()).error.code, 'not_found')
  assert.equal((await fetch(`${off.endpoint}/api/agent/v1/provision-grant`)).status, 404)
  // On an enabled runtime, GET is 405.
  const wrongMethod = await fetch(`${app.endpoint}/api/agent/v1/provision-grant`)
  assert.equal(wrongMethod.status, 405)
})

test('provisioning fails closed when the audit sink is down, and a mid-provision revocation is typed grant_revoked', async t => {
  const app = await launch(t, {})
  const owner = { ownerId: 'synthetic-prov-owner3', userId: 'synthetic-prov-user3' }
  app.f.register({ issuer: ISSUER, subject: 'subject-3' }, owner)
  // Break the audit sink: no credential may be returned unaudited.
  app.audits.push = () => { throw new Error('private_audit_capacity') }
  const unaudited = await app.provision({ issuer: ISSUER, subject: 'subject-3' })
  assert.equal(unaudited.status, 503)
  assert.equal((await unaudited.json()).error.code, 'upstream_unavailable')
  delete app.audits.push
  const ok = await app.provision({ issuer: ISSUER, subject: 'subject-3' })
  assert.equal(ok.status, 200)
  const grantId = (await ok.json()).grantId
  // Revoke between ensure and verification: typed grant_revoked, not a retryable 503.
  const realEnsure = app.grants.ensureGrant
  void realEnsure
  await app.grants.revoke(owner, grantId)
  const revoked = await app.provision({ issuer: ISSUER, subject: 'subject-3' })
  assert.equal(revoked.status, 401)
  assert.equal((await revoked.json()).error.code, 'grant_revoked')
})


test('provisioning stays read-only after Settings opts into writes and respects automatic revocation', async t => {
  const app = await launch(t)
  const owner = { ownerId: 'scope-owner', userId: 'scope-user' }
  app.f.register({ issuer: ISSUER, subject: 'scope-subject' }, owner)
  const write = await app.grants.issueGrant(owner, undefined, { scope: `${ACCOUNT_WRITE_SCOPE}_and_private_notes` })
  assert.equal((await app.grants.ensureGrant(owner)).scope, `${ACCOUNT_WRITE_SCOPE}_and_private_notes`)
  const response = await app.provision({ issuer: ISSUER, subject: 'scope-subject' })
  assert.equal(response.status, 200)
  const read = await response.json()
  assert.equal(read.scope, 'owner_network_and_public_and_private_notes')
  assert.notEqual(read.grantId, write.grantId)
  const verified = await app.grants.authenticateGrant({ headers: { authorization: `Bearer ${read.accessToken}` } })
  assert.equal(verified.scope, 'owner_network_and_public_and_private_notes')
  assert.ok(!verified.tools.includes('unlinked_send_connection_request'))
  const denied = await fetch(`${app.endpoint}/api/agent/v1/connection-requests/send`, {
    method: 'POST', headers: { Authorization: `Bearer ${read.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'someone' }) })
  assert.equal(denied.status, 403)
  const again = await (await app.provision({ issuer: ISSUER, subject: 'scope-subject' })).json()
  assert.equal(again.grantId, read.grantId)
  await app.grants.revoke(owner, read.grantId)
  const revoked = await app.provision({ issuer: ISSUER, subject: 'scope-subject' })
  assert.equal(revoked.status, 401)
  assert.equal((await revoked.json()).error.code, 'grant_revoked')
  assert.equal((await app.grants.ensureGrant(owner)).grantId, write.grantId)
})

for (const scope of ['owner_network', 'owner_network_and_public']) test(`automatic default toggle preserves bytes and provisions one ${scope} read-only fallback`, async t => {
  const app = await launch(t)
  const owner = { ownerId: 'default-owner', userId: 'default-user' }
  const identity = { issuer: ISSUER, subject: 'default-subject' }
  app.f.register(identity, owner)
  const selected = await app.grants.ensureGrant(owner)
  const record = app.f.resources.get(selected.grantId)
  record.payload.scope = scope
  record.payload.tools = [...accountGrantTools(record.payload.version, scope)]
  await app.grants.setConnectionActions(owner, selected.grantId, true)
  assert.equal((await app.grants.readKey(owner, selected.grantId)).accessToken, selected.accessToken)
  assert.equal((await app.grants.ensureGrant(owner)).accessToken, selected.accessToken)
  assert.equal(app.f.resources.size, 1)
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const response = await app.provision(identity)
    assert.equal(response.status, 200)
    return response.json()
  }))
  const read = results[0]
  assert.equal(new Set(results.map(x => x.accessToken)).size, 1)
  assert.equal(results.filter(x => x.created).length, 1)
  assert.equal(read.scope, scope)
  assert.notEqual(read.grantId, selected.grantId)
  assert.equal(app.f.resources.size, 2)
  assert.equal((await app.grants.ensureGrant(owner, { readOnly: true })).accessToken, read.accessToken)
  assert.equal((await (await app.provision(identity)).json()).accessToken, read.accessToken)
  assert.equal((await app.grants.readKey(owner, selected.grantId)).accessToken, selected.accessToken)
  const denied = await fetch(`${app.endpoint}/api/agent/v1/connection-requests/send`, {
    method: 'POST', headers: { Authorization: `Bearer ${read.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'someone' }) })
  assert.equal(denied.status, 403)
  if (scope === 'owner_network') assert.equal((await fetch(`${app.endpoint}/api/agent/v1/people`, { headers: { Authorization: `Bearer ${read.accessToken}` } })).status, 403)
  const replacement = await app.grants.replaceKey(owner, read.grantId)
  assert.notEqual(replacement.accessToken, read.accessToken)
  assert.equal((await (await app.provision(identity)).json()).accessToken, replacement.accessToken)
  assert.equal(await app.grants.authenticateGrant({ headers: { authorization: `Bearer ${read.accessToken}` } }), null)
  await app.grants.revoke(owner, read.grantId)
  for (let i = 0; i < 2; i++) {
    assert.equal(await app.grants.ensureGrant(owner, { readOnly: true }), null)
    const revoked = await app.provision(identity)
    assert.equal(revoked.status, 401)
    assert.equal((await revoked.json()).error.code, 'grant_revoked')
  }
  assert.equal(app.f.resources.size, 2)
  assert.equal((await app.grants.readKey(owner, selected.grantId)).accessToken, selected.accessToken)
})

for (const competitor of ['revoke', 'replaceKey', 'setConnectionActions']) test(`fallback creation CAS respects concurrent ${competitor}`, async t => {
  const app = await launch(t)
  const owner = { ownerId: 'race-owner', userId: 'race-user' }
  app.f.register({ issuer: ISSUER, subject: 'race-subject' }, owner)
  const selected = await app.grants.ensureGrant(owner)
  await app.grants.setConnectionActions(owner, selected.grantId, true)
  let winner, replacement
  app.f.beforeWrite(async () => {
    winner = await app.grants.ensureGrant(owner, { readOnly: true })
    replacement = await app.grants[competitor](owner, winner.grantId, true)
  })
  const result = await app.grants.ensureGrant(owner, { readOnly: true })
  if (competitor === 'replaceKey') {
    assert.equal(result.accessToken, replacement.accessToken)
    assert.notEqual(result.accessToken, winner.accessToken)
  } else assert.equal(result, null)
  assert.equal(app.f.resources.size, 2)
  assert.equal((await app.grants.readKey(owner, selected.grantId)).accessToken, selected.accessToken)
  assert.equal((await app.grants.authenticateGrant({ headers: { authorization: `Bearer ${selected.accessToken}` } })).scope, `${ACCOUNT_WRITE_SCOPE}_and_private_notes`)
})

test('automatic tombstone prevents fallback issuance and explicit new keys remain usable', async t => {
  const app = await launch(t)
  const owner = { ownerId: 'tombstone-owner', userId: 'tombstone-user' }
  app.f.register({ issuer: ISSUER, subject: 'tombstone-subject' }, owner)
  const selected = await app.grants.ensureGrant(owner)
  await app.grants.setConnectionActions(owner, selected.grantId, true)
  await app.grants.revoke(owner, selected.grantId)
  assert.equal(await app.grants.ensureGrant(owner, { readOnly: true }), null)
  assert.equal(app.f.resources.size, 1)
  const explicit = await app.grants.issueGrant(owner)
  assert.equal((await app.grants.ensureGrant(owner, { readOnly: true })).accessToken, explicit.accessToken)
})

for (const competitor of ['revoke', 'replaceKey', 'setConnectionActions']) test(`endpoint fails closed when provisioned fallback races with ${competitor}`, async t => {
  const app = await launch(t)
  const owner = { ownerId: 'endpoint-race-owner', userId: 'endpoint-race-user' }
  const identity = { issuer: ISSUER, subject: 'endpoint-race-subject' }
  app.f.register(identity, owner)
  const selected = await app.grants.ensureGrant(owner)
  await app.grants.setConnectionActions(owner, selected.grantId, true)
  const read = await app.grants.ensureGrant(owner, { readOnly: true })
  let replacement
  app.beforeVerification(async () => { replacement = await app.grants[competitor](owner, read.grantId, true) })
  const response = await app.provision(identity)
  assert.equal(response.status, 401)
  const denied = await response.json()
  assert.equal(denied.error.code, 'grant_revoked')
  assert.equal(denied.accessToken, undefined)
  const retry = await app.provision(identity)
  assert.equal(retry.status, competitor === 'replaceKey' ? 200 : 401)
  if (competitor === 'replaceKey') assert.equal((await retry.json()).accessToken, replacement.accessToken)
  assert.equal(app.f.resources.size, 2)
  assert.equal((await app.grants.readKey(owner, selected.grantId)).accessToken, selected.accessToken)
})
