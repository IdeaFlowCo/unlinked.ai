import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createAccountGrantService, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
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
  const register = (identity, owner) => { owners.set(JSON.stringify([owner.ownerId, owner.userId]), owner); bindings.set(`${identity.issuer}:${identity.subject}`, owner) }
  const getBackend = async owner => {
    if (!owners.has(JSON.stringify([owner.ownerId, owner.userId]))) throw new Error('owner_denied')
    return {
      readResource: async (_type, id) => { const value = resources.get(id); return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null },
      writeResource: async value => { resources.set(value.sourceId, structuredClone(value)) },
      listImportIds: async () => [],
      listAccountGrantIds: async () => [...resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
    }
  }
  const resolveOwner = async identity => identity?.issuer === ISSUER ? bindings.get(`${identity.issuer}:${identity.subject}`) ?? null : null
  return { register, getBackend, resolveOwner, resources }
}

async function launch(t, { clients, perClientPerMinute } = {}) {
  const f = fixture()
  const grants = createAccountGrantService({ issuer: 'https://synthetic-prov.invalid', signingKey: randomBytes(32), getBackend: f.getBackend, publicSearchEnabled: true })
  const service = createAccountToolService({ getBackend: f.getBackend, complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'prov-v1', profiles: [], connections: [] }) })
  const audits = []
  const server = createServer(() => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const origin = `https://127.0.0.1:${server.address().port}`
  const api = createAccountAgentApiHandler({ authenticateGrantDetailed: grants.authenticateGrantDetailed, authenticateGrant: grants.authenticateGrant, service, origin,
    provisioning: clients === null ? undefined : { clients: clients ?? [{ clientId: CLIENT_ID, secretSha256: createHash('sha256').update(CLIENT_SECRET).digest() }],
      resolveOwner: f.resolveOwner, ensureGrant: grants.ensureGrant, audit: async event => audits.push(event), perClientPerMinute } })
  server.removeAllListeners('request'); server.on('request', (req, res) => void api(req, res))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const provision = (body, authorization = basic(CLIENT_ID, CLIENT_SECRET)) => fetch(`${endpoint}/api/agent/v1/provision-grant`, {
    method: 'POST', headers: { ...(authorization ? { Authorization: authorization } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { f, grants, audits, endpoint, provision }
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
  assert.equal(created.scope, 'owner_network_and_public')
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

  // Empty allow list = endpoint does not exist.
  const off = await launch(t, { clients: null })
  const disabled = await off.provision({ issuer: ISSUER, subject: 'subject-2' })
  assert.equal(disabled.status, 404)
  assert.equal((await disabled.json()).error.code, 'not_found')
  // GET is not a thing either.
  const wrongMethod = await fetch(`${app.endpoint}/api/agent/v1/provision-grant`)
  assert.equal(wrongMethod.status, 405)
})
