import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createPersonLookup } from '../mcp-server/person-lookup.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { parseLinkedinProfileUrl } from '../src/utils/linkedin-profile-url.mjs'
import { classifyMeetCode } from '../src/utils/meet-scan.js'

const owner = { ownerId: 'synthetic-lookup-owner', userId: 'synthetic-lookup-user' }
const publicPerson = value => ({ positions: [], education: [], skills: [], ...value })
const address = 'https://www.linkedin.com/in/synthetic-person'
const settings = { dailyCap: 100, pacingMs: 4000, timeoutMs: 100 }

test('LinkedIn QR and pasted URLs share strict normalization without following foreign redirects', () => {
  for (const input of ['linkedin.com/in/Synthetic-Person/', address + '?utm_source=share#profile']) {
    assert.deepEqual(parseLinkedinProfileUrl(input), { slug: 'synthetic-person', url: address })
    assert.deepEqual(classifyMeetCode(input), { kind: 'linkedin', href: '/people/lookup?url=' + encodeURIComponent(address), label: 'LinkedIn profile: synthetic-person' })
  }
  assert.equal(parseLinkedinProfileUrl('https://linkedin.com/in/ceyda-k%C4%B1ran/').slug, 'ceyda-kıran')
  for (const input of ['https://linkedin.com.evil.test/in/foo', 'https://evil.test/?next=' + address, 'https://linkedin.com/in/a%2Fb', 'https://linkedin.com:9999/in/a', 'https://user@linkedin.com/in/a', 'https://lnkd.in/abc', 'https://linkedin.com/company/foo', 'javascript:alert(1)']) {
    assert.equal(parseLinkedinProfileUrl(input), null)
    assert.equal(classifyMeetCode(input), null)
  }
})

test('published URL lookup prefers the member, keeps namesakes separate and fails closed', async () => {
  let snapshot = { state: 'published', complete: true, revision: 'lookup-test', profiles: [
    { id: 'shadow', name: 'Same Name', linkedinUrl: address }, { id: 'member', name: 'Same Name', linkedinUrl: address },
    { id: 'other', name: 'Same Name', linkedinUrl: 'https://www.linkedin.com/in/other' },
  ].map(publicPerson), members: ['member'], connections: [] }
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
  assert.equal((await reader.lookupLinkedin({ address: address + '?trk=qr' })).id, 'member')
  assert.equal(await reader.lookupLinkedin({ address: 'https://www.linkedin.com/in/missing' }), null)
  snapshot = null
  await assert.rejects(reader.lookupLinkedin({ address }), error => error.status === 503)
})

test('live preview whitelists professional fields, reserves before fetching, caches and types failures', async () => {
  let reads = 0, reservation = { allowed: true }, finished
  const store = { reserve: async args => { assert.deepEqual(args.owner, owner); return reservation }, finish: async args => { finished = args; return true }, removeOwner: async () => {} }
  let value = { name: 'LinkedIn Person', headline: 'Engineer', email: 'private@example.invalid', photo: 'https://evil.test/photo', positions: [{ title: 'Engineer', company: 'Example', phone: 'private' }] }
  const service = createPersonLookup({ store, settings, adapter: { lookup: async (slug, { signal }) => { reads++; assert.equal(slug, 'synthetic-person'); assert.ok(signal); if (value instanceof Error) throw value; return value } } })
  let result = await service.lookup({ owner, address })
  assert.equal(result.status, 'found'); assert.equal(result.profile.company, 'Example'); assert.equal(result.profile.email, undefined); assert.equal(result.profile.photo, undefined); assert.equal(finished.profile.positions[0].phone, undefined)
  reservation = { profile: result.profile, observedAt: 1234 }
  result = await service.lookup({ owner, address }); assert.equal(result.cached, true); assert.equal(reads, 1)
  for (const code of ['paced', 'daily_cap', 'owner_limit']) { reservation = { code }; assert.equal((await service.lookup({ owner, address })).code, code) }
  reservation = { allowed: true }
  value = null; assert.equal((await service.lookup({ owner, address })).code, 'not_found')
  value = Object.assign(Error('provider credential/body must never reach user'), { code: 'refused' }); assert.equal((await service.lookup({ owner, address })).code, 'refused')
  value = Error('private'); assert.deepEqual(await service.lookup({ owner, address }), { status: 'unavailable', code: 'unavailable' })
  assert.equal((await service.lookup({ owner, address: 'https://evil.test/' })).code, 'invalid_url')
})

test('deadline holds even for an adapter ignoring cancellation; stale store completion is not served', async () => {
  let finished
  const store = { reserve: async () => ({ allowed: true }), finish: async args => { finished = args; return true }, removeOwner: async () => {} }
  const slow = createPersonLookup({ store, settings: { ...settings, timeoutMs: 10 }, adapter: { lookup: () => new Promise(() => {}) } })
  assert.equal((await slow.lookup({ owner, address })).code, 'timeout'); assert.equal(finished.code, 'timeout'); assert.equal(finished.profile, undefined)
  const stale = createPersonLookup({ store: { ...store, finish: async () => false }, settings, adapter: { lookup: async () => ({ name: 'Late Person' }) } })
  assert.equal((await stale.lookup({ owner, address })).code, 'unavailable')
})

