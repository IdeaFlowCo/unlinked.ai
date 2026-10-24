import test from 'node:test'
import assert from 'node:assert/strict'
import { createContactEnrichment, normalizeContactCandidates, recentContact } from '../mcp-server/contact-enrichment.mjs'
import { createPersonLookup } from '../mcp-server/person-lookup.mjs'
import { renderContactDetail, renderPeople } from '../mcp-server/private-onboarding-views.mjs'

const owner = { ownerId: 'owner', userId: 'user' }, other = { ownerId: 'other', userId: 'other-user' }
const time = 1_800_000_000_000, url = 'https://www.linkedin.com/in/ada-example'
const row = { id: 'a'.repeat(64), category: 'connections', fields: { 'first name': 'Ada', 'last name': 'Example' }, connectedAt: time - 1000, provenance: { source: 'unlinked-connection' } }
function fixture(options = {}) {
  const records = new Map(), key = (o, id) => JSON.stringify([o.ownerId, o.userId, id]); let rows = [structuredClone(row)], reads = 0, searches = 0
  const store = { read: async (o, id) => structuredClone(records.get(key(o, id)) ?? null), write: async (o, id, version, value) => {
    if ((records.get(key(o, id))?.version ?? 0) !== version) return false
    records.set(key(o, id), structuredClone(value)); return true
  }, owners: async () => [owner], exportOwner: async o => [...records].filter(([k]) => k.startsWith(JSON.stringify([o.ownerId, o.userId]).slice(0, -1))).map(([, v]) => v), removeOwner: async o => { for (const k of records.keys()) if (k.startsWith(JSON.stringify([o.ownerId, o.userId]).slice(0, -1))) records.delete(k) } }
  const service = createContactEnrichment({ store, now: () => time, readNetwork: async () => ({ assertions: rows }), lookup: {
    lookup: async () => { reads++; return { status: 'found', address: url, profile: { name: 'Ada Example', about: 'Analytical engines', positions: [{ title: 'Engineer', company: 'Example' }] } } },
    search: async () => { searches++; return { status: 'found', candidates: [{ name: 'Ada Example', linkedinUrl: url, headline: 'Engineer' }] } },
  }, ...options })
  return { service, store, setRows: value => { rows = value }, counts: () => ({ reads, searches }) }
}

test('opt-in only; recent name-only contacts get private proposals, even for a unique match; explicit confirmation fetches details', async () => {
  const f = fixture()
  await f.service.processOwner(owner); assert.deepEqual(f.counts(), { reads: 0, searches: 0 })
  await f.service.configure(owner, true); await f.service.tick()
  let result = await f.service.inspect(owner, row)
  assert.equal(result.status, 'needs_review'); assert.equal(result.profile, undefined); assert.equal(result.candidates.length, 1)
  assert.equal((await f.service.inspect(other, row)).status, 'not_started')
  await assert.rejects(f.service.review(other, row, { action: 'confirm', address: url }))
  await assert.rejects(f.service.review(owner, row, { action: 'confirm', address: 'https://www.linkedin.com/in/someone-else' }))
  await f.service.review(owner, row, { action: 'confirm', address: url })
  result = await f.service.inspect(owner, row); assert.equal(result.status, 'enriched'); assert.equal(result.profile.about, 'Analytical engines')
  await f.service.tick(); assert.deepEqual(f.counts(), { reads: 1, searches: 1 })
  assert.equal(row.fields.url, undefined) // immutable source; never changes another member
  await f.service.removeOwner(owner); assert.equal((await f.service.inspect(owner, row)).status, 'not_started')
})

