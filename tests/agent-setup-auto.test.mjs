import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'

// Durable-contract fixture (CAS revisions and payload-erasing tombstones), so
// idempotent provisioning is exercised against real store semantics.
function fixture(owner) {
  const resources = new Map()
  const getBackend = async caller => {
    assert.deepEqual(caller, owner)
    return {
      readResource: async (_type, id) => { const value = resources.get(id); return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null },
      writeResource: async value => {
        assert.equal(value.sourceOwnerId, owner.ownerId)
        const prior = resources.get(value.sourceId)
        if (prior) {
          if (value.expectedRevision !== prior.sourceRevision || value.sourceRevision <= prior.sourceRevision) throw new Error('cas_conflict')
          if (prior.deleted && !value.deleted) throw new Error('tombstone_conflict')
        } else if (value.expectedRevision !== null && value.expectedRevision !== undefined) throw new Error('cas_conflict')
        const stored = { ...value }; delete stored.expectedRevision
        resources.set(value.sourceId, structuredClone(stored))
      },
      listImportIds: async () => [], listImportJobIds: async () => [],
      listAccountGrantIds: async () => [...resources.values()].filter(x => !x.deleted && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
      adapter: {},
    }
  }
  return { resources, getBackend, activeGrants: () => [...resources.values()].filter(x => !x.deleted && x.payload?.kind === 'account_tool_grant') }
}

const configFrom = html => {
  const encoded = html.match(/<textarea id="onboarding-agent-configuration"[^>]*>([\s\S]*?)<\/textarea>/)?.[1]
  return encoded ? JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) : null
}

