// Imported profiles (unlinked-3l8h): LinkedIn-keyed enrichment fills their
// empty fields, profiles sharing one LinkedIn address fold into one page, and
// every published profile gets a readable /people/<handle> address that
// follows the person. docs/imported-profile-enrichment.md, docs/profile-handles.md.
// All people here are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createMemberPublicIndex, fillFromLinkedinEnrichment, linkedinEnrichmentId, LINKEDIN_ENRICHMENT_DATASETS, profileLinkedinRef } from '../src/utils/public-people/member-projection.mjs'
import { linkedinIdentityMerges } from '../src/utils/public-people/url-identity.mjs'
import { applyProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { linkedinHandle, setProfileHandleLookup } from '../src/utils/public-people/profile-handles.mjs'
import { prepareEnrichmentSnapshot, readProvenance } from '../mcp-server/publish-enrichment-people.mjs'
import { createMemoryProfileHandleStore, createProfileHandles } from '../mcp-server/profile-handles.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const li = slug => `https://www.linkedin.com/in/${slug}`
const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const sha = value => createHash('sha256').update(value).digest('hex')
const [LI1] = LINKEDIN_ENRICHMENT_DATASETS

test('a LinkedIn enrichment id is the sha256 of the canonical slug, the same reference suspensions use', () => {
  assert.equal(linkedinEnrichmentId('ada-fictional'), 'li-' + sha('ada-fictional'))
  assert.equal(profileLinkedinRef({ linkedinUrl: li('Ada-Fictional') }), sha('ada-fictional'))
  assert.equal(profileLinkedinRef({ linkedinUrl: 'https://linkedin.com/in/ada-fictional/' }), sha('ada-fictional'))
  assert.equal(profileLinkedinRef({ linkedinUrl: 'https://example.com/in/ada-fictional' }), null)
  assert.equal(profileLinkedinRef({}), null)
})

test('enrichment fills gaps only: anything a profile already shows wins', () => {
  const row = { id: 'li-x', name: 'Ignored', headline: 'Row headline', location: 'Row City', about: 'Row about', company: 'Rowco', positions: [{ title: 'Analyst', company: 'Rowco' }], education: [{ institution: 'Row U' }], skills: [] }
  const shadow = person('public-1', 'Ada Fictional', { headline: 'Own headline', company: 'Ownco' })
  const filled = fillFromLinkedinEnrichment(shadow, row)
  assert.deepEqual(filled, { ...shadow, location: 'Row City', about: 'Row about', positions: row.positions, education: row.education })
  assert.equal(filled.name, 'Ada Fictional', 'the name is never replaced')
  const full = person('legacy-1', 'Ada Fictional', { headline: 'H', location: 'L', about: 'A', company: 'C', positions: [{ title: 'T', company: 'C' }], education: [{ institution: 'I' }], skills: ['S'] })
  assert.equal(fillFromLinkedinEnrichment(full, row), full, 'a full profile is returned unchanged')
  assert.deepEqual(fillFromLinkedinEnrichment(person('p', 'P', { about: '   ' }), { about: 'Real' }).about, 'Real', 'blank text is a gap')
})

const legacyOf = profiles => ({ state: 'published', complete: true, revision: 'legacy-public-v1:' + 'e'.repeat(64), profiles, connections: [] })
const liData = rows => ({ state: 'published', complete: true, revision: LI1 + ':' + sha(JSON.stringify(rows)), profiles: rows, connections: [] })
const liRow = (slug, extra) => ({ id: linkedinEnrichmentId(slug), name: 'Row Name', positions: [], education: [], skills: [], ...extra })

function index({ profiles, members = [], legacyMembers = [], decisions = [], rows = [], mergeSameLinkedin = true, prefer }) {
  const data = { [LI1]: rows.length ? liData(rows) : null }
  return createMemberPublicIndex({ readLegacy: async () => legacyOf(profiles), discover: async () => [], getBackend: async () => { throw Error('unused') },
    readMembers: async () => members, readLegacyMembers: async () => legacyMembers, readDecisions: async () => decisions,
    linkedinEnrichmentDatasets: [...LINKEDIN_ENRICHMENT_DATASETS], mergeSameLinkedin, ...(prefer ? { preferSurvivor: prefer } : {}),
    publicPeople: { read: async dataset => data[dataset] ?? null } })
}

test('the index fills imported and legacy profiles by LinkedIn address, never members or historical members', async () => {
  const rows = [liRow('ada-fictional', { location: 'Lisbon', positions: [{ title: 'Analyst', company: 'Brizo' }] }), liRow('bo-fictional', { about: 'Bo about' }), liRow('cy-member', { about: 'Not for members' }), liRow('di-legacy', { about: 'Not for historical members' })]
  const profiles = [person('public-a', 'Ada Fictional', { headline: 'Equity analyst', linkedinUrl: li('ada-fictional') }), person('0f8845b4-7def-487a-a404-c67e6aa811b8', 'Bo Fictional', { linkedinUrl: li('bo-fictional') }),
    person('member-signup-' + 'c'.repeat(64), 'Cy Member', { linkedinUrl: li('cy-member') }), person('1f8845b4-7def-487a-a404-c67e6aa811b8', 'Di Legacy', { linkedinUrl: li('di-legacy') }), person('public-e', 'Eve Fictional', { linkedinUrl: li('eve-fictional') })]
  const read = index({ profiles, rows, members: ['member-signup-' + 'c'.repeat(64)], legacyMembers: ['1f8845b4-7def-487a-a404-c67e6aa811b8'] })
  const value = await read(), by = id => value.profiles.find(profile => profile.id === id)
  assert.equal(by('public-a').location, 'Lisbon'); assert.equal(by('public-a').headline, 'Equity analyst'); assert.deepEqual(by('public-a').positions, [{ title: 'Analyst', company: 'Brizo' }])
  assert.equal(by('0f8845b4-7def-487a-a404-c67e6aa811b8').about, 'Bo about')
  assert.equal(by('member-signup-' + 'c'.repeat(64)).about, undefined)
  assert.equal(by('1f8845b4-7def-487a-a404-c67e6aa811b8').about, undefined)
  assert.deepEqual(by('public-e').positions, [], 'no row, no change')
  assert.equal(value.profiles.length, profiles.length, 'enrichment never adds people')
  // The rows are part of the revision; without them the profile is basic again.
  const without = await index({ profiles, members: ['member-signup-' + 'c'.repeat(64)] })()
  assert.notEqual(without.revision, value.revision)
  assert.deepEqual(without.profiles.find(profile => profile.id === 'public-a').positions, [])
})

test('removed and suspended profiles stay gone after enrichment', async () => {
  const profiles = [person('public-a', 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-b', 'Bo Fictional', { linkedinUrl: li('bo-fictional') })]
  const rows = [liRow('ada-fictional', { about: 'A' }), liRow('bo-fictional', { about: 'B' })]
  const decisions = [{ id: 'r1', kind: 'remove', profileId: 'public-a' }, { id: 's1', kind: 'suspend', profileId: 'public-b', linkedinRefHash: sha('bo-fictional') }]
  const value = await index({ profiles, rows, decisions })()
  assert.deepEqual(value.profiles, [])
  assert.deepEqual(value.removed, ['public-a'])
  assert.deepEqual(value.suspended, ['public-b'])
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => value })
  assert.equal(await reader.profile({ id: 'public-a' }), null)
  assert.equal(await reader.profile({ id: 'public-b' }), null)
})

test('a malformed LinkedIn enrichment dataset fails the index closed', async () => {
  const profiles = [person('public-a', 'Ada', { linkedinUrl: li('ada-fictional') })]
  for (const broken of [{ ...liData([liRow('ada-fictional')]), revision: 'curated-enrichment-v1:' + 'f'.repeat(64) }, { ...liData([{ ...liRow('ada-fictional'), id: 'public-a' }]) }, { ...liData([liRow('ada-fictional')]), connections: [{ fromId: 'a', toId: 'b' }] }]) {
    const read = createMemberPublicIndex({ readLegacy: async () => legacyOf(profiles), discover: async () => [], getBackend: async () => null, linkedinEnrichmentDatasets: [LI1], publicPeople: { read: async dataset => dataset === LI1 ? broken : null } })
    await assert.rejects(read(), /public_enrichment_invalid/)
  }
  for (const linkedinEnrichmentDatasets of [['curated-enrichment-v1'], [LI1, LI1], 'nope']) assert.throws(() => createMemberPublicIndex({ linkedinEnrichmentDatasets, readLegacy: async () => null, discover: async () => [], getBackend: async () => null, publicPeople: { read: async () => null } }), /public_enrichment_datasets_invalid/)
})

const ref = profile => profileLinkedinRef(profile)
test('same-address merges: a member absorbs its imported copies; copies fold into one survivor', () => {
  const M = 'member-signup-' + 'a'.repeat(64)
  const profiles = [person(M, 'Ada', { linkedinUrl: li('ada') }), person('public-2', 'Ada', { linkedinUrl: li('ada') }), person('0f8845b4-7def-487a-a404-c67e6aa811b8', 'Ada', { linkedinUrl: li('ada') }),
    person('public-b2', 'Bo', { linkedinUrl: li('bo') }), person('public-b1', 'Bo', { linkedinUrl: li('bo') }), person('public-b3', 'Bo', { linkedinUrl: li('bo') }),
    person('public-c1', 'Cy', { linkedinUrl: li('cy') }), person('public-c2', 'Cy', { linkedinUrl: li('cy') }),
    person('0e8845b4-7def-487a-a404-c67e6aa811b8', 'Di', { linkedinUrl: li('di') }), person('public-d1', 'Di', { linkedinUrl: li('di') }),
    person('member-signup-' + 'e'.repeat(64), 'Eve', { linkedinUrl: li('eve') }), person('member-signup-' + 'f'.repeat(64), 'Eve', { linkedinUrl: li('eve') }), person('public-e1', 'Eve', { linkedinUrl: li('eve') }),
    person('public-n1', 'Ann'), person('public-n2', 'Ann')]
  // An earlier merge into the legacy copy follows it to the member; a decision about c2 keeps the Cy pair apart.
  const decisions = [{ id: 'url:public-x', kind: 'merge', profileId: 'public-x', survivorId: '0f8845b4-7def-487a-a404-c67e6aa811b8' }, { id: 'u1', kind: 'unlist', profileId: 'public-c2' }]
  const result = linkedinIdentityMerges({ profiles, members: [M, 'member-signup-' + 'e'.repeat(64), 'member-signup-' + 'f'.repeat(64)], decisions, refFor: ref, prefer: ids => ids.includes('public-b3') ? 'public-b3' : null })
  const into = Object.fromEntries(result.merges.map(value => [value.profileId, value.survivorId]))
  assert.deepEqual(into, { 'public-2': M, '0f8845b4-7def-487a-a404-c67e6aa811b8': M, 'public-b2': 'public-b3', 'public-b1': 'public-b3' })
  assert.equal(result.decisions[0].survivorId, M, 'no chain is left behind')
  assert.equal(result.decisions[1], decisions[1])
  // Without a preferred copy the smallest id survives.
  assert.deepEqual(Object.fromEntries(linkedinIdentityMerges({ profiles: profiles.filter(value => value.name === 'Bo'), refFor: ref }).merges.map(value => [value.profileId, value.survivorId])), { 'public-b2': 'public-b1', 'public-b3': 'public-b1' })
  // Applied, the member page answers for every copy; legacy + copy and two members are left alone.
  const snapshot = applyProfileDecisions({ state: 'published', complete: true, revision: 'r', profiles, connections: [{ fromId: 'public-b2', toId: 'public-n1' }], members: [M] }, [...result.decisions, ...result.merges], { limit: 100000 })
  assert.equal(snapshot.aliases['public-2'], M); assert.equal(snapshot.aliases['public-b1'], 'public-b3')
  assert.deepEqual(snapshot.connections, [{ fromId: 'public-b3', toId: 'public-n1' }])
  assert.ok(snapshot.profiles.some(value => value.id === 'public-d1') && snapshot.profiles.some(value => value.id === '0e8845b4-7def-487a-a404-c67e6aa811b8'))
  assert.ok(snapshot.profiles.some(value => value.id === 'public-e1'))
})

test('an unverified member absorbs nothing, even under the same name', () => {
  const U = 'member-signup-' + 'c'.repeat(64)
  const profiles = [person(U, 'Victor Victim', { linkedinUrl: li('victim-fictional') }), person('public-v', 'Victor Victim', { linkedinUrl: li('victim-fictional') }), person('0f8845b4-7def-487a-a404-c67e6aa811b8', 'Victor Victim', { linkedinUrl: li('victim-fictional') })]
  assert.deepEqual(linkedinIdentityMerges({ profiles, members: [U], absorbers: [], refFor: ref }).merges, [])
})

test('earlier merges re-pointed at an absorbing member keep only the member\'s fields', () => {
  const M = 'member-signup-' + 'm'.repeat(64), L = '0f8845b4-7def-487a-a404-c67e6aa811b8'
  const profiles = [person(M, 'Ada', { linkedinUrl: li('ada') }), person(L, 'Ada', { linkedinUrl: li('ada') }), person('public-x', 'Ada', { about: 'From an import', linkedinUrl: li('ada') })]
  const decisions = [{ id: 'url:public-x', kind: 'merge', profileId: 'public-x', survivorId: L }]
  const result = linkedinIdentityMerges({ profiles, members: [M], absorbers: [M], decisions, refFor: ref })
  assert.deepEqual(result.decisions[0], { ...decisions[0], survivorId: M, fill: false })
  const snapshot = applyProfileDecisions({ state: 'published', complete: true, revision: 'r', profiles, connections: [], members: [M] }, [...result.decisions, ...result.merges], { limit: 100000 })
  assert.deepEqual(snapshot.profiles, [profiles[0]])
})

test('a verified member absorbs its copies without taking their fields; an unverified one absorbs nothing', async () => {
  const L = '0f8845b4-7def-487a-a404-c67e6aa811b8'
  const profiles = [person(L, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-a', 'Ada Fictional', { headline: 'Analyst at Importco', company: 'Importco', linkedinUrl: li('ada-fictional') }),
    person('member-signup-' + 'b'.repeat(64), 'Bo Fictional', { linkedinUrl: li('bo-fictional') }), person('public-b', 'Bo Fictional', { linkedinUrl: li('bo-fictional') })]
  const rows = [liRow('ada-fictional', { about: 'Row about' }), liRow('bo-fictional', { about: 'Bo row' })]
  // L is a confirmed recovered account now claimed (verified); Bo typed his address at signup.
  const value = await index({ profiles, rows, members: [L, 'member-signup-' + 'b'.repeat(64)], legacyMembers: [L] })()
  const ada = value.profiles.find(profile => profile.id === L)
  assert.equal(value.aliases['public-a'], L)
  assert.equal(ada.headline, undefined, "another importer's CSV row never fills a member")
  assert.equal(ada.about, undefined, 'enrichment never reaches a member through a merge')
  assert.equal(value.aliases['public-b'], undefined, 'an unverified address folds nothing in')
  assert.equal(value.profiles.find(profile => profile.id === 'public-b').about, 'Bo row')
})

test('a removed copy keeps the person removed: the other copies fold into it', () => {
  const profiles = [person('public-1', 'Ada', { linkedinUrl: li('ada') }), person('public-2', 'Ada', { linkedinUrl: li('ada') }), person('public-3', 'Ada', { linkedinUrl: li('ada') })]
  const decisions = [{ id: 'r', kind: 'remove', profileId: 'public-2' }]
  const result = linkedinIdentityMerges({ profiles, decisions, refFor: ref })
  assert.deepEqual(Object.fromEntries(result.merges.map(value => [value.profileId, value.survivorId])), { 'public-1': 'public-2', 'public-3': 'public-2' })
  const snapshot = applyProfileDecisions({ state: 'published', complete: true, revision: 'r', profiles, connections: [] }, [...result.decisions, ...result.merges], { limit: 100000 })
  assert.deepEqual(snapshot.profiles, [])
  assert.deepEqual(snapshot.removed, ['public-1', 'public-2', 'public-3'])
})

test('the LinkedIn rows stop filling at their text budget', async () => {
  const profiles = Array.from({ length: 6 }, (_, n) => person(`public-${n}`, `P${n}`, { linkedinUrl: li(`p-${n}`) }))
  const big = 'x'.repeat(1024 * 1024)
  const value = await index({ profiles, rows: profiles.map((_, n) => liRow(`p-${n}`, { about: big })) })()
  const filled = value.profiles.filter(profile => profile.about).length
  assert.ok(filled >= 3 && filled <= 5, String(filled))
})

test('the composed index folds same-address profiles only when asked, and names stay apart', async () => {
  const profiles = [person('public-1', 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-2', 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-3', 'Ada Fictional')]
  assert.equal((await index({ profiles, mergeSameLinkedin: false })()).profiles.length, 3)
  const merged = await index({ profiles, prefer: ids => ids.includes('public-2') ? 'public-2' : null })()
  assert.deepEqual(merged.profiles.map(value => value.id).sort(), ['public-2', 'public-3'])
  assert.deepEqual(merged.aliases, { 'public-1': 'public-2' })
})

test('LinkedIn-keyed rows publish only with li- ids and keep provenance out of the dataset', () => {
  const row = liRow('ada-fictional', { about: 'A' })
  const prepared = prepareEnrichmentSnapshot(Buffer.from(JSON.stringify([row])), LI1)
  assert.ok(prepared.snapshot.revision.startsWith(LI1 + ':'))
  assert.equal(prepareEnrichmentSnapshot(Buffer.from(JSON.stringify([row])), LI1).snapshot.revision, prepared.snapshot.revision, 'same rows, same revision: re-runs are no-ops')
  assert.throws(() => prepareEnrichmentSnapshot(Buffer.from(JSON.stringify([{ ...row, id: '0f8845b4-7def-487a-a404-c67e6aa811b8' }])), LI1), /enrichment_rows_invalid/)
  assert.throws(() => prepareEnrichmentSnapshot(Buffer.from(JSON.stringify([row]))), /enrichment_rows_invalid/, 'an li- id never enters an id-keyed dataset')
  assert.throws(() => prepareEnrichmentSnapshot(Buffer.from(JSON.stringify([{ ...row, source: 'exa' }])), LI1), /enrichment_rows_invalid/)
  assert.deepEqual(readProvenance(Buffer.from(JSON.stringify({ source: 'exa', fetched_from: '2026-10-10' }))), { source: 'exa', fetched_from: '2026-10-10' })
  assert.throws(() => readProvenance(Buffer.from('[]')), /enrichment_provenance_invalid/)
})

test('linkedinHandle keeps a vanity slug only when the grammar carries it', () => {
  assert.equal(linkedinHandle(li('Ada-Fictional')), 'ada-fictional')
  assert.equal(linkedinHandle(li('ada_fictional')), null)
  assert.equal(linkedinHandle(li('public-123')), null, 'id-shaped slugs stay ids')
  assert.equal(linkedinHandle(undefined), null)
})

// End to end over the browser: imported profiles get handles, ids 301 there,
// members win their own slug, and addresses follow the person.
const M = 'member-signup-' + 'f'.repeat(64)
const owner = { ownerId: 'ada-owner', userId: 'ada-user' }
async function site(t, initial) {
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await handles.initialize()
  const state = { snapshot: initial, accounts: { [M]: owner } }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => setProfileHandleLookup(null))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const backend = { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null, readLegacyProfile: async () => null }
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live', profileHandles: handles, handleBackfillMs: 0,
    accountForProfile: async id => state.accounts[id] ?? null, readPublishedSnapshot: async () => state.snapshot,
    ownProfileId: async () => null, getBackend: async () => backend,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'nobody', verifiedEmail: 'nobody@example.invalid', displayName: 'Nobody' }) },
    resolveOwner: async () => null, signup: async () => null, issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {} })
  const get = async path => { const response = await fetch(endpoint + path, { redirect: 'manual' }); return { status: response.status, location: response.headers.get('location'), text: await response.text() } }
  return { handler, handles, state, get }
}
const snap = (revision, profiles, extra = {}) => ({ state: 'published', complete: true, revision, profiles, connections: [], ...extra })