test('known URLs enrich automatically; local exact names avoid a paid name search; older records are not automatically swept', async () => {
  const f = fixture(); const addressed = { ...row, fields: { ...row.fields, url } }; f.setRows([addressed])
  await f.service.configure(owner, true); await f.service.tick(); assert.equal((await f.service.inspect(owner, addressed)).status, 'enriched')
  assert.deepEqual(f.counts(), { reads: 1, searches: 0 })
  const local = fixture({ localCandidates: async () => [{ name: 'Ada Example', linkedinUrl: url }] })
  await local.service.configure(owner, true); await local.service.tick(); assert.equal((await local.service.inspect(owner, row)).status, 'needs_review'); assert.equal(local.counts().searches, 0)
  assert.equal(recentContact({ ...row, connectedAt: time - 15 * 86400000 }, time), false)
  assert.equal(recentContact({ ...row, connectedAt: undefined, importedAt: time - 100 }, time), true)
})

test('removed sources, pauses and concurrent dismissals beat late provider responses', async () => {
  for (const change of ['remove', 'pause', 'dismiss', 'source']) {
    let finish, started
    const ready = new Promise(resolve => { started = resolve })
    const f = fixture({ lookup: { lookup: async () => {}, search: async () => { started(); return new Promise(resolve => { finish = resolve }) } } })
    await f.service.configure(owner, true); const work = f.service.tick(); await ready
    if (change === 'remove') f.setRows([])
    if (change === 'source') f.setRows([{ ...row, fields: { ...row.fields, company: 'Changed source' } }])
    if (change === 'pause') await f.service.configure(owner, false)
    if (change === 'dismiss') await f.service.review(owner, row, { action: 'dismiss' })
    finish({ status: 'found', candidates: [{ name: 'Ada Example', linkedinUrl: url }] }); await work
    const result = await f.store.read(owner, row.id)
    assert.equal(result.status, change === 'dismiss' ? 'dismissed' : 'processing')
  }
})

test('provider outages remain retryable and do not hot-loop; exact names only and field whitelist', async () => {
  let calls = 0
  const f = fixture({ lookup: { search: async () => { calls++; throw Error('secret provider error') } } })
  await f.service.configure(owner, true); await f.service.tick(); await f.service.tick()
  assert.equal(calls, 1); const result = await f.service.inspect(owner, row); assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'unavailable')
  const values = normalizeContactCandidates([{ name: 'Ada Example', linkedinUrl: url + '?tracking=x', email: 'not retained' }, { name: 'Ada Other', linkedinUrl: 'https://www.linkedin.com/in/other' }, { name: 'Ada Example', linkedinUrl: 'https://evil.test/' }], 'Ada Example')
  assert.deepEqual(values, [{ name: 'Ada Example', linkedinUrl: url }])
})

test('name search uses the same durable provider reservation, deadline and stale-finish protection', async () => {
  const reserved = [], finished = []; let allowed = true
  const store = { reserve: async args => { reserved.push(args); return allowed ? { allowed: true } : { code: 'daily_cap' } }, finish: async args => { finished.push(args); return true } }
  const settings = { dailyCap: 150, pacingMs: 4000, timeoutMs: 10 }
  const service = createPersonLookup({ store, settings, adapter: { search: async () => [{ name: 'Ada Example', linkedinUrl: url }] } })
  assert.equal((await service.search({ owner, query: 'Ada Example' })).status, 'found')
  assert.equal(reserved[0].owner, owner); assert.equal(reserved[0].dailyCap, 150); assert.equal(finished[0].profile, undefined)
  allowed = false; assert.equal((await service.search({ owner, query: 'Ada Example' })).code, 'daily_cap')
  allowed = true
  const slow = createPersonLookup({ store, settings, adapter: { search: () => new Promise(() => {}) } })
  assert.equal((await slow.search({ owner, query: 'Ada Example' })).code, 'timeout')
})