async function browser(t) {
  const resources = new Map(), assets = new Map(), snapshot = { state: 'published', complete: true, revision: 'http-test', profiles: [], members: [], connections: [] }
  let calls = 0, handler
  const backend = {
    adapter: { withImport: async (_owner, id, work) => work({ getJob: async () => resources.get(id)?.payload,
      putAsset: async (hash, bytes) => assets.set(hash, Buffer.from(bytes)), saveJob: async job => resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, payload: structuredClone(job), sourceRevision: job.revision, deleted: false }) }) },
    readResource: async (_type, id) => resources.get(id), listImportIds: async () => [...resources.keys()], listImportJobIds: async () => [...resources.keys()], listAccountGrantIds: async () => [],
  }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic', login: { begin: async () => ({ location: 'https://id.invalid/', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://id.invalid', subject: 'lookup-person', displayName: 'Lookup Owner' }) }, resolveOwner: async () => owner, signup: async () => owner,
    issueAccountGrant: async () => ({ accessToken: 'synthetic' }), revokeAccountGrant: async () => {},
    getBackend: async caller => { assert.deepEqual(caller, owner); return backend }, readPublishedSnapshot: async () => snapshot,
    personLookup: { enabled: true, lookup: async args => { calls++; assert.deepEqual(args.owner, owner); return { status: 'found', address, observedAt: Date.now(), profile: { name: 'New Person', headline: '<script>unsafe</script>', company: 'Example', positions: [], education: [] } } }, removeOwner: async () => {} } })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const start = await request('/login'), callback = await request('/auth/callback/ideaflow?state=state&code=x', { headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(row => row.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await request('/people/lookup', { headers: { Cookie: cookie } })).text(), csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
  const post = (path, fields, authenticated = true) => request(path, { method: 'POST', headers: { ...(authenticated ? { Cookie: cookie } : {}), Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  return { request, post, cookie, csrf, snapshot, resources, get calls() { return calls } }
}

test('browser lookup finds existing public people without a provider; URL search and QR lead to same route', async t => {
  const b = await browser(t)
  b.snapshot.profiles.push(publicPerson({ id: 'existing-person', name: 'Existing Person', linkedinUrl: address }))
  const path = '/people/lookup?url=' + encodeURIComponent(address)
  for (const headers of [{}, { Cookie: b.cookie }]) {
    const response = await b.request(path, { headers }); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/people/existing-person')
  }
  const result = await b.post('/people/lookup', { csrf: b.csrf, linkedinUrl: address }); assert.equal(result.status, 303); assert.equal(b.calls, 0)
  const search = await b.request('/network?q=' + encodeURIComponent(address), { headers: { Cookie: b.cookie } }); assert.equal(search.headers.get('location'), path)
  const asset = await b.request('/public-assets/linkedin-profile-url.mjs'); assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/)
})

test('only a CSRF-protected member lookup fetches; preview is escaped, save is private and replay-safe', async t => {
  const b = await browser(t)
  assert.equal((await b.request('/people/lookup?url=' + encodeURIComponent(address))).status, 401); assert.equal(b.calls, 0)
  assert.equal((await b.post('/people/lookup', { csrf: b.csrf, linkedinUrl: address }, false)).status, 401)
  const forged = await b.post('/people/lookup', { csrf: 'wrong', linkedinUrl: address }); assert.notEqual(forged.status, 200); assert.equal(b.calls, 0)
  const response = await b.post('/people/lookup', { csrf: b.csrf, linkedinUrl: address }); assert.equal(response.status, 200)
  const page = await response.text(); assert.match(page, /&lt;script&gt;unsafe&lt;\/script&gt;/); assert.doesNotMatch(page, /<script>unsafe/); assert.match(page, /Add to my people/); assert.equal(b.calls, 1)
  const lookupToken = /name="lookupToken" value="([^"]+)"/.exec(page)[1]
  const tamper = await b.post('/people/lookup/save', { csrf: b.csrf, lookupToken: 'wrong' }); assert.notEqual(tamper.status, 303); assert.equal(b.resources.size, 0)
  for (let i = 0; i < 2; i++) { const saved = await b.post('/people/lookup/save', { csrf: b.csrf, lookupToken }); assert.equal(saved.status, 303) }
  assert.equal(b.resources.size, 1)
  const job = [...b.resources.values()][0].payload
  assert.equal(job.origin.kind, 'added-person'); assert.equal(job.status, 'uploaded'); assert.equal(b.snapshot.profiles.length, 0)
})
