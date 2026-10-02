import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createQueryMatcher, rankMatches, wordForms, words } from '../src/utils/public-people/text-match.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError } from '../src/utils/public-people/reader.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'

const person = (id, name, headline, extra = {}) => ({ id, name, headline, positions: [], education: [], skills: [], ...extra })
const people = [
  person('ana', 'Ana Ruiz', 'Angel Investor at Harbor Capital'),
  person('ben', 'Ben Cho', 'Staff Engineer at Riot Games'),
  person('cy', 'Cy Vance', 'Investor in games and interactive media'),
  person('dee', 'Dee Shevchuk', 'Designer'),
  person('eli', 'Eli Park', 'Partner', { about: 'Investing in gaming studios since 2015.' }),
  person('flo', 'Flo Game', 'Teacher'),
  person('gus', 'Gus Lind', 'VC Analyst at Hitachi Ventures'),
]
const snapshot = () => ({ state: 'published', complete: true, revision: 'search-v1', profiles: structuredClone(people), connections: [] })
const reader = () => createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot() })
const ids = result => result.profiles.map(profile => profile.id)

test('word forms cover plurals and common endings without a stemmer', () => {
  assert.deepEqual(new Set(wordForms('investors')), new Set(['investors', 'investor', 'invest']))
  assert.ok(wordForms('games').includes('game') && wordForms('games').includes('gaming'))
  assert.ok(wordForms('gaming').includes('game'))
  assert.deepEqual(wordForms('vc'), ['vc'])
  assert.ok(wordForms('companies').includes('company'))
  assert.deepEqual(words('Game-Investors, at “A&B”!'), ['game', 'investors', 'at', 'a', 'b'])
})

test('best match finds every word in any form and order, across the whole public profile', async () => {
  const result = await reader().list({ query: 'game investors' })
  assert.deepEqual(ids(result), ['cy', 'eli'])
  assert.equal(result.match, 'all'); assert.equal(result.total, 2)
  assert.deepEqual(ids(await reader().list({ query: 'investors game' })), ['cy', 'eli'])
  assert.deepEqual(ids(await reader().list({ query: 'Who are the GAME investors?' })), ['cy', 'eli'])
})

test('when nobody has every word, the closest people are returned and marked as partial', async () => {
  const result = await reader().list({ query: 'riot investor' })
  assert.equal(result.match, 'some')
  assert.deepEqual(new Set(ids(result)), new Set(['ana', 'ben', 'cy', 'eli']))
  const none = await reader().list({ query: 'zzzz qqqq' })
  assert.deepEqual(none.profiles, []); assert.equal(none.match, 'none'); assert.equal(none.total, 0)
})

test('short words match whole words only; names can be typed part-way and rank first', async () => {
  assert.deepEqual(ids(await reader().list({ query: 'vc' })), ['gus'])
  assert.deepEqual(ids(await reader().list({ query: 'shev' })), ['dee'])
  assert.deepEqual(ids(await reader().list({ query: 'game' }))[0], 'flo')
})

test('exact mode is the typed phrase as written', async () => {
  assert.deepEqual(ids(await reader().list({ query: 'game investors', mode: 'exact' })), [])
  assert.deepEqual(ids(await reader().list({ query: 'angel investor', mode: 'exact' })), ['ana'])
  assert.deepEqual(ids(await reader().list({ query: 'investor angel', mode: 'exact' })), [])
  assert.deepEqual(ids(await reader().list({ query: 'riot games', mode: 'exact' })), ['ben'])
  await assert.rejects(reader().list({ query: 'x', mode: 'fuzzy' }), error => error instanceof PublicPeopleReaderError && error.status === 400)
})

test('a cursor is bound to its query and mode; browsing without a query is unchanged', async () => {
  const paged = createPublicPeopleReader({ pageSize: 1, readPublishedSnapshot: async () => snapshot() })
  const first = await paged.list({ query: 'investor' })
  assert.equal(first.profiles.length, 1); assert.ok(first.nextCursor)
  assert.equal((await paged.list({ query: 'investor', cursor: first.nextCursor })).profiles.length, 1)
  await assert.rejects(paged.list({ query: 'investor', mode: 'exact', cursor: first.nextCursor }), error => error.status === 400)
  const browse = await reader().list()
  assert.deepEqual(Object.keys(browse), ['profiles']); assert.equal(browse.profiles.length, people.length)
})

