import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import JSZip from 'jszip'
import { stageArchive, runArchiveJob, createArchiveWorker, importJobStatus } from '../src/utils/private-import/background-job.mjs'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createNoosOwnerBackend, createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { readOwnerProfileRows, profileFromRows } from '../src/utils/private-import/owner-profile.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

// Real private filesystem persistence exercises the production adapter's batch,
// replay and asset paths. This is not a substitute for the Noos graph CI job.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'unlinked-background-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'resources.json'); await writeFile(file, '{}', { mode: 0o600 })
  let tail = Promise.resolve(), hook = async () => {}
  const snapshot = async () => JSON.parse(await readFile(file, 'utf8'))
  const batch = items => {
    const next = tail.catch(() => {}).then(async () => {
      const resources = await snapshot()
      for (const item of items) {
        const key = item.type + '/' + item.sourceId, prior = resources[key]
        const resource = { sourceId: item.sourceId, sourceOwnerId: item.sourceOwnerId, sourceRevision: item.sourceRevision, deleted: item.deleted, audience: item.audience, payload: item.payload }
        if (prior?.deleted) throw new Error('tombstone_conflict')
        if (prior && JSON.stringify(prior) === JSON.stringify(resource)) continue
        if ((prior?.sourceRevision ?? null) !== item.expectedRevision || item.sourceRevision !== (prior?.sourceRevision ?? 0) + 1) throw new Error('revision_conflict')
        resources[key] = resource
      }
      await writeFile(file + '.tmp', JSON.stringify(resources), { mode: 0o600 }); await rename(file + '.tmp', file)
    })
    tail = next; return next
  }
  const backend = ownerId => createNoosOwnerBackend({ baseUrl: 'http://127.0.0.1:9827/v1', accessToken: 'synthetic-' + ownerId, ownerId,
    fetchImpl: async (url, options = {}) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-' + ownerId)
      const path = new URL(url).pathname.split('/unlinked/')[1]
      if (path.startsWith('assets/')) {
        const [, owner, sha] = path.split('/'); if (owner !== ownerId) return new Response('', { status: 404 })
        const dir = join(root, owner); await mkdir(dir, { mode: 0o700, recursive: true })
        const target = join(dir, sha)
        if (options.method === 'PUT') {
          try { await writeFile(target, options.body, { mode: 0o600, flag: 'wx' }) }
          catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(await readFile(target), options.body) }
          return Response.json({ retained: true })
        }
        try { return new Response(await readFile(target)) } catch { return new Response('', { status: 404 }) }
      }
      if (path === 'batch') {
        const items = JSON.parse(options.body)
        assert.ok(items.every(item => item.sourceOwnerId === ownerId))
        await hook('before', items)
        await batch(items)
        await hook('after', items)
        return Response.json({ committed: true })
      }
      const resource = (await snapshot())[path]
      return resource?.sourceOwnerId === ownerId ? Response.json(resource) : new Response('', { status: 404 })
    } })
  return { root, snapshot, batch, backend, setHook: value => { hook = value } }
}

