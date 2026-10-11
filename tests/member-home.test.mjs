// Signed-in Home (unlinked-5e5): honest import status from both sources that
// count (uploads and files recovered from an original Unlinked account), next
// actions from the member's own network, and a dismissible getting-started
// reminder that is a display choice only. All people here are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemoryHomePreferenceStore, createNeo4jHomePreferenceStore } from '../mcp-server/home-preferences.mjs'
import { summarizeImports } from '../src/utils/private-import/import-summary.mjs'
import { legacyTimestamp } from '../src/utils/legacy-import/storage-reader.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const owner = { ownerId: 'home-owner', userId: 'home-user' }
const id = n => String(n).repeat(64).slice(0, 64)
const JAN_4_2025 = legacyTimestamp('2025-01-04 20:40:29.755127+00')
const job = (n, status, extra = {}) => ({ sourceOwnerId: owner.ownerId, sourceId: id(n), payload: { id: id(n), ownerId: owner.ownerId, status, filename: `Fictional-${n}.zip`, createdAt: Date.UTC(2026, 9, n), counts: { accepted: 120, indexed: status === 'indexed' ? 120 : 0, rejected: 0, failedFiles: 0 }, ...extra } })
// The shape of a recovered legacy listing (readLegacyFiles), as storage-reader returns it.
const recoveredFiles = {
  objects: [
    { objectId: 'c', filename: 'Connections.csv', bytes: 1, category: 'connections', accepted: 2521, rejected: 45, uploadedAt: JAN_4_2025 },
    { objectId: 'p', filename: 'Profile.csv', bytes: 1, category: 'profile', accepted: 1, rejected: 0, uploadedAt: JAN_4_2025 },
    { objectId: 'q', filename: 'Positions.csv', bytes: 1, category: 'positions', accepted: 7, rejected: 0, uploadedAt: JAN_4_2025 },
    { objectId: 'x', filename: 'Ad_Targeting.csv', bytes: 1, category: 'other_csv', accepted: 0, rejected: 0, error: 'unsupported', uploadedAt: JAN_4_2025 },
  ],
}
const connectionRow = (n, name, connectedOn) => ({ id: `row-${n}`, ownerId: owner.ownerId, category: 'connections', fields: { 'first name': name, company: 'Fictional Co', position: 'Engineer', 'connected on': connectedOn }, provenance: { source: 'recovered-legacy-storage-v1' } })