test('every imported profile gets a readable address and its old id answers 301', async t => {
  const adam = 'public-' + 'b'.repeat(64)
  const { handler, handles, get } = await site(t, snap('s1', [person(adam, 'Ada Riki Fictional', { linkedinUrl: li('ada-riki-fictional'), positions: [{ title: 'Analyst', company: 'Brizo' }] }),
    person('0f8845b4-7def-487a-a404-c67e6aa811b8', 'Bo Fictional'), person('public-c', 'Bo Fictional'), person('public-d', 'Ada Riki Fictional')], { members: [] }))
  assert.equal(await handler.backfillHandles({ pauseMs: 0 }), 4)
  assert.equal(handles.handleFor(adam), 'ada-riki-fictional')
  assert.equal(handles.kindOf('ada-riki-fictional'), 'linkedin')
  const old = await get(`/people/${adam}`)
  assert.equal(old.status, 301); assert.equal(old.location, '/people/ada-riki-fictional')
  assert.equal((await get(`/people/${adam}/connections?sort=name`)).location, '/people/ada-riki-fictional/connections?sort=name')
  const page = await get('/people/ada-riki-fictional')
  assert.equal(page.status, 200); assert.match(page.text, /Analyst/)
  // No slug: the name, then the name numbered; a name never takes a slug.
  assert.deepEqual(['0f8845b4-7def-487a-a404-c67e6aa811b8', 'public-c'].map(id => handles.handleFor(id)).sort(), ['bo-fictional', 'bo-fictional-2'])
  assert.equal(handles.handleFor('public-d'), 'ada-riki-fictional-2')
  assert.equal(handles.kindOf('bo-fictional'), 'name')
  assert.equal((await get('/people/0f8845b4-7def-487a-a404-c67e6aa811b8')).status, 301)
  assert.equal(JSON.parse((await get('/api/people/ada-riki-fictional')).text).profile.handle, 'ada-riki-fictional')
  assert.equal(await handler.backfillHandles({ pauseMs: 0 }), 0, 'assigned handles are left alone')
})