async function fullArchive(count = 1001) {
  const zip = new JSZip()
  // Connections intentionally precede Profile in the original ZIP.
  zip.file('Connections.csv', 'First Name,Last Name,URL,Company,Position\n' + Array.from({ length: count }, (_, i) => `Person${i},Synthetic,https://www.linkedin.com/in/synthetic-${i},Synthetic Co,Engineer\n`).join(''))
  zip.file('Profile.csv', 'First Name,Last Name,Headline\nOwn,Synthetic,Graph engineer\n')
  zip.file('Skills.csv', 'Name\nGraph systems\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function richProfileArchive(count = 401) {
  const zip = new JSZip()
  zip.file('Connections.csv', 'First Name,Last Name,URL,Company,Position\n' + Array.from({ length: count }, (_, i) => `Person${i},Synthetic,https://www.linkedin.com/in/rich-${i},Synthetic Co,Engineer\n`).join(''))
  zip.file('Profile.csv', 'First Name,Last Name,Headline\nOwn,Synthetic,Graph engineer\n')
  zip.file('Positions.csv', 'Company Name,Title,Started On,Finished On,Description\nSynthetic Labs,Principal Engineer,2020,,Built durable import systems\n')
  zip.file('Education.csv', 'School Name,Degree Name,Start Date,End Date\nGraph University,MS Systems,2012,2014\n')
  zip.file('Skills.csv', 'Name\nGraph systems\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function namedProfileArchive(first, last, headline, count = 5) {
  const zip = new JSZip()
  zip.file('Connections.csv', 'First Name,Last Name,URL,Company,Position\n' + Array.from({ length: count }, (_, i) => `Contact${i},${last},https://www.linkedin.com/in/${first.toLowerCase()}-${i},Example Co,Engineer\n`).join(''))
  zip.file('Profile.csv', `First Name,Last Name,Headline\n${first},${last},${headline}\n`)
  zip.file('Skills.csv', 'Name\nShared systems\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

test('stage returns durable uploaded receipt; crash after profile before connections resumes all 1,003 once', async t => {
  const f = await fixture(t), ownerId = 'owner-a', backend = f.backend(ownerId), bytes = await fullArchive()
  const request = { ownerId, filename: 'full.zip', bytes, adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT, now: () => 1000 }
  const staged = await stageArchive(request)
  assert.equal(staged.status, 'uploaded'); assert.equal(staged.counts.indexed, 0)
  assert.deepEqual(await backend.readAsset(staged.archiveSha256), bytes)
  assert.equal((await stageArchive(request)).id, staged.id)
  let earlyProfile, crashed = false
  f.setHook(async (phase, items) => {
    const progress = items.find(item => item.sourceId === staged.id)?.payload
    if (phase === 'after' && progress?.status === 'indexing' && progress.progress.processed === 2 && !crashed) {
      crashed = true
      assert.equal(progress.counts.indexed, 0)
      const resources = await f.snapshot()
      earlyProfile = profileFromRows(await readOwnerProfileRows({ ownerId, jobs: [resources['import/' + staged.id]], backend }))
      const read = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId, importIds: [staged.id] } })
      await assert.rejects(read(staged.id), /private_import_not_found/)
      throw new Error('lost_progress_response_and_process_exit')
    }
  })
  await assert.rejects(runArchiveJob({ ownerId, id: staged.id, adapter: backend.adapter, readAsset: backend.readAsset, now: () => 1000 }), /lost_progress_response/)
  assert.equal(earlyProfile.name, 'Own Synthetic'); assert.deepEqual(earlyProfile.skills, ['Graph systems'])
  const reopened = f.backend(ownerId)
  f.setHook(async () => {})
  const beforeExpiry = await runArchiveJob({ ownerId, id: staged.id, adapter: reopened.adapter, readAsset: reopened.readAsset, now: () => 1001 })
  assert.equal(beforeExpiry.status, 'indexing'); assert.equal(beforeExpiry.progress.processed, 2)
  const completed = await runArchiveJob({ ownerId, id: staged.id, adapter: reopened.adapter, readAsset: reopened.readAsset, now: () => 181001 })
  assert.equal(completed.status, 'indexed'); assert.equal(completed.counts.accepted, 1003); assert.equal(completed.counts.indexed, 1003)
  const reader = createScopedImportReader({ readResource: reopened.readResource, readAsset: reopened.readAsset, grant: { ownerId, importIds: [staged.id] } })
  const result = await reader(staged.id)
  assert.equal(result.assertions.length, 1003)
  assert.equal(result.assertions.filter(row => row.category === 'connections').length, 1001)
  assert.equal((await stageArchive(request)).id, staged.id)
  assert.equal(Object.keys(await f.snapshot()).filter(key => key.startsWith('assertion/')).length, 1003)
  assert.deepEqual(importJobStatus(completed), { id: completed.id, status: 'indexed', profileReady: true, processed: 1003, total: 1003, statusUrl: `/imports/${completed.id}/status` })
})

test('same archive uses independent owners and worker survives browser absence; tombstone wins delayed publication', async t => {
  const f = await fixture(t), bytes = await fullArchive(201), a = f.backend('owner-a'), b = f.backend('owner-b')
  const stage = (ownerId, backend) => stageArchive({ ownerId, filename: 'same.zip', bytes, adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT })
  const first = await stage('owner-a', a), second = await stage('owner-b', b)
  assert.notEqual(first.id, second.id)
  assert.equal(await b.readResource('import', first.id), null)
  const worker = createArchiveWorker({ listPendingImports: async () => [{ id: first.id, owner: { ownerId: 'owner-a', userId: 'a' } }], getBackend: async () => a })
  await worker.tick(); await worker.stop()
  assert.equal((await a.readResource('import', first.id)).payload.counts.indexed, 203)
  let raced = false
  f.setHook(async (phase, items) => {
    const final = items.find(item => item.sourceId === second.id && item.payload?.status === 'indexed')
    if (phase === 'before' && final && !raced) {
      raced = true
      const current = (await f.snapshot())['import/' + second.id]
      await f.batch([{ type: 'import', sourceId: second.id, sourceOwnerId: 'owner-b', sourceRevision: current.sourceRevision + 1, expectedRevision: current.sourceRevision, deleted: true, audience: 'owner', payload: null }])
    }
  })
  await assert.rejects(runArchiveJob({ ownerId: 'owner-b', id: second.id, adapter: b.adapter, readAsset: b.readAsset }), /tombstone_conflict/)
  assert.equal((await b.readResource('import', second.id)).deleted, true)
  const read = createScopedImportReader({ readResource: b.readResource, readAsset: b.readAsset, grant: { ownerId: 'owner-b', importIds: [second.id] } })
  await assert.rejects(read(second.id), /private_import_not_found/)
  await assert.rejects(readOwnerProfileRows({ ownerId: 'owner-b', jobs: [(await b.readResource('import', second.id))], backend: b }), /private_import_not_found/)
  await assert.rejects(stage('owner-b', b), /private_import_deleted/)
  assert.equal((await a.readResource('import', first.id)).payload.counts.indexed, 203)
})

test('lost uploaded response replays stored receipt and corrupt archive fails without publication', async t => {
  const f = await fixture(t), backend = f.backend('owner-a')
  let lost = false
  f.setHook(async (phase, items) => { if (!lost && phase === 'after' && items.some(item => item.payload?.status === 'uploaded')) { lost = true; throw new Error('lost_response') } })
  const job = await stageArchive({ ownerId: 'owner-a', filename: 'broken.zip', bytes: Buffer.from('bad ZIP'), adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT })
  assert.equal(job.status, 'uploaded')
  const final = await runArchiveJob({ ownerId: 'owner-a', id: job.id, adapter: backend.adapter, readAsset: backend.readAsset })
  assert.equal(final.status, 'failed'); assert.equal(final.counts.indexed, 0)
  assert.equal(Object.keys(await f.snapshot()).filter(key => key.startsWith('assertion/')).length, 0)
})

test('actual HTTP upload returns profile before processing; authenticated status isolates owners after navigation and worker restart', async t => {
  const f = await fixture(t), events = []
  const getBackend = async owner => {
    const backend = f.backend(owner.ownerId)
    return { ...backend,
      listImportJobIds: async () => Object.values(await f.snapshot()).filter(row => row.sourceOwnerId === owner.ownerId && row.payload?.id === row.sourceId && !row.payload.kind && !row.payload.receiptOf).map(row => row.sourceId),
      listImportIds: async () => Object.values(await f.snapshot()).filter(row => row.sourceOwnerId === owner.ownerId && ['indexed', 'partial'].includes(row.payload?.status) && row.payload?.id === row.sourceId && !row.payload.kind && !row.payload.receiptOf).map(row => row.sourceId),
      listAccountGrantIds: async () => [] }
  }
  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', backgroundImports: true, getBackend, audit: async event => events.push(event),
    login: { begin: async () => ({ location: 'https://synthetic.invalid/sign-in', transaction: { state: 'synthetic-state' } }),
      finish: async url => ({ issuer: 'https://synthetic.invalid', subject: url.searchParams.get('code'), verifiedEmail: 'display-only@example.invalid' }) },
    resolveOwner: async identity => ['owner-a', 'owner-b'].includes(identity.subject) ? { ownerId: identity.subject, userId: identity.subject } : null,
    signup: async () => { throw new Error('not used') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  const signIn = async owner => {
    const start = await fetch(endpoint + '/login', { redirect: 'manual' })
    const callback = await fetch(endpoint + `/auth/callback/ideaflow?code=${owner}&state=synthetic-state`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
    assert.equal(callback.status, 303)
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  const cookieA = await signIn('owner-a'), cookieB = await signIn('owner-b')
  assert.equal(events.filter(event => event.event === 'auth_session_created').length, 2)
  assert.equal(JSON.stringify(events).includes('display-only@example.invalid'), false)
  const home = await (await fetch(endpoint, { headers: { Cookie: cookieA } })).text()
  assert.equal(home.includes('name="consent"'), false)
  const csrf = home.match(/name="csrf" value="([^"]+)"/)[1], bytes = await fullArchive(201)
  const form = new FormData(); form.set('csrf', csrf); form.set('archive', new Blob([bytes]), 'browser-full.zip')
  const upload = await fetch(endpoint + '/upload', { method: 'POST', headers: { Cookie: cookieA, Origin: baseUrl }, body: form, redirect: 'manual' })
  assert.equal(upload.status, 303); assert.equal(upload.headers.get('location'), '/profile')
  const jobs = Object.values(await f.snapshot()).filter(row => row.payload?.backgroundVersion && !row.payload.receiptOf)
  assert.equal(jobs.length, 1); assert.equal(jobs[0].payload.status, 'uploaded'); assert.equal(jobs[0].payload.counts.indexed, 0)
  assert.deepEqual(jobs[0].payload.consent, COMBINED_UPLOAD_CONSENT)
  const statusUrl = `/imports/${jobs[0].sourceId}/status`
  assert.equal((await fetch(endpoint + statusUrl)).status, 401)
  assert.equal((await fetch(endpoint + statusUrl, { headers: { Cookie: cookieB } })).status, 404)
  const status = await (await fetch(endpoint + statusUrl, { headers: { Cookie: cookieA } })).json()
  assert.equal(status.status, 'uploaded'); assert.equal(status.total, null)
  const waiting = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookieA } })).text()
  assert.match(waiting, /Importing/); assert.match(waiting, /fetch\(/)
  // The browser/controller is gone. A new worker discovers the durable receipt.
  await new Promise(resolve => server.close(resolve))
  const worker = createArchiveWorker({ getBackend, listPendingImports: async () => [{ id: jobs[0].sourceId, owner: { ownerId: 'owner-a', userId: 'owner-a' } }] })
  await worker.tick(); await worker.stop()
  const persisted = (await f.snapshot())['import/' + jobs[0].sourceId]
  assert.equal(persisted.payload.status, 'indexed'); assert.equal(persisted.payload.counts.indexed, 203)
  const profile = profileFromRows(await readOwnerProfileRows({ ownerId: 'owner-a', jobs: [persisted], backend: await getBackend({ ownerId: 'owner-a' }) }))
  assert.equal(profile.name, 'Own Synthetic')
})