test('contact UI reports the true provenance, renders private rich details, escapes proposals, and keeps pending status honest', () => {
  const contact = { sourceRowId: row.id, name: 'Ada Example', sourceLabel: 'Accepted Unlinked connection' }
  let page = renderContactDetail({ csrf: 'csrf', contact, enrichment: { status: 'needs_review', candidates: [{ name: '<script>bad</script>', linkedinUrl: url, headline: 'Engineer' }] } }).content
  assert.match(page, /Accepted Unlinked connection/); assert.doesNotMatch(page, /From your LinkedIn import|<script>bad/)
  assert.match(page, /Use this profile/); assert.match(page, /name="csrf"/); assert.match(page, /None of these/)
  page = renderContactDetail({ csrf: 'csrf', contact, enrichment: { status: 'enriched', profile: { name: 'Another source name', about: 'Analytical engines', positions: [{ title: 'Engineer', company: 'Example' }], education: [{ institution: 'Example School' }] } } }).content
  assert.match(page, /<h1>Ada Example/); assert.match(page, /Analytical engines/); assert.match(page, /Example School/)
  page = renderContactDetail({ contact, enrichment: { status: 'processing' } }).content
  assert.match(page, /Looking for profile details/); assert.doesNotMatch(page, /Profile details found/)
  const network = renderPeople({ csrf: 'csrf', enrichmentAvailable: true, enrichmentPreferences: { enabled: true } }).content
  assert.match(network, /Pause automatic enrichment/)
})

test('HTTP preferences and reviews are session/CSRF/owner scoped; truthful detail and review pages work end to end', async t => {
  const { createServer } = await import('node:http')
  const { createPrivateBrowserHandler } = await import('../mcp-server/private-browser.mjs')
  const liveRow = { ...row, connectedAt: Date.now() - 1000 }
  const f = fixture({ now: Date.now }); f.setRows([liveRow])
  let subject = 'owner', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = who => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null,
    readMemberConnections: async () => who.ownerId === owner.ownerId ? [{ requestId: 'synthetic-request', name: 'Ada Example', connectedAt: liveRow.connectedAt }] : [] })
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic', login: { begin: async () => ({ location: 'https://id.invalid/', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://id.invalid', subject, displayName: subject }) },
    resolveOwner: async identity => identity.subject === 'owner' ? owner : other, signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'synthetic' }), revokeAccountGrant: async () => {},
    getBackend: async who => backend(who), contactEnrichment: f.service })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async name => {
    subject = name
    const begin = await request('/login')
    const result = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = result.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await request('/network', { headers: { Cookie: cookie } })).text()
    return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)[1] }
  }
  const me = await signIn('owner'), stranger = await signIn('other')
  const post = (path, who, values) => request(path, { method: 'POST', headers: { Cookie: who.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: who.csrf, ...values }) })
  const { privateId } = await import('../src/utils/private-import/job.mjs')
  const id = privateId(owner.ownerId, 'member-connection', 'synthetic-request'), path = `/network/contacts/${id}`
  f.setRows([{ ...liveRow, id, fields: { 'first name': 'Ada Example', company: '', position: '' }, provenance: { source: 'unlinked-connection', requestId: 'synthetic-request' } }])
  let response = await request(path, { headers: { Cookie: me.cookie } }); assert.equal(response.status, 200); assert.match(await response.text(), /Accepted Unlinked connection/)
  assert.equal((await request(path, { headers: { Cookie: stranger.cookie } })).status, 404)
  assert.notEqual((await post('/network/enrichment', me, { csrf: 'wrong', enabled: 'on' })).status, 303)
  assert.equal((await post('/network/enrichment', me, { enabled: 'on' })).status, 303)
  await f.service.tick()
  response = await request('/network/enrichment', { headers: { Cookie: me.cookie } }); assert.equal(response.status, 200); assert.match(await response.text(), /Possible matches · review/)
  response = await request(path, { headers: { Cookie: me.cookie } }); assert.match(await response.text(), /Use this profile/)
  assert.equal((await post(path + '/enrichment', stranger, { action: 'confirm', address: url })).status, 404)
  assert.equal((await post(path + '/enrichment', me, { action: 'confirm', address: url })).status, 303)
  response = await request(path, { headers: { Cookie: me.cookie } }); assert.match(await response.text(), /Analytical engines/)
})
