import { createLegacyProfileBoundary } from '../mcp-server/profile-source-boundary.mjs'
import { createSignupLinkedin, unipileConfig } from '../mcp-server/signup-linkedin.mjs'
import { memorySignupStore } from './helpers/signup-linkedin-store.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Opt-in reviewer evidence from executed HTTP responses, using synthetic data.
async function evidence(name, content) {
  const directory = process.env.UNLINKED_TEST_EVIDENCE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), content)
}

const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [
  { id: 'p-jl', name: 'Joshua Langsam', headline: 'Managing Director at Raptor Group', positions: [], education: [], skills: [] },
  { id: 'p-x', name: 'Lister One', positions: [], education: [], skills: [] },
  { id: 'dup-1', name: 'Casey Doe', positions: [], education: [], skills: [] },
  { id: 'dup-2', name: 'Casey Doe', positions: [], education: [], skills: [] },
], connections: [{ fromId: 'p-x', toId: 'p-jl' }] }

async function start(t, { displayName = 'Joshua Langsam', owner = { ownerId: 'owner-a', userId: 'user-a' }, claimableIds = ['p-jl', 'dup-1', 'dup-2'], claimError = null, claimAction, signupLinkedin, published = true } = {}) {
  const calls = { lookups: [], names: [], claims: [], audits: [] }
  let provisioned = false, handler
  const selfClaims = {
    lookupSlug: async slug => { calls.lookups.push(slug); return slug === 'joshua-langsam-1352407' ? 'p-jl' : null },
    // Mirrors the composition: names resolve against the legacy dataset only,
    // and an ambiguous name resolves to null.
    lookupName: async name => { calls.names.push(name); return name.trim() === 'Joshua Langsam' ? 'p-jl' : null },
    claimable: async profileId => claimableIds.includes(profileId),
    claim: async request => { if (claimError) throw new Error(claimError); calls.claims.push(request); return claimAction ? claimAction(request) : { profileId: request.profileId, receiptId: 'receipt-1' } },
  }
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({
    baseUrl: origin,
    login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a', clientId: 'client', verifiedAt: Date.now(), displayName }) },
    resolveOwner: async () => provisioned ? owner : null,
    signup: async () => { provisioned = true; return owner },
    issueAccountGrant: async () => ({ token: 'grant' }), revokeAccountGrant: async () => {},
    selfClaims, signupLinkedin,
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [], readLegacyProfile: async () => null }),
    readPublishedSnapshot: async () => { const sources = signupLinkedin ? await signupLinkedin.list() : []; return { ...snapshot, profiles: [...snapshot.profiles, ...(published ? sources.map(row => row.profile) : [])], members: sources.map(row => row.profile.id) } },
    complete: async () => ({ matches: [] }),
    audit: async event => { calls.audits.push(event) },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const begin = await request('/login')
  const loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
  assert.equal(callback.status, 303)
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const signed = (path, options = {}) => request(path, { ...options, headers: { Cookie: cookie, ...(options.headers ?? {}) } })
  const post = (path, fields) => signed(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams(fields) })
  const csrf = (await (await signed('/find-me')).text()).match(/name="csrf" value="([^"]+)"/)[1]
  return { calls, request, signed, post, csrf, callback }
}

test('a new account is offered the find-me step, a LinkedIn address finds the unclaimed profile and confirming claims it', async t => {
  const { signed, post, csrf, callback, calls } = await start(t)
  assert.equal(callback.headers.get('location'), '/find-me')
  const page = await signed('/find-me')
  assert.equal(page.status, 200)
  const content = await page.text()
  assert.ok(content.includes('Find yourself on Unlinked')); assert.ok(content.includes('Skip for now'))
  const found = await post('/find-me', { csrf, linkedinUrl: 'https://www.linkedin.com/in/joshua-langsam-1352407/' })
  assert.equal(found.status, 200)
  const card = await found.text()
  assert.ok(card.includes('Is this you?')); assert.ok(card.includes('Joshua Langsam')); assert.ok(card.includes('Managing Director at Raptor Group')); assert.ok(card.includes('Listed by 1 member'))
  assert.deepEqual(calls.lookups, ['joshua-langsam-1352407'])
  const candidate = card.match(/name="candidate" value="([^"]+)"/)[1]
  // The confirmation requires the displayed card's own binding token.
  assert.notEqual((await post('/claim-me', { csrf })).status, 303)
  assert.notEqual((await post('/claim-me', { csrf, candidate: 'stale-token' })).status, 303)
  assert.equal(calls.claims.length, 0)
  const claimed = await post('/claim-me', { csrf, candidate })
  assert.equal(claimed.status, 303); assert.equal(claimed.headers.get('location'), '/profile')
  assert.equal(calls.claims.length, 1)
  const request = calls.claims[0]
  assert.equal(request.profileId, 'p-jl'); assert.equal(request.evidence, 'self-asserted-linkedin-url-v1')
  assert.deepEqual(request.owner, { ownerId: 'owner-a', userId: 'user-a' })
  assert.match(request.emailHash, /^[a-f0-9]{64}$/)
  assert.equal(request.issuer, 'https://idp.invalid'); assert.equal(request.subject, 'subject-a')
  assert.ok(calls.audits.some(event => event.event === 'legacy_profile_self_claimed' && event.profileId === 'p-jl' && event.receiptId === 'receipt-1'))
  // The step is spent: a second confirm has no candidate and fails closed.
  assert.notEqual((await post('/claim-me', { csrf, candidate })).status, 303)
})