test('profile page keeps prior indexed profile when newer malformed upload fails', async t => {
  const f = await fixture(t)
  const getBackend = async owner => {
    const backend = f.backend(owner.ownerId)
    return { ...backend,
      listImportJobIds: async () => Object.values(await f.snapshot()).filter(row => row.sourceOwnerId === owner.ownerId && row.payload?.id === row.sourceId && !row.payload.kind && !row.payload.receiptOf).map(row => row.sourceId),
      listImportIds: async () => Object.values(await f.snapshot()).filter(row => row.sourceOwnerId === owner.ownerId && ['indexed', 'partial'].includes(row.payload?.status) && row.payload?.id === row.sourceId && !row.payload.kind && !row.payload.receiptOf).map(row => row.sourceId),
      listAccountGrantIds: async () => [] }
  }
  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', backgroundImports: true, getBackend,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/sign-in', transaction: { state: 'synthetic-state' } }),
      finish: async url => ({ issuer: 'https://synthetic.invalid', subject: url.searchParams.get('code'), verifiedEmail: 'display-only@example.invalid' }) },
    resolveOwner: async identity => identity.subject === 'owner-a' ? { ownerId: identity.subject, userId: identity.subject } : null,
    signup: async () => { throw new Error('not used') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' })
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?code=owner-a&state=synthetic-state', { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const upload = async (bytes, name) => {
    const page = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
    const form = new FormData(); form.set('csrf', csrf); form.set('archive', new Blob([bytes]), name)
    const response = await fetch(endpoint + '/upload', { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl }, body: form, redirect: 'manual' })
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/profile')
  }
  await upload(await richProfileArchive(201), 'good.zip')
  let jobs = Object.values(await f.snapshot()).filter(row => row.payload?.backgroundVersion && !row.payload.receiptOf)
  await runArchiveJob({ ownerId: 'owner-a', id: jobs[0].sourceId, adapter: (await getBackend({ ownerId: 'owner-a' })).adapter, readAsset: (await getBackend({ ownerId: 'owner-a' })).readAsset })
  let profile = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /Own Synthetic/)
  assert.match(profile, /Principal Engineer/)
  await upload(Buffer.from('not a zip'), 'newer-broken.zip')
  jobs = Object.values(await f.snapshot()).filter(row => row.payload?.backgroundVersion && !row.payload.receiptOf)
  const failed = jobs.find(row => row.payload.status === 'uploaded')
  await runArchiveJob({ ownerId: 'owner-a', id: failed.sourceId, adapter: (await getBackend({ ownerId: 'owner-a' })).adapter, readAsset: (await getBackend({ ownerId: 'owner-a' })).readAsset })
  profile = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /Own Synthetic/)
  assert.match(profile, /Import could not finish/)
  assert.doesNotMatch(profile, /Reading your profile and connections/)
  const settings = await (await fetch(endpoint + '/settings', { headers: { Cookie: cookie } })).text()
  assert.match(settings, /newer-broken\.zip/)
  assert.match(settings, /failed/)
})

