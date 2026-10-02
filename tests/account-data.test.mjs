import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { privateId } from '../src/utils/private-import/job.mjs'

const header = 'First Name,Last Name,URL,Company,Position\n'

// Durable-contract fixture: CAS revisions, tombstones that erase payloads, and
// per-revision receipts, so export/delete are exercised against store semantics.
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
      assert.equal(value.sourceOwnerId, owner.ownerId)
      const prior = resources.get(value.sourceId)
      if (prior) {
        if (prior.sourceOwnerId !== owner.ownerId || value.expectedRevision !== prior.sourceRevision || value.sourceRevision <= prior.sourceRevision) throw new Error('cas_conflict')
        if (prior.deleted && !value.deleted) throw new Error('tombstone_conflict')
      } else if (value.expectedRevision !== null && value.expectedRevision !== undefined) throw new Error('cas_conflict')
      const stored = { ...value }; delete stored.expectedRevision
      resources.set(value.sourceId, structuredClone(stored))
    }
    const writeBatch = async items => {
      assert.ok(items.length >= 1 && items.length <= 600)
      for (const item of items) { assert.equal(item.deleted, true); assert.equal(item.payload, null); await writeResource(item) }
    }
    const save = (id, job) => {
      resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, deleted: false, payload: structuredClone(job) })
      const receiptId = privateId(owner.ownerId, 'receipt', job.id, job.revision)
      resources.set(receiptId, { type: 'import', sourceId: receiptId, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { ...structuredClone(job), receiptOf: job.id } })
    }
    return { readResource, writeResource, writeBatch,
      listImportIds: async () => own().filter(x => x.type === 'import' && x.payload?.id === x.sourceId && !x.payload?.kind && !x.payload?.receiptOf && ['indexed', 'partial'].includes(x.payload.status)).map(x => x.sourceId).sort(),
      listAccountGrantIds: async () => own().filter(x => x.type === 'import' && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
      adapter: { withImport: async (caller, id, work) => {
        assert.equal(caller, owner.ownerId)
        return work({ getJob: async () => (await readResource('import', id))?.payload,
          putAsset: async (hash, bytes) => assets.set(`${owner.ownerId}/${hash}`, Buffer.from(bytes)),
          publicationStatus: 'indexed',
          saveJob: async job => save(id, job),
          publish: async (job, assertions) => {
            job.assertionIds = assertions.map(x => x.id)
            for (const row of assertions) resources.set(row.id, { type: 'assertion', sourceId: row.id, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: structuredClone(row) })
            for (const source of job.sources) resources.set(source.id, { type: 'source', sourceId: source.id, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { ...structuredClone(source), importId: job.id } })
            save(id, job)
          },
        })
      } },
    }
  }
  return { register, getBackend, resources, assets }
}

test('export downloads the whole account and type-to-confirm deletion erases every owner resource and session', async t => {
  const f = fixture(), bindings = new Map(), owner = { ownerId: 'synthetic-data-owner', userId: 'synthetic-data-user' }
  const grants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey: randomBytes(32), getBackend: f.getBackend })
  let legacyRevoked = 0, assetsRemoved = []
  const complete = async () => ({ matches: [] })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'exact-opaque-subject', clientId: 'synthetic-client', verifiedAt: Math.floor(Date.now() / 1000), provenanceReceiptId: 'synthetic-callback-proof' }) },
    resolveOwner: async identity => bindings.get(`${identity.issuer}:${identity.subject}`),
    signup: async identity => { bindings.set(`${identity.issuer}:${identity.subject}`, owner); f.register(owner); return owner },
    getBackend: f.getBackend, complete, issueAccountGrant: grants.issueGrant, revokeAccountGrant: grants.revoke,
    revokeLegacyLink: async value => { assert.equal(value.ownerId, owner.ownerId); legacyRevoked++ },
    removeOwnerAssets: async ownerId => { assetsRemoved.push(ownerId) },
    mcpEndpoint: `${baseUrl}/mcp` })
  const signIn = async () => {
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=synthetic`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    assert.equal(callback.status, 303)
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
    return { cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1], page }
  }
  const signed = await signIn()

  // The one search box submits as a plain GET form with a soft-keyboard search action.
  const landing = await (await fetch(`${endpoint}/logout-not-a-route`, {})).text()
  assert.match(landing, /<form class="header-search" method="get" action="\/network" role="search">/)
  assert.match(landing, /enterkeyhint="search"/)

  const csv = header + 'Ada,Lovelace,https://www.linkedin.com/in/synthetic-ada,Analytical,Engineer\nGrace,Hopper,https://www.linkedin.com/in/synthetic-grace,Navy,Rear Admiral\nEdsger,Dijkstra,https://www.linkedin.com/in/synthetic-edsger,THE,Professor\n'
  const form = new FormData(); form.set('csrf', signed.csrf); form.set('syntheticConsent', 'yes'); form.set('archive', new Blob([csv]), 'Connections.csv')
  const uploaded = await fetch(`${endpoint}/upload`, { method: 'POST', redirect: 'manual', headers: { Cookie: signed.cookie, Origin: baseUrl }, body: form })
  assert.equal(uploaded.status, 303)
  const setup = await fetch(`${endpoint}/setup-account`, { method: 'POST', headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(signed.csrf)}` })
  assert.equal(setup.status, 200)

  // Export: one JSON attachment with the profile observations and grant ids.
  const exported = await fetch(`${endpoint}/export`, { headers: { Cookie: signed.cookie } })
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition'), /^attachment; filename="unlinked-export-\d{4}-\d{2}-\d{2}\.json"$/)
  const data = JSON.parse(await exported.text())
  assert.equal(data.format, 'unlinked-account-export')
  assert.equal(data.account.ownerId, owner.ownerId)
  assert.equal(data.imports.length, 1)
  assert.equal(data.imports[0].observations.length, 3)
  assert.deepEqual(data.imports[0].observations.map(row => row.fields['first name']).sort(), ['Ada', 'Edsger', 'Grace'])
  assert.equal(data.agentGrantIds.length, 1)

  // Settings offers both actions; a wrong confirmation deletes nothing.
  const settings = await (await fetch(`${endpoint}/settings`, { headers: { Cookie: signed.cookie } })).text()
  assert.match(settings, /action="\/export"/)
  assert.match(settings, /action="\/delete-account"/)
  const refused = await fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(signed.csrf)}&confirm=${encodeURIComponent('delete')}` })
  assert.equal(refused.status, 400)
  assert.match(await refused.text(), /Nothing was deleted/)
  assert.ok([...f.resources.values()].some(x => x.sourceOwnerId === owner.ownerId && !x.deleted && x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf))

  // The confirmed deletion tombstones every resource, including receipts,
  // sources, assertions and the agent grant, and ends every session.
  const deleted = await fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(signed.csrf)}&confirm=${encodeURIComponent('Delete Everything ')}` })
  assert.equal(deleted.status, 200)
  assert.match(await deleted.text(), /Your data is deleted/)
  const remaining = [...f.resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted)
  assert.deepEqual(remaining, [])
  for (const value of f.resources.values()) if (value.sourceOwnerId === owner.ownerId) assert.equal(value.payload, null)
  assert.equal(legacyRevoked, 1)
  assert.deepEqual(assetsRemoved, [owner.ownerId])

  // The old cookie is dead and the account pages demand a fresh sign-in.
  const after = await fetch(`${endpoint}/settings`, { headers: { Cookie: signed.cookie } })
  assert.equal(after.status, 401)
  const exportAfter = await fetch(`${endpoint}/export`, { headers: { Cookie: signed.cookie } })
  assert.equal(exportAfter.status, 401)
})