test('a member outranks an imported copy of themselves; the copy folding in moves its addresses', async t => {
  const copy = 'public-' + 'a'.repeat(64)
  const { handler, handles, state, get } = await site(t, snap('s1', [person(copy, 'Ada Fictional', { linkedinUrl: li('ada-fictional') })], { members: [] }))
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal(handles.handleFor(copy), 'ada-fictional')
  // Ada joins: her own profile carries the same address and the copy folds into it.
  state.snapshot = snap('s2', [person(M, 'Ada Fictional', { linkedinUrl: li('ada-fictional') })], { members: [M], aliases: { [copy]: M } })
  // Before the backfill moves it, the old address already lands on the member page.
  assert.equal((await get('/people/ada-fictional')).status, 301)
  assert.equal(await handler.backfillHandles({ pauseMs: 0 }), 1)
  assert.equal(handles.handleFor(M), 'ada-fictional')
  assert.equal(handles.resolve('ada-fictional').profileId, M)
  assert.equal((await get('/people/ada-fictional')).status, 200)
  assert.equal((await get(`/people/${copy}`)).location, '/people/ada-fictional')
  assert.equal((await get(`/people/${M}`)).location, '/people/ada-fictional')
})

test('a typed address alone never takes a live profile\'s handle, and a name handle that matches never moves', async t => {
  const copy = 'public-' + 'a'.repeat(64)
  const { handler, handles, state } = await site(t, snap('s1', [person(copy, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-n', 'Peter Fictional')], { members: [] }))
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal(handles.handleFor('public-n'), 'peter-fictional')
  // Two new members whose addresses did not fold anything in (typed at signup, unverified).
  state.snapshot = snap('s2', [person(copy, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-n', 'Peter Fictional'),
    person(M, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('member-signup-' + 'e'.repeat(64), 'Peter Member', { linkedinUrl: li('peter-fictional') })], { members: [M, 'member-signup-' + 'e'.repeat(64)] })
  state.accounts['member-signup-' + 'e'.repeat(64)] = { ownerId: 'p', userId: 'p' }
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal(handles.handleFor(copy), 'ada-fictional', 'the published copy keeps its address')
  assert.equal(handles.handleFor(M), 'ada-fictional-2')
  assert.equal(handles.handleFor('public-n'), 'peter-fictional', 'a different person keeps a name handle that matches a slug')
  assert.equal(handles.handleFor('member-signup-' + 'e'.repeat(64)), 'peter-member')
})

test('past the numbered defaults, names keep counting', async t => {
  const profiles = Array.from({ length: 63 }, (_, n) => person(`public-${String(n).padStart(3, '0')}`, '张伟'))
  const { handler, handles } = await site(t, snap('s1', profiles, { members: [] }))
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal(profiles.filter(value => handles.handleFor(value.id)).length, 63)
  assert.equal(handles.handleFor('public-062'), 'someone-63')
})

test('a LinkedIn address follows the person when the holding copy disappears, but never a removed one', async t => {
  const first = 'public-' + '1'.repeat(64), second = 'public-' + '2'.repeat(64), gone = 'public-' + '3'.repeat(64)
  const { handler, handles, state, get } = await site(t, snap('s1', [person(first, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person(gone, 'Bo Fictional', { linkedinUrl: li('bo-fictional') })], { members: [] }))
  await handler.backfillHandles({ pauseMs: 0 })
  // First's import is deleted; another import's copy of Ada remains. Bo's page was removed by request.
  state.snapshot = snap('s2', [person(second, 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person('public-' + '4'.repeat(64), 'Bo Fictional', { linkedinUrl: li('bo-fictional') })], { members: [], removed: [gone] })
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal(handles.handleFor(second), 'ada-fictional')
  assert.equal((await get('/people/ada-fictional')).status, 200)
  assert.equal(handles.resolve('bo-fictional').profileId, gone, 'a removed address is never handed on')
  assert.equal((await get('/people/bo-fictional')).status, 404)
  assert.equal((await get(`/people/${gone}`)).status, 404)
})

test('a suspended profile answers 404 at its handle and id', async t => {
  const adam = 'public-' + 'b'.repeat(64)
  const { handler, state, get } = await site(t, snap('s1', [person(adam, 'Ada Fictional', { linkedinUrl: li('ada-fictional') })], { members: [] }))
  await handler.backfillHandles({ pauseMs: 0 })
  state.snapshot = snap('s2', [], { members: [], suspended: [adam] })
  await handler.backfillHandles({ pauseMs: 0 })
  assert.equal((await get('/people/ada-fictional')).status, 404)
  assert.equal((await get(`/people/${adam}`)).status, 404)
})

test('the backfill writes in batches', async t => {
  const profiles = Array.from({ length: 25 }, (_, n) => person(`public-${String(n).padStart(3, '0')}`, `Person ${n} Fictional`, { linkedinUrl: li(`person-${n}-fictional`) }))
  const { handler, handles } = await site(t, snap('s1', profiles, { members: [] }))
  const calls = []
  const assignMany = handles.assignMany.bind(handles)
  handles.assignMany = async entries => { calls.push(entries.length); return assignMany(entries) }
  assert.equal(await handler.backfillHandles({ batchSize: 10, pauseMs: 0 }), 25)
  assert.deepEqual(calls, [10, 10, 5])
})