test('profile page selects newest successful profile from reverse job discovery order', async t => {
  const f = await fixture(t), owner = { ownerId: 'owner-a', userId: 'owner-a' }
  let jobOrder = []
  const getBackend = async ownerArg => {
    const backend = f.backend(ownerArg.ownerId)
    return { ...backend,
      listImportJobIds: async () => jobOrder,
      listImportIds: async () => jobOrder,
      listAccountGrantIds: async () => [] }
  }
  const olderBackend = await getBackend(owner)
  const older = await stageArchive({ ownerId: owner.ownerId, filename: 'older.zip', bytes: await namedProfileArchive('Older', 'Owner', 'Legacy profile'), adapter: olderBackend.adapter, consent: COMBINED_UPLOAD_CONSENT, now: () => 1000 })
  await runArchiveJob({ ownerId: owner.ownerId, id: older.id, adapter: olderBackend.adapter, readAsset: olderBackend.readAsset, now: () => 1000 })
  const newerBackend = await getBackend(owner)
  const newer = await stageArchive({ ownerId: owner.ownerId, filename: 'newer.zip', bytes: await namedProfileArchive('Newer', 'Owner', 'Current profile'), adapter: newerBackend.adapter, consent: COMBINED_UPLOAD_CONSENT, now: () => 2000 })
  await runArchiveJob({ ownerId: owner.ownerId, id: newer.id, adapter: newerBackend.adapter, readAsset: newerBackend.readAsset, now: () => 2000 })
  jobOrder = [newer.id, older.id]

  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', backgroundImports: true, getBackend,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/sign-in', transaction: { state: 'synthetic-state' } }),
      finish: async url => ({ issuer: 'https://synthetic.invalid', subject: url.searchParams.get('code'), verifiedEmail: 'display-only@example.invalid' }) },
    resolveOwner: async identity => identity.subject === owner.ownerId ? owner : null,
    signup: async () => { throw new Error('not used') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' })
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?code=owner-a&state=synthetic-state', { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const profile = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /Newer Owner/)
  assert.match(profile, /Current profile/)
  assert.doesNotMatch(profile, /Older Owner/)
  assert.doesNotMatch(profile, /Legacy profile/)
})