test('rankMatches keeps only complete matches when any exist and preserves input order on ties', () => {
  const rows = [{ t: 'gaming studio' }, { t: 'game investor' }, { t: 'investing in games' }]
  const ranked = rankMatches(rows, createQueryMatcher('game investors'), row => ({ text: words(row.t), name: [] }))
  assert.equal(ranked.match, 'all'); assert.deepEqual(ranked.rows.map(row => row.t), ['game investor', 'investing in games'])
  assert.equal(createQueryMatcher('  …  '), null)
})

test('the AI shortlist leads with profiles that have every word, including other word forms', async () => {
  let candidates
  const search = createSharedPeopleSearch({ readPublishedSnapshot: async () => snapshot(), complete: async ({ input, candidateIds }) => { candidates = JSON.parse(input).observations.map(value => value.fields.name); return { matches: [{ id: candidateIds[0], reason: 'fits' }] } } })
  const result = await search({ query: 'game investors' })
  assert.deepEqual(new Set(candidates.slice(0, 2)), new Set(['Cy Vance', 'Eli Park']))
  assert.ok(candidates.includes('Ana Ruiz') && candidates.includes('Ben Cho'))
  assert.equal(result.lexicalMatches, 5)
})

test('the People page offers both readings of a query and says when results are partial', () => {
  const best = renderPeople({ everyone: [], query: 'game investors', match: 'some' }).content
  assert.match(best, /<b aria-current="true">Best match<\/b> · <a href="\/network\?q=game%20investors&amp;mode=exact">Exact words<\/a>/)
  assert.match(best, /No one has every word\. Showing people who match some of them\./)
  assert.doesNotMatch(best, /name="mode"/)
  const exact = renderPeople({ everyone: [], query: 'game investors', mode: 'exact', nextCursor: 'n2' }).content
  assert.match(exact, /<a href="\/network\?q=game%20investors">Best match<\/a> · <b aria-current="true">Exact words<\/b>/)
  assert.match(exact, /<input type="hidden" name="mode" value="exact">/)
  assert.match(exact, /href="\/network\?q=game%20investors&amp;mode=exact&amp;cursor=n2">Show more/)
  assert.doesNotMatch(exact, /No one has every word/)
  assert.doesNotMatch(renderPeople({ everyone: [] }).content, /Best match|Exact words|name="mode"/)
  assert.doesNotMatch(renderPeople({ everyone: [], query: 'x', match: 'all' }).content, /No one has every word/)
})

test('the site and API accept mode, reject unknown or repeated modes, and search a member’s own people the same way', async t => {
  let handler
  const owner = { ownerId: 'test-owner', userId: 'test-user' }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', login: { begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://test.invalid', subject: 's', verifiedEmail: 't@example.invalid', displayName: 'T' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null }),
    readPublishedSnapshot: async () => snapshot() })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const api = await (await request('/api/people?q=game+investors')).json()
  assert.deepEqual(api.profiles.map(profile => profile.id), ['cy', 'eli']); assert.equal(api.match, 'all')
  assert.deepEqual((await (await request('/api/people?q=game+investors&mode=exact')).json()).profiles, [])
  assert.equal((await request('/api/people?q=game&mode=fuzzy')).status, 400)
  assert.equal((await request('/api/people?q=game&mode=best&mode=exact')).status, 400)
  const page = await (await request('/network?q=game+investors')).text()
  assert.match(page, /Results for “game investors”/); assert.match(page, /href="\/people\/cy">Cy Vance/); assert.doesNotMatch(page, /Ben Cho|Ana Ruiz/)
  const partial = await (await request('/people?q=riot+investor')).text()
  assert.match(partial, /No one has every word/); assert.match(partial, /Ben Cho/); assert.match(partial, /Ana Ruiz/)
  const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const member = await request('/network?q=game+investors&mode=exact', { headers: { Cookie: session } })
  assert.equal(member.status, 200); assert.match(await member.text(), /<input type="hidden" name="mode" value="exact">/)
  assert.equal((await request('/network?q=game&mode=fuzzy', { headers: { Cookie: session } })).status, 400)
})