async function site(t, { jobs = [], recovered = null, recoveredThrows = false, observations = [], pending = 0, preferences = createMemoryHomePreferenceStore() } = {}) {
  let handler
  const writes = []
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const backend = {
    adapter: {},
    listImportIds: async () => [], listImportJobIds: async () => jobs.map(value => value.sourceId), listAccountGrantIds: async () => [],
    readResource: async (_type, value) => structuredClone(jobs.find(resource => resource.sourceId === value) ?? null),
    // Any write would mean Home changed import state; none is allowed.
    writeResource: async (...args) => { writes.push(args); throw new Error('unexpected_write') },
    readLegacyFiles: async () => { if (recoveredThrows) throw new Error('legacy_storage_unavailable'); return recovered && structuredClone(recovered) },
    readLegacyObservations: async () => observations.length ? { manifestSha256: 'm', receiptId: 'r', assertions: structuredClone(observations) } : null,
    readLegacyProfile: async () => null,
  }
  const memberConnections = { send: async () => ({}), respond: async () => ({}), withdraw: async () => ({}), received: async () => [], sent: async () => [], pendingCount: async () => pending, between: async () => null, removeOwner: async () => {} }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'verified-subject', verifiedEmail: 'robin@example.invalid', displayName: 'Robin Fictional' }),
  }, resolveOwner: async identity => identity.subject === 'verified-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async () => backend, memberConnections, accountForProfile: async () => null,
  ...(preferences ? { homePreferences: preferences } : {}) })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const get = async path => { const response = await request(path, { headers: { Cookie: session } }); return { status: response.status, location: response.headers.get('location'), body: await response.text() } }
  const post = (path, fields) => request(path, { method: 'POST', headers: { Cookie: session, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const csrfFrom = body => body.match(/name="csrf" value="([^"]+)"/)[1]
  return { get, post, csrfFrom, writes, preferences }
}
const main = body => body.match(/<main class="journey">(.*)<\/main>/s)[1]

test('a brand-new member keeps the default-on getting-started reminder, can hide it from Home, and bring it back', async t => {
  const home = await site(t)
  const first = await home.get('/')
  assert.equal(first.status, 200)
  assert.match(first.body, /<h1 class="hq">Bring your LinkedIn export<\/h1>/)
  assert.match(first.body, /aria-label="Getting started"/)
  assert.match(first.body, /action="\/home\/import-reminder"/)
  const csrf = home.csrfFrom(first.body)
  // The reminder choice needs the session's own CSRF token and a known value.
  assert.equal((await home.post('/home/import-reminder', { csrf: 'wrong', reminder: 'dismissed' })).status, 400)
  assert.equal((await home.post('/home/import-reminder', { csrf, reminder: 'complete' })).status, 400)
  assert.equal(await home.preferences.get(owner), null)
  const hidden = await home.post('/home/import-reminder', { csrf, reminder: 'dismissed' })
  assert.equal(hidden.status, 303); assert.equal(hidden.headers.get('location'), '/')
  const after = await home.get('/')
  assert.match(after.body, /<h1 class="hq">Welcome back, Robin<\/h1>/)
  assert.doesNotMatch(main(after.body), /Bring your LinkedIn export|Getting started/)
  // Honest status stays: nothing was imported, and the guide can come back.
  assert.match(after.body, /home-pill muted">Not yet</)
  assert.match(after.body, /No LinkedIn export imported yet\./)
  assert.match(after.body, /name="reminder" value="shown"/)
  assert.equal((await home.post('/home/import-reminder', { csrf, reminder: 'shown' })).status, 303)
  assert.match((await home.get('/')).body, /<h1 class="hq">Bring your LinkedIn export<\/h1>/)
  assert.deepEqual(home.writes, [])
})

test('without a preference store the reminder still shows and offers no hide control', async t => {
  const { get } = await site(t, { preferences: null })
  const first = await get('/')
  assert.match(first.body, /<h1 class="hq">Bring your LinkedIn export<\/h1>/)
  assert.doesNotMatch(first.body, /import-reminder/)
})

test('a member whose only import is recovered from their original Unlinked account gets Home with real counts and dates', async t => {
  const observations = [connectionRow(1, 'Avery Older', '03 Feb 2019'), connectionRow(2, 'Blake Newest', '28 Dec 2024'), connectionRow(3, 'Casey Middle', '15 Jun 2022')]
  const { get, writes } = await site(t, { recovered: recoveredFiles, observations, pending: 2 })
  const home = await get('/')
  assert.equal(home.status, 200)
  const body = main(home.body)
  assert.doesNotMatch(body, /Bring your LinkedIn export|Getting started|import-reminder/)
  assert.match(body, /home-pill ok">Complete</)
  assert.match(body, /<b>2,521 connections<\/b> · profile, 7 positions/)
  assert.match(body, /Uploaded <time datetime="2025-01-04T20:40:29\.755Z">Jan 4, 2025<\/time> to your original Unlinked account, and recovered to this account\./)
  assert.match(body, /45 rows had no name or LinkedIn address and were skipped\./)
  assert.match(body, /href="\/import">Upload a newer export</)
  // Next actions from the network: requests waiting, newest connections first.
  assert.match(body, /href="\/invitations"><b>2 connection requests<\/b>/)
  const names = [...body.matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1])
  assert.deepEqual(names.slice(0, 3), ['Blake Newest', 'Casey Middle', 'Avery Older'])
  assert.match(body, /3 people in your network/)
  assert.match(body, /href="\/network\?sort=connected">See everyone by date connected/)
  assert.match(body, /method="get" action="\/network" role="search"/)
  assert.match(body, /href="\/card"><b>My card<\/b>/)
  // The import page offers a newer export instead of the getting-started steps.
  const refresh = await get('/import')
  assert.match(refresh.body, /<h1 class="hq">Upload a newer LinkedIn export<\/h1>/)
  assert.match(refresh.body, /Your LinkedIn import has 2,521 connections, uploaded Jan 4, 2025 to your original Unlinked account\./)
  assert.doesNotMatch(refresh.body, /aria-label="Getting started"|import-reminder/)
  // Profile and Settings stop saying there is no file.
  const profile = await get('/profile')
  assert.match(profile.body, /href="\/import">Upload a newer export</)
  assert.match(profile.body, /Your LinkedIn files from your original Unlinked account are on this account\./)
  assert.doesNotMatch(profile.body, /You can add your file later/)
  const settings = await get('/settings')
  assert.match(settings.body, /No new uploads\. Your LinkedIn files recovered from your original Unlinked account are listed below\./)
  assert.doesNotMatch(settings.body, /No files added yet/)
  assert.deepEqual(writes, [])
})

test('an import in progress shows the live progress banner and a running status on Home', async t => {
  const { get } = await site(t, { jobs: [job(5, 'parsing', { progress: { processed: 30, total: 120 } })] })
  const home = await get('/')
  assert.match(home.body, /<aside class="import-status"[^>]*><strong>Importing · 25% · 30 of 120 records<\/strong>/)
  assert.match(home.body, /home-pill busy">Importing</)
  assert.match(home.body, /setInterval\(async\(\)=>\{try\{const r=await fetch\("\/imports\//)
  assert.doesNotMatch(main(home.body), /Getting started|<h1 class="hq">Bring your LinkedIn export/)
})

test('a finished upload shows Complete with its records and date, without the global banner repeating it', async t => {
  const { get } = await site(t, { jobs: [job(6, 'indexed')] })
  const home = await get('/')
  assert.doesNotMatch(home.body, /class="import-status"/)
  assert.match(home.body, /home-pill ok">Complete</)
  assert.match(home.body, /<b>120 records<\/b> imported <time datetime="2026-10-06T00:00:00\.000Z">Oct 6, 2026<\/time>\./)
})

test('a failed upload says so with the plain-language reason and a way to try again', async t => {
  const { get } = await site(t, { jobs: [job(7, 'failed', { error: { code: 'archive_empty', reason: 'unrecognized_file' }, counts: { accepted: 0, indexed: 0, rejected: 0, failedFiles: 1 } })] })
  const body = main((await get('/')).body)
  assert.match(body, /home-pill warn">Not imported</)
  assert.match(body, /href="\/import">Try another file</)
  assert.doesNotMatch(body, /Complete|Getting started/)
})

test('a partial upload with unreadable files needs attention; a newer failure under an earlier import is named', async t => {
  const partial = await site(t, { jobs: [job(8, 'partial', { counts: { accepted: 50, indexed: 50, rejected: 3, failedFiles: 1 } })] })
  assert.match(main((await partial.get('/')).body), /home-pill warn">Needs attention</)
  const later = await site(t, { jobs: [job(2, 'indexed'), job(9, 'failed', { counts: { accepted: 0, indexed: 0, rejected: 0, failedFiles: 1 } })] })
  const body = main((await later.get('/')).body)
  assert.match(body, /home-pill ok">Complete</)
  assert.match(body, /Your upload on <time datetime="2026-10-09T00:00:00\.000Z">Oct 9, 2026<\/time> could not be imported\./)
})

test('when recovered files cannot be read, Home says the status is unavailable instead of asking for an export', async t => {
  const { get } = await site(t, { recoveredThrows: true })
  const body = main((await get('/')).body)
  assert.match(body, /home-pill muted">Unavailable</)
  assert.doesNotMatch(body, /Bring your LinkedIn export|Getting started|No LinkedIn export imported yet/)
})

test('a hidden reminder never hides a real import status', async t => {
  const preferences = createMemoryHomePreferenceStore()
  await preferences.set(owner, { importReminder: 'dismissed' })
  const { get } = await site(t, { recovered: recoveredFiles, preferences })
  const body = main((await get('/')).body)
  assert.match(body, /home-pill ok">Complete</)
  assert.doesNotMatch(body, /Show the setup guide|import-reminder/)
})

test('summarizeImports reports each state from real job and recovered-file inputs only', () => {
  const p = value => value.payload
  assert.equal(summarizeImports().state, 'none')
  assert.equal(summarizeImports({ recoveredUnavailable: true }).state, 'unknown')
  assert.equal(summarizeImports({ jobs: [p(job(1, 'indexing'))] }).state, 'in_progress')
  assert.equal(summarizeImports({ jobs: [p(job(1, 'indexed'))] }).state, 'complete')
  assert.equal(summarizeImports({ jobs: [p(job(1, 'partial', { counts: { accepted: 10, indexed: 9, rejected: 1, failedFiles: 0 } }))] }).state, 'complete')
  assert.equal(summarizeImports({ jobs: [p(job(1, 'partial', { counts: { accepted: 10, indexed: 9, rejected: 1, failedFiles: 1 } }))] }).state, 'partial')
  assert.equal(summarizeImports({ jobs: [p(job(1, 'failed'))] }).state, 'failed')
  const recovered = summarizeImports({ recovered: recoveredFiles })
  assert.equal(recovered.state, 'complete'); assert.equal(recovered.hasImport, true)
  assert.deepEqual({ ...recovered.lastComplete }, { source: 'recovered', files: 4, connections: 2521, skipped: 45, profile: true, positions: 7, education: 0, skills: 0, at: JAN_4_2025, complete: true })
  // A claimed legacy profile with no recovered files still counts by its connections.
  assert.equal(summarizeImports({ legacyConnections: 12 }).lastComplete.connections, 12)
  // Recovered files that held no usable rows are not a finished import.
  assert.equal(summarizeImports({ recovered: { objects: [recoveredFiles.objects[3]] } }).state, 'partial')
  // Newest finished source wins: an upload after the recovered archive.
  assert.equal(summarizeImports({ jobs: [p(job(3, 'indexed'))], recovered: recoveredFiles }).lastComplete.source, 'upload')
})

test('legacy storage timestamps parse as UTC; anything else is no date', () => {
  assert.equal(new Date(legacyTimestamp('2025-01-04 20:40:29.755127+00')).toISOString(), '2025-01-04T20:40:29.755Z')
  for (const value of [null, '', 'yesterday', 42]) assert.equal(legacyTimestamp(value), null)
})

test('the home preference store keeps one display choice per account and the graph migration knows its label', async () => {
  const store = createMemoryHomePreferenceStore({ now: () => 1000 })
  assert.equal(await store.get(owner), null)
  assert.deepEqual(await store.set(owner, { importReminder: 'dismissed' }), { importReminder: 'dismissed', updatedAt: 1000 })
  assert.equal(await store.get({ ownerId: owner.ownerId, userId: 'someone-else' }), null)
  await assert.rejects(store.set(owner, { importReminder: 'imported' }), /home_preference_invalid/)
  await store.removeOwner(owner)
  assert.equal(await store.get(owner), null)
  assert.ok(LABELS.includes('UnlinkedHomePreference'))
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('real Neo4j home preferences: owner-keyed upsert, user check and removal', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  t.after(() => driver.close())
  const store = createNeo4jHomePreferenceStore(driver, 'neo4j', { now: () => 5 })
  await store.initialize()
  const member = { ownerId: randomUUID(), userId: 'user-' + randomUUID() }
  t.after(() => store.removeOwner(member))
  await store.set(member, { importReminder: 'dismissed' })
  await store.set(member, { importReminder: 'shown' })
  assert.deepEqual(await store.get(member), { importReminder: 'shown', updatedAt: 5 })
  assert.equal(await store.get({ ...member, userId: 'other' }), null)
  await store.removeOwner(member)
  assert.equal(await store.get(member), null)
})