test('a newer lookup invalidates a stale card: the old token no longer claims, the new one does', async t => {
  const { post, csrf, calls } = await start(t)
  const first = await (await post('/find-me', { csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const stale = first.match(/name="candidate" value="([^"]+)"/)[1]
  const second = await (await post('/find-me', { csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const fresh = second.match(/name="candidate" value="([^"]+)"/)[1]
  assert.notEqual(stale, fresh)
  assert.notEqual((await post('/claim-me', { csrf, candidate: stale })).status, 303)
  assert.equal(calls.claims.length, 0)
  assert.equal((await post('/claim-me', { csrf, candidate: fresh })).status, 303)
  assert.equal(calls.claims.length, 1)
})

test('with no address the identity display name must match exactly one profile; ambiguity or an existing row shows none', async t => {
  const byName = await start(t)
  const found = await (await byName.post('/find-me', { csrf: byName.csrf, linkedinUrl: '' })).text()
  assert.ok(found.includes('Is this you?'))
  assert.deepEqual(byName.calls.names, ['Joshua Langsam'])
  await byName.post('/claim-me', { csrf: byName.csrf, candidate: found.match(/name="candidate" value="([^"]+)"/)[1] })
  assert.equal(byName.calls.claims[0].profileId, 'p-jl')
  assert.equal(byName.calls.claims[0].evidence, 'self-asserted-display-name-v1')

  const ambiguous = await start(t, { displayName: 'Casey Doe' })
  assert.ok(!(await (await ambiguous.post('/find-me', { csrf: ambiguous.csrf, linkedinUrl: '' })).text()).includes('Is this you?'))

  const taken = await start(t, { claimableIds: [] })
  assert.ok(!(await (await taken.post('/find-me', { csrf: taken.csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()).includes('Is this you?'))
})

test('claim races fail closed with a notice, and a wrong csrf or stray field never reaches the claim', async t => {
  const racing = await start(t, { claimError: 'self_claim_conflict' })
  const card = await (await racing.post('/find-me', { csrf: racing.csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const candidate = card.match(/name="candidate" value="([^"]+)"/)[1]
  const conflict = await racing.post('/claim-me', { csrf: racing.csrf, candidate })
  assert.equal(conflict.status, 200)
  assert.ok((await conflict.text()).includes('claimed'))
  assert.equal(racing.calls.claims.length, 0)
  for (const fields of [{ csrf: 'wrong', candidate }, { csrf: racing.csrf, candidate, extra: 'field' }, { csrf: racing.csrf }]) {
    assert.notEqual((await racing.post('/claim-me', fields)).status, 303)
  }
})

function signupService(fetchImpl) {
  return createSignupLinkedin({ store: memorySignupStore(), config: unipileConfig({ UNLINKED_UNIPILE_BASE: 'https://unipile.invalid/api/v1', UNLINKED_UNIPILE_KEY: 'synthetic-key', UNLINKED_UNIPILE_ACCOUNT_ID: 'test-account' }), fetchImpl })
}
test('no legacy match performs one mocked Unipile read; source-labelled card confirms into public People immediately', async t => {
  let reads = 0
  const service = signupService(async () => { reads++; return Response.json({ first_name: 'New', last_name: 'Member', headline: '<Engineer>', location: 'Austin', work_experience: [{ position: 'Builder', company: 'Example' }], education: [{ school: 'Example University' }], profile_picture_url: 'data:image/png;ignored' }) })
  const f = await start(t, { displayName: 'New Member', signupLinkedin: service })
  const response = await f.post('/find-me', { csrf: f.csrf, linkedinUrl: 'https://linkedin.com/in/new-member' })
  const card = await response.text()
  await evidence('find-me-public-linkedin.html', card)
  assert.equal(reads, 1); assert.ok(card.includes('from your public LinkedIn profile')); assert.ok(card.includes("Yes, that's me"))
  assert.ok(card.includes('&lt;Engineer&gt;')); assert.ok(card.includes('Austin')); assert.ok(card.includes('Builder')); assert.ok(card.includes('Example University'))
  assert.ok(!card.includes('data:image')); assert.ok(!card.includes('synthetic-key')); assert.ok(response.headers.get('content-security-policy').includes("img-src 'self'"))
  assert.deepEqual(await service.list(), [])
  const stale = card.match(/name="candidate" value="([^"]+)"/)[1]
  const repeat = await (await f.post('/find-me', { csrf: f.csrf, linkedinUrl: 'https://linkedin.com/in/new-member' })).text()
  assert.equal(reads, 1)
  const candidate = repeat.match(/name="candidate" value="([^"]+)"/)[1]
  assert.notEqual((await f.post('/claim-me', { csrf: f.csrf, candidate: stale })).status, 303)
  assert.notEqual((await f.post('/claim-me', { csrf: 'bad', candidate })).status, 303)
  const confirmation = await f.post('/claim-me', { csrf: f.csrf, candidate })
  assert.equal(confirmation.status, 303)
  assert.equal(f.calls.claims.length, 0)
  const [source] = await service.list()
  const publicPage = await f.request('/people/' + source.profile.id)
  const publicHtml = await publicPage.text()
  assert.equal(publicPage.status, 200); assert.ok(publicHtml.includes('&lt;Engineer&gt;'))
  await evidence('confirmed-public-profile.html', publicHtml)
  await evidence('signup-http-journey.json', JSON.stringify({
    provider: 'mocked Unipile', providerReads: reads,
    lookup: { method: 'POST', path: '/find-me', status: response.status },
    confirmation: { method: 'POST', path: '/claim-me', status: confirmation.status, location: confirmation.headers.get('location') },
    publicProfile: { method: 'GET', path: '/people/' + source.profile.id, status: publicPage.status },
    confirmedSource: source,
  }, null, 2))
  const own = await f.signed('/profile'); assert.equal(own.status, 200); assert.ok((await own.text()).includes('New Member'))
  assert.ok(f.calls.audits.some(row => row.event === 'public_linkedin_profile_self_asserted'))
})

test('legacy URL or name matches, taken legacy profiles and invalid URLs never read Unipile', async t => {
  let reads = 0
  const service = signupService(async () => { reads++; throw Error('must not call') })
  const f = await start(t, { signupLinkedin: service })
  for (const linkedinUrl of ['https://linkedin.com/in/joshua-langsam-1352407', 'https://linkedin.com/in/unknown', '', 'bare-slug', 'https://evil.test/linkedin.com/in/unknown']) await f.post('/find-me', { csrf: f.csrf, linkedinUrl })
  const taken = await start(t, { signupLinkedin: service, claimableIds: [] })
  await taken.post('/find-me', { csrf: taken.csrf, linkedinUrl: 'https://linkedin.com/in/joshua-langsam-1352407' })
  assert.equal(reads, 0)
})

test('provider failure yields friendly name-only fallback without a confirmation candidate', async t => {
  const service = signupService(async () => new Response('raw secret response', { status: 503 }))
  const f = await start(t, { displayName: 'New Member', signupLinkedin: service })
  const page = await (await f.post('/find-me', { csrf: f.csrf, linkedinUrl: 'https://linkedin.com/in/new-member' })).text()
  await evidence('provider-failure-fallback.html', page)
  assert.ok(page.includes('continue with your name')); assert.ok(!page.includes('name="candidate"')); assert.ok(!page.includes('raw secret'))
  const next = await f.signed('/profile')
  assert.equal(next.status, 303); assert.equal(next.headers.get('location'), '/while-you-wait')
  assert.equal((await f.signed(next.headers.get('location'))).status, 200)
  const profile = await f.signed('/profile')
  assert.equal(profile.status, 200); assert.ok((await profile.text()).includes('New Member'))
})

test('a slug confirmed by another account suppresses its cached card and stale confirmation, auditing only a reason', async t => {
  let reads = 0
  const service = signupService(async () => { reads++; return Response.json({ first_name: 'Public', last_name: 'Person' }) })
  const a = await start(t, { displayName: 'New Member', signupLinkedin: service })
  const b = await start(t, { displayName: 'Another Member', owner: { ownerId: 'owner-b', userId: 'user-b' }, signupLinkedin: service })
  const slug = 'one-public-person', preview = async f => (await f.post('/find-me', { csrf: f.csrf, linkedinUrl: 'https://linkedin.com/in/' + slug })).text()
  const aCard = await preview(a), bCard = await preview(b)
  const candidate = card => card.match(/name="candidate" value="([^"]+)"/)[1]
  const first = await a.post('/claim-me', { csrf: a.csrf, candidate: candidate(aCard) })
  assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/while-you-wait')
  const stale = await b.post('/claim-me', { csrf: b.csrf, candidate: candidate(bCard) })
  assert.equal(stale.status, 200); assert.ok((await stale.text()).includes('can’t be claimed'))
  const refused = await preview(b)
  await evidence('claimed-slug-fallback.html', refused)
  assert.ok(refused.includes('continue with your name')); assert.ok(refused.includes('export later'))
  assert.ok(!refused.includes('name="candidate"')); assert.ok(!refused.includes("Yes, that's me"))
  assert.equal(reads, 1); assert.equal((await service.list()).length, 1)
  const audits = b.calls.audits.filter(row => row.event.endsWith('_refused'))
  assert.deepEqual(audits.map(row => row.reason), ['self_claim_conflict', 'slug_claimed'])
  assert.ok(audits.every(row => /^[a-f0-9]{64}$/.test(row.ownerHash)))
  assert.ok(!JSON.stringify(audits).includes(slug)); assert.ok(!JSON.stringify(audits).includes('Public Person'))
  await evidence('slug-conflict-http-journey.json', JSON.stringify({
    provider: 'mocked Unipile', providerReads: reads,
    firstConfirmation: { status: first.status, location: first.headers.get('location') },
    competingStaleConfirmation: { status: stale.status, outcome: 'refused' },
    subsequentLookup: { outcome: 'continue with your name and add your export', confirmationCardOffered: false },
    activePublicProfiles: (await service.list()).length,
    refusalAudit: audits,
  }, null, 2))
})


test('confirmed signup source supplies export, verified card target and owner deletion', async t => {
  const service = signupService(async () => Response.json({ first_name: 'Public', last_name: 'Identity', headline: 'Builder', location: 'Austin' }))
  const owner = { ownerId: 'owner-a', userId: 'user-a' }
  await service.lookup({ owner, address: 'https://linkedin.com/in/public-identity' })
  await service.confirm({ owner, slug: 'public-identity' })
  const f = await start(t, { displayName: 'Login Name', signupLinkedin: service })
  const [source] = await service.list()
  const card = await (await f.signed('/card')).text()
  assert.ok(card.includes('Public Identity')); assert.ok(card.includes('Builder')); assert.ok(card.includes('Austin'))
  assert.ok(card.includes('/people/' + source.profile.id)); assert.ok(card.includes('<svg'))
  const hidden = await start(t, { displayName: 'Login Name', signupLinkedin: service, published: false })
  const unpublishedCard = await (await hidden.signed('/card')).text()
  assert.ok(unpublishedCard.includes('Public Identity')); assert.ok(!unpublishedCard.includes('/people/' + source.profile.id))
  const exported = await f.signed('/export')
  assert.equal(exported.status, 200)
  const data = await exported.json()
  assert.deepEqual(data.imports, [])
  assert.equal(data.signupProfile.profile.name, 'Public Identity')
  assert.equal(data.signupProfile.receiptId, source.receiptId)
  assert.deepEqual(data.signupProfile.provenance, { source: 'public-linkedin', selfAsserted: true, confirmation: 'self-asserted-public-linkedin-v1' })
  const refused = await f.post('/delete-account', { csrf: f.csrf, confirm: 'delete' })
  assert.equal(refused.status, 400); assert.ok(await service.read(owner))
  const deleted = await f.post('/delete-account', { csrf: f.csrf, confirm: 'delete everything' })
  assert.equal(deleted.status, 200)
  assert.equal(await service.read(owner), null); assert.deepEqual(await service.list(), [])
  assert.equal((await f.request('/people/' + source.profile.id)).status, 404)
  const again = await start(t, { displayName: 'Login Name', signupLinkedin: service })
  assert.ok(!(await (await again.signed('/profile')).text()).includes('Public Identity'))
  assert.equal((await service.lookup({ owner, address: 'https://linkedin.com/in/public-identity' })).code, 'account_limit')
})

test('account deletion fails closed if signup source cleanup fails', async t => {
  const service = signupService(async () => Response.json({ first_name: 'Public', last_name: 'Identity' }))
  const f = await start(t, { displayName: 'Login Name', signupLinkedin: { ...service, removeOwner: async () => { throw Error('storage_unavailable') } } })
  assert.equal((await f.post('/delete-account', { csrf: f.csrf, confirm: 'delete everything' })).status, 400)
  const next = await f.signed('/profile')
  assert.equal(next.status, 303); assert.equal(next.headers.get('location'), '/while-you-wait')
  assert.equal((await f.signed(next.headers.get('location'))).status, 200)
  const profile = await f.signed('/profile')
  assert.equal(profile.status, 200); assert.ok((await profile.text()).includes('Login Name'))
})


test('two authenticated sessions can upgrade a signup stand-in to legacy; a stale signup confirmation cannot republish it', async t => {
  const store = memorySignupStore()
  let legacyConfirmed = false, reads = 0
  const service = createSignupLinkedin({ store: { ...store, confirm: args => legacyConfirmed ? false : store.confirm(args) },
    config: unipileConfig({ UNLINKED_UNIPILE_BASE: 'https://unipile.invalid', UNLINKED_UNIPILE_KEY: 'test-only', UNLINKED_UNIPILE_ACCOUNT_ID: 'test-account' }),
    fetchImpl: async () => { reads++; return Response.json({ first_name: 'New', last_name: 'Member', headline: 'Day one profile' }) } })
  const boundary = createLegacyProfileBoundary({ session: () => ({ close: async () => {}, executeWrite: async work => work({ run: async (query, params) => {
    if (query.includes('RETURN b.sourceOwnerId')) return { records: [{ get: () => params.ownerId }] }
    if (query === 'CREATE legacy') { legacyConfirmed = true; return {} }
    for (const source of store.sources.values()) if (source.owner.ownerId === params.ownerId && legacyConfirmed) { source.retired = true; source.retiredByProfileId = params.profileId }
    return {}
  } }) }) })
  const claimAction = request => boundary.confirm(request.owner, request.profileId, async () => {
    const session = boundary.driver.session()
    try { return await session.executeWrite(async tx => { await tx.run('CREATE legacy', {}); return { profileId: request.profileId, receiptId: 'legacy-receipt' } }) } finally { await session.close() }
  })
  const sourceTab = await start(t, { displayName: 'New Member', signupLinkedin: service }), legacyTab = await start(t, { signupLinkedin: service, claimAction })
  const sourceCard = await (await sourceTab.post('/find-me', { csrf: sourceTab.csrf, linkedinUrl: 'https://linkedin.com/in/new-member' })).text()
  const legacyCard = await (await legacyTab.post('/find-me', { csrf: legacyTab.csrf, linkedinUrl: 'https://linkedin.com/in/joshua-langsam-1352407' })).text()
  const token = card => card.match(/name="candidate" value="([^"]+)"/)[1]
  assert.equal((await sourceTab.post('/claim-me', { csrf: sourceTab.csrf, candidate: token(sourceCard) })).status, 303)
  const staleTab = await start(t, { displayName: 'New Member', signupLinkedin: service })
  const staleCard = await (await staleTab.post('/find-me', { csrf: staleTab.csrf, linkedinUrl: 'https://linkedin.com/in/new-member' })).text()
  const results = await Promise.all([legacyTab.post('/claim-me', { csrf: legacyTab.csrf, candidate: token(legacyCard) }), staleTab.post('/claim-me', { csrf: staleTab.csrf, candidate: token(staleCard) })])
  assert.equal(results[0].status, 303); assert.ok([200, 303].includes(results[1].status))
  assert.deepEqual(await service.list(), []); assert.equal(reads, 1)
  const retained = await service.readForExport({ ownerId: 'owner-a', userId: 'user-a' })
  assert.equal(retained.retired, true); assert.equal(retained.retiredByProfileId, 'p-jl'); assert.equal(retained.profile.headline, 'Day one profile')
  await assert.rejects(service.confirm({ owner: { ownerId: 'owner-a', userId: 'user-a' }, slug: 'new-member' }), /self_claim_conflict/)
})