test('agent setup is prepared automatically, idempotently, stays revoked after revocation and regenerates cleanly', async t => {
  const owner = { ownerId: 'synthetic-auto-owner', userId: 'synthetic-auto-user' }
  const f = fixture(owner)
  const auditEvents = []
  const grants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey: randomBytes(32), getBackend: f.getBackend })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'auto-subject' }) },
    resolveOwner: async () => owner, signup: async () => owner,
    getBackend: f.getBackend, complete: async () => ({ matches: [] }),
    issueAccountGrant: grants.issueGrant, ensureAccountGrant: grants.ensureGrant, revokeAccountGrant: grants.revoke,
    audit: async event => auditEvents.push(event),
    mcpEndpoint: `${baseUrl}/mcp` })
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=x`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
  const home = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
  const csrf = home.match(/name="csrf" value="([^"]+)"/)[1]
  const settings = () => fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } }).then(async r => ({ status: r.status, html: await r.text() }))
  const post = (path, input) => fetch(endpoint + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl }, body: new URLSearchParams({ csrf, ...input }) })

  // First Settings visit: setup ready without any click, exactly one grant.
  const first = await settings()
  assert.equal(first.status, 200)
  const configA = configFrom(first.html)
  assert.ok(configA, 'configuration shown automatically')
  assert.match(first.html, /Copy API key/)
  assert.match(first.html, /Copy agent setup/)
  assert.equal(f.activeGrants().length, 1)
  const tokenA = configA.mcpServers['unlinked-private'].headers.Authorization.slice(7)
  assert.ok(await grants.authenticateGrant({ headers: { authorization: `Bearer ${tokenA}` } }))

  // Second visit: same single grant, byte-identical re-derived credential.
  const second = await settings()
  assert.equal(f.activeGrants().length, 1)
  assert.deepEqual(configFrom(second.html), configA)

  // A corrupt catalog is not displayed as a usable credential or duplicated.
  const grantRecord = f.activeGrants()[0]
  grantRecord.payload.tools = [...grantRecord.payload.tools, 'unlinked_future_tool']
  const migrated = await settings()
  assert.equal(f.activeGrants().length, 1)
  assert.equal(configFrom(migrated.html), null)
  grantRecord.payload.tools = grantRecord.payload.tools.slice(0, -1)

  // Revoking the only grant sticks: Settings shows no credential and mints nothing.
  const revoked = await post('/revoke-account', { grantId: f.activeGrants()[0].sourceId })
  assert.equal(revoked.status, 303)
  const afterRevoke = await settings()
  assert.equal(f.activeGrants().length, 0, 'revocation is not undone by a page view')
  assert.equal(configFrom(afterRevoke.html), null)
  assert.match(afterRevoke.html, /No API key is prepared/)
  assert.match(afterRevoke.html, /Create API key/)
  assert.equal((await grants.authenticateGrant({ headers: { authorization: `Bearer ${tokenA}` } })), null)

  // Explicit regenerate mints exactly one new grant with a working credential.
  const regenerated = await post('/setup-account', {})
  assert.equal(regenerated.status, 200)
  const configB = configFrom(await regenerated.text())
  const tokenB = configB.mcpServers['unlinked-private'].headers.Authorization.slice(7)
  assert.notEqual(tokenB, tokenA)
  assert.equal(f.activeGrants().length, 1)
  assert.ok(await grants.authenticateGrant({ headers: { authorization: `Bearer ${tokenB}` } }))

  // Compatibility creation adds a key without invalidating an existing client.
  const again = await post('/setup-account', {})
  const configC = configFrom(await again.text())
  const tokenC = configC.mcpServers['unlinked-private'].headers.Authorization.slice(7)
  assert.equal(f.activeGrants().length, 2)
  assert.ok(await grants.authenticateGrant({ headers: { authorization: `Bearer ${tokenB}` } }))
  assert.ok(await grants.authenticateGrant({ headers: { authorization: `Bearer ${tokenC}` } }))

  // Settings keeps showing the regenerated credential and still never duplicates it.
  const final = await settings()
  assert.ok([tokenB, tokenC].includes(configFrom(final.html).mcpServers['unlinked-private'].headers.Authorization.slice(7)))
  assert.equal(f.activeGrants().length, 2)

  // Bearer secrets never reach the audit stream or durable grant records.
  const auditText = JSON.stringify(auditEvents)
  for (const secret of [tokenA, tokenB, tokenC]) {
    assert.ok(!auditText.includes(secret), 'audit log holds no bearer token')
    assert.ok(!JSON.stringify([...f.resources.values()]).includes(secret), 'durable records hold no bearer token')
  }
})

test('ensureGrant reuses a manually created grant instead of minting an automatic duplicate', async () => {
  const owner = { ownerId: 'synthetic-manual-owner', userId: 'synthetic-manual-user' }
  const f = fixture(owner)
  const grants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey: randomBytes(32), getBackend: f.getBackend })
  const manual = await grants.issueGrant(owner)
  const ensured = await grants.ensureGrant(owner)
  assert.equal(ensured.grantId, manual.grantId)
  assert.equal(ensured.accessToken, manual.accessToken, 'deterministic re-derivation of the same credential')
  assert.equal(ensured.created, false)
  assert.equal(f.activeGrants().length, 1)
  // Concurrent-looking double ensure on an empty account also converges to one grant.
  const fresh = fixture({ ownerId: 'synthetic-fresh-owner', userId: 'synthetic-fresh-user' })
  const freshGrants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey: randomBytes(32), getBackend: fresh.getBackend })
  const [a, b] = [await freshGrants.ensureGrant({ ownerId: 'synthetic-fresh-owner', userId: 'synthetic-fresh-user' }), await freshGrants.ensureGrant({ ownerId: 'synthetic-fresh-owner', userId: 'synthetic-fresh-user' })]
  assert.equal(a.accessToken, b.accessToken)
  assert.equal(fresh.activeGrants().length, 1)

  // Revoking the last manually created (pre-automation, random-jti) grant is
  // just as sticky: ensure never quietly re-enables agent access afterwards.
  await grants.revoke(owner, manual.grantId)
  assert.equal(f.activeGrants().length, 0)
  assert.equal(await grants.ensureGrant(owner), null)
  assert.equal(f.activeGrants().length, 0)
})