test('profile page accepts legacy receipts without createdAt before newer profile-first jobs', async t => {
  const f = await fixture(t), owner = { ownerId: 'owner-a', userId: 'owner-a' }
  let jobOrder = []
  const getBackend = async ownerArg => {
    const backend = f.backend(ownerArg.ownerId)
    return { ...backend,
      listImportJobIds: async () => jobOrder,
      listImportIds: async () => jobOrder,
      listAccountGrantIds: async () => [] }
  }
  const legacyBackend = await getBackend(owner)
  const legacy = await ingestArchive({ ownerId: owner.ownerId, filename: 'legacy.zip', bytes: await namedProfileArchive('Legacy', 'Owner', 'Old runtime profile'), adapter: legacyBackend.adapter, consent: COMBINED_UPLOAD_CONSENT })
  assert.equal(legacy.createdAt, undefined)
  jobOrder = [legacy.id]

  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', backgroundImports: true, getBackend,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/sign-in', transaction: { state: 'synthetic-state' } }),
      finish: async url => ({ issuer: 'https://synthetic.invalid', subject: url.searchParams.get('code'), verifiedEmail: 'display-only@example.invalid' }) },
    resolveOwner: async identity => identity.subject === owner.ownerId ? owner : null,
    signup: async () => { throw new Error('not used') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' })
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?code=owner-a&state=synthetic-state', { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  let profile = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /Legacy Owner/)
  assert.match(profile, /Old runtime profile/)

  const currentBackend = await getBackend(owner)
  const current = await stageArchive({ ownerId: owner.ownerId, filename: 'current.zip', bytes: await namedProfileArchive('Current', 'Owner', 'New profile'), adapter: currentBackend.adapter, consent: COMBINED_UPLOAD_CONSENT, now: () => 2000 })
  await runArchiveJob({ ownerId: owner.ownerId, id: current.id, adapter: currentBackend.adapter, readAsset: currentBackend.readAsset, now: () => 2000 })
  const failedBackend = await getBackend(owner)
  const failed = await stageArchive({ ownerId: owner.ownerId, filename: 'newer-broken.zip', bytes: Buffer.from('not a zip'), adapter: failedBackend.adapter, consent: COMBINED_UPLOAD_CONSENT, now: () => 3000 })
  await runArchiveJob({ ownerId: owner.ownerId, id: failed.id, adapter: failedBackend.adapter, readAsset: failedBackend.readAsset, now: () => 3000 })
  jobOrder = [legacy.id, failed.id, current.id]

  profile = await (await fetch(endpoint + '/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /Current Owner/)
  assert.match(profile, /New profile/)
  assert.match(profile, /Import could not finish/)
  assert.doesNotMatch(profile, /Legacy Owner/)
  assert.doesNotMatch(profile, /Reading your profile and connections/)
})

test('owner profile reads only bounded profile chunks and preserves full fields', async t => {
  const f = await fixture(t), ownerId = 'owner-a', backend = f.backend(ownerId), staged = await stageArchive({ ownerId, filename: 'rich.zip', bytes: await richProfileArchive(401), adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT })
  const completed = await runArchiveJob({ ownerId, id: staged.id, adapter: backend.adapter, readAsset: backend.readAsset })
  assert.equal(completed.profileChunkCount, 1)
  assert.ok(completed.assertionChunks.length > 2)
  const calls = []
  const observed = { ...backend, readResource: async (type, id) => { calls.push(`${type}/${id}`); return backend.readResource(type, id) } }
  const profile = profileFromRows(await readOwnerProfileRows({ ownerId, jobs: [await backend.readResource('import', staged.id)], backend: observed }))
  assert.equal(profile.name, 'Own Synthetic')
  assert.equal(profile.headline, 'Graph engineer')
  assert.deepEqual(profile.positions, [{ title: 'Principal Engineer', company: 'Synthetic Labs', description: 'Built durable import systems', startDate: '2020', endDate: '' }])
  assert.deepEqual(profile.education, [{ institution: 'Graph University', degree: 'MS Systems', startDate: '2012', endDate: '2014' }])
  assert.deepEqual(profile.skills, ['Graph systems'])
  assert.ok(calls.includes(`import/${completed.assertionChunks[0]}`))
  assert.equal(calls.includes(`import/${completed.assertionChunks[1]}`), false)
})
