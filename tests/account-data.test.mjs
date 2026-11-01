import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'
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
  let handler, uploadStarted
  const uploading = new Promise(resolve => { uploadStarted = resolve })
  const server = createServer((req, res) => { if (req.headers['x-stalled-upload']) uploadStarted(); void handler(req, res) })
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
  assert.match(settings, /<h2 id="delete-account">Delete account<\/h2>/)
  assert.doesNotMatch(settings.split('<h2 id="delete-account">')[1].split('<h2')[0], /<details\b/)
  assert.match(settings, /href="https:\/\/id\.ideaflow\.app\/account\/delete\?return_to=https:\/\/www\.unlinked\.ai"/)
  assert.match(settings, /Permanently delete my Unlinked account/)
  const refused = await fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(signed.csrf)}&confirm=${encodeURIComponent('delete')}` })
  assert.equal(refused.status, 400)
  assert.match(await refused.text(), /Nothing was deleted/)
  assert.ok([...f.resources.values()].some(x => x.sourceOwnerId === owner.ownerId && !x.deleted && x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf))

  // The confirmed deletion tombstones every resource, including receipts,
  // sources, assertions and the agent grant, and ends every session.
  const boundary = 'synthetic-boundary'
  const uploadBody = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${signed.csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="syntheticConsent"\r\n\r\nyes\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="Connections.csv"\r\nContent-Type: text/csv\r\n\r\n${header}New,Contact,https://www.linkedin.com/in/new-contact,Example,Engineer\n\r\n--${boundary}--\r\n`)
  const pausedUpload = httpRequest(`${endpoint}/upload`, { method: 'POST', headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': uploadBody.length, 'X-Stalled-Upload': '1' } })
  const uploadResult = new Promise((resolve, reject) => { pausedUpload.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)) }); pausedUpload.on('error', reject) })
  const half = Math.floor(uploadBody.length / 2)
  pausedUpload.write(uploadBody.subarray(0, half))
  await uploading
  const deleted = await fetch(`${endpoint}/delete-account`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { Cookie: signed.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(signed.csrf)}&confirm=${encodeURIComponent('Delete Account ')}` })
  assert.equal(deleted.status, 200)
  assert.match(await deleted.text(), /Your Unlinked account is deleted/)
  pausedUpload.end(uploadBody.subarray(half))
  assert.equal(await uploadResult, 401)
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

for (const failedStep of ['legacy', 'assets', 'sessions', 'handle-lookup', 'handle-removal', 'home-preference', 'visibility-choice']) {
  test(`account deletion retries after ${failedStep} cleanup fails`, async t => {
    const f = fixture(), owner = { ownerId: 'retry-owner', userId: 'retry-user' }, bindings = new Map()
    const grants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey: randomBytes(32), getBackend: f.getBackend })
    const store = createMemorySessionStore(), deleteOwner = store.deleteOwner.bind(store)
    let fail = true, identityPresent = true, handlePresent = true, pauseRead = false, releaseRead, readStarted
    const readPending = new Promise(resolve => { readStarted = resolve })
    const readRelease = new Promise(resolve => { releaseRead = resolve })
    const get = store.get.bind(store)
    store.get = async (...args) => {
      const record = await get(...args)
      if (pauseRead) { pauseRead = false; readStarted(); await readRelease }
      return record
    }
    store.deleteOwner = async id => { if (failedStep === 'sessions' && fail) throw new Error('storage unavailable'); await deleteOwner(id) }
    let handlers, stalledArrived
    const stalled = new Promise(resolve => { stalledArrived = resolve })
    const server = createServer((req, res) => { if (req.headers['x-stall']) stalledArrived(); void handlers[req.headers['x-worker'] === 'second' ? 1 : 0](req, res) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
    const options = { baseUrl, dataMode: 'synthetic', sessionStore: store,
      login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'retry-state' } }),
        finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'retry-subject', clientId: 'synthetic-client', verifiedAt: Math.floor(Date.now() / 1000), provenanceReceiptId: 'retry-proof' }) },
      resolveOwner: async identity => bindings.get(`${identity.issuer}:${identity.subject}`),
      signup: async identity => { bindings.set(`${identity.issuer}:${identity.subject}`, owner); f.register(owner); return owner },
      getBackend: f.getBackend, complete: async () => ({ matches: [] }), issueAccountGrant: grants.issueGrant, revokeAccountGrant: grants.revoke,
      handleBackfillMs: 0,
      profileHandles: { resolve: () => null, handleFor: () => null, ensure: async () => {}, availability: () => ({}), rename: async () => {},
        removeProfile: async id => { assert.equal(id, 'profile-id'); if (failedStep === 'handle-removal' && fail) throw new Error('handle unavailable'); handlePresent = false } },
      ownProfileId: async () => { if (failedStep === 'handle-lookup' && fail) throw new Error('profile unavailable'); return identityPresent ? 'profile-id' : null },
      signupLookup: { read: async () => null, removeOwner: async () => { identityPresent = false } },
      homePreferences: { get: async () => null, set: async () => {}, removeOwner: async () => { if (failedStep === 'home-preference' && fail) throw new Error('unavailable') } },
      ideaflowProfiles: { choices: { removeOwner: async () => { if (failedStep === 'visibility-choice' && fail) throw new Error('unavailable') } } },
      createMessagingSession: async () => ({ token: 'fixture-token', user: { userId: 'fixture-user' } }),
      messagingOptions: { apiOrigin: 'https://chat.example.invalid', heartbeatMs: 20, lingerMs: 10,
        fetchImpl: async () => new Response('{}', { status: 200 }),
        connectSocket: async () => ({ open: true, emit() {}, close() {} }) },
      revokeLegacyLink: async () => { if (failedStep === 'legacy' && fail) throw new Error('legacy unavailable') },
      removeOwnerAssets: async () => { if (failedStep === 'assets' && fail) throw new Error('assets unavailable') },
      mcpEndpoint: `${baseUrl}/mcp` }
    handlers = [createPrivateBrowserHandler(options), createPrivateBrowserHandler(options)]
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=retry-state&code=synthetic`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    assert.equal(callback.status, 303)
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).text()
    assert.equal((await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie, 'X-Worker': 'second' } })).status, 200)
    const stream = failedStep === 'sessions' ? await fetch(`${endpoint}/messages/api/stream`, { headers: { Cookie: cookie, 'X-Worker': 'second' } }) : null
    const streamReader = stream?.body.getReader()
    if (streamReader) { assert.equal(stream.status, 200); await streamReader.read() }
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
    if (failedStep === 'sessions') {
      const other = { ownerId: 'other-owner', userId: 'other-user' }, otherSid = 'other-session'
      f.register(other)
      await store.put(createHash('sha256').update(otherSid).digest('hex'), { ...other, csrf: 'other-csrf', expiresAt: Date.now() + 60000 })
      const incomplete = httpRequest(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Length': '1000', 'X-Stall': '1' } })
      incomplete.on('error', () => {})
      incomplete.write('csrf=')
      await stalled
      assert.equal((await fetch(`${endpoint}/settings`, { headers: { Cookie: `__Host-ul-session=${otherSid}` }, signal: AbortSignal.timeout(2000) })).status, 200)
      incomplete.destroy()
    }
    const remove = () => fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, confirm: 'delete everything' }) })
    const failed = await remove()
    assert.notEqual(failed.status, 200)
    assert.doesNotMatch(await failed.text(), /Your Unlinked account is deleted/)
    assert.equal((await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).status, 200)
    if (failedStep.startsWith('handle-')) { assert.equal(identityPresent, true); assert.equal(handlePresent, true) }
    pauseRead = true
    const pending = fetch(`${endpoint}/settings`, { headers: { Cookie: cookie, 'X-Worker': 'second' } })
    await readPending
    fail = false
    let deletionStarted = false
    const retry = remove().then(response => { deletionStarted = true; return response })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(deletionStarted, false)
    releaseRead()
    assert.ok([200, 401].includes((await pending).status))
    const retried = await retry
    assert.equal(retried.status, 200)
    assert.match(await retried.text(), /Your Unlinked account is deleted/)
    if (streamReader) {
      let chunk
      do { chunk = await streamReader.read() } while (!chunk.done)
    }
    assert.equal(handlePresent, false)
    assert.equal((await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).status, 401)
    assert.equal((await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie, 'X-Worker': 'second' } })).status, 401)
  })
}
