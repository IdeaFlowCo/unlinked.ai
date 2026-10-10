import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderLanding, renderJoin, renderPeople, TOP_BAR_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'
import { createQueryMatcher, rankMatches, words } from '../src/utils/public-people/text-match.mjs'

const person = (id, name, company = 'Acme Labs') => ({ id, name, headline: 'Climate engineer', positions: [{ title: 'Engineer', company }], education: [], skills: ['Research'], email: 'private@example.test', notes: 'private-note', company: 'Private search-only company' })
const published = () => ({ state: 'published', complete: true, revision: 'suggest-v1', profiles: [person('allison', 'Allison Smith'), person('alice', 'Alice Smith'), person('exact', 'Ali'), person('role', 'Zoe Investor', 'ACME LABS'), ...Array.from({ length: 8 }, (_, i) => person('extra-' + i, 'Alice ' + i, 'Acme ' + i))], connections: [] })

test('autocomplete ranks exact and prefix names, completes company names and bounds results', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published() })
  const result = await reader.suggest({ query: 'ＡＬＩ' })
  assert.equal(result.people[0].id, 'exact')
  assert.equal(result.people.length, 5)
  assert.ok(result.people.every(row => row.name.toLowerCase().startsWith('ali')))
  assert.equal((await reader.suggest({ query: 'climate engineer' })).people.length, 5)
  assert.deepEqual((await reader.suggest({ query: 'acme lab' })).companies, [{ name: 'Acme Labs' }])
  assert.equal((await reader.suggest({ query: 'acme' })).companies.length, 3)
  assert.deepEqual((await reader.suggest({ query: 'private search-only' })).companies, [])
  assert.doesNotMatch(JSON.stringify(result), /private@example|private-note|search-only/)
})

test('empty/short input does not load the directory; failed and revoked projections stay unavailable', async () => {
  let reads = 0, data = published()
  const source = async () => { reads++; return data }; source.revisionIdentifiesContent = true
  const reader = createPublicPeopleReader({ readPublishedSnapshot: source })
  for (const query of ['', ' ', 'a', '!!']) assert.deepEqual(await reader.suggest({ query }), { people: [], companies: [] })
  assert.equal(reads, 0)
  await reader.suggest({ query: 'ali' })
  data = { ...published(), revision: 'suggest-v2', profiles: [], connections: [] }
  assert.deepEqual(await reader.suggest({ query: 'ali' }), { people: [], companies: [] })
  data = null
  await assert.rejects(reader.suggest({ query: 'ali' }), { status: 503, message: 'public_people_unavailable' })
  await assert.rejects(reader.suggest({ query: 'x'.repeat(201) }), { status: 400 })
})

test('browser suggestions are public-only, uncached and reject malformed parameters', async t => {
  let handler, privateReads = 0, snapshots = 0
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  handler = createPrivateBrowserHandler({
    baseUrl: endpoint.replace('http:', 'https:'),
    login: { begin: async () => { throw Error('no login expected') }, finish: async () => {} },
    resolveOwner: async () => { privateReads++; throw Error('no owner expected') },
    getBackend: async () => { privateReads++; throw Error('no private reads') },
    readPublishedSnapshot: async () => { snapshots++; return published() },
  })
  const request = path => fetch(endpoint + path, { redirect: 'manual' })
  const response = await request('/search-suggestions?q=ali')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).people[0].name, 'Ali')
  assert.equal(snapshots, 1)
  for (const query of ['', '?q=ali&q=acme', '?q=ali&ownerId=other', '?q=' + 'x'.repeat(201)]) {
    assert.equal((await request('/search-suggestions' + query)).status, 400)
  }
  assert.equal(privateReads, 0)
  assert.equal(snapshots, 1)
  // An empty query (field focus) answers nothing and only warms a recent index.
  const warmed = await request('/search-suggestions?q=')
  assert.equal(warmed.status, 200)
  assert.deepEqual(await warmed.json(), { people: [], companies: [] })
  assert.equal(privateReads, 0)
  // The suggestion burst budget is separate from public page loads.
  for (let i = 0; i < 125; i++) assert.equal((await request('/search-suggestions?q=a')).status, 200)
  assert.equal((await request('/api/people?q=ali')).status, 200)
})

test('every header keeps native search and QR navigation with progressively enhanced autocomplete', () => {
  for (const view of [renderLanding(), renderJoin({ signedIn: true, accountLabel: 'owner@example.test', displayName: 'Owner', csrf: 'csrf-token' })]) {
    assert.match(view.content, /class="header-search" method="get" action="\/network" role="search"/)
    assert.match(view.content, /class="omni-panel" hidden/)
    assert.match(view.content, /id="omni-suggestions" role="listbox" aria-label="Search suggestions"/)
    assert.match(view.content, /class="scan" href="\/scan"/)
  }
  // The People directory's own live search owns that page; its header keeps only the QR link.
  const people = renderPeople({ accountLabel: 'owner@example.test', state: 'ready', query: '<script>', mode: 'exact' }).content
  assert.doesNotMatch(people, /class="omni-panel"/)
  assert.match(people, /class="scan" href="\/scan"/)
  assert.doesNotMatch(people, /value="<script>"/)
  assert.match(TOP_BAR_SCRIPT, /search-suggestions/)
  // Snappy and mobile-safe: short debounce, page-memory answers, focus warm-up,
  // no iOS autocorrect, and native filters carried into "See all results".
  assert.match(TOP_BAR_SCRIPT, /\}, 120\)/)
  assert.match(TOP_BAR_SCRIPT, /search-suggestions\?q='/)
  assert.match(TOP_BAR_SCRIPT, /autocorrect', 'off'/)
  assert.match(TOP_BAR_SCRIPT, /new FormData\(form\)/)
  new Function(TOP_BAR_SCRIPT)
})

test('the header field is at least 16px on phones so iOS does not zoom on focus', () => {
  const content = renderLanding().content
  assert.match(content, /@media\(max-width:900px\),\(pointer:coarse\)\{\.unlinked-onboarding \.header-search input\[type=search\]\{font-size:16px\}\}/)
  // The phone rule must come after the 15px desktop rule to win the cascade.
  assert.ok(content.indexOf('font-size:16px}}') > content.indexOf('border-radius:99px;font-size:15px'))
})

test('suggestions reuse a recent verified index, refresh it in the background and fail closed', async () => {
  let clock = 1000, reads = 0, data = published(), release
  const source = async () => { reads++; if (release) await new Promise(resolve => { release = resolve }); if (!data) throw Error('revoked'); return data }
  source.revisionIdentifiesContent = true
  const reader = createPublicPeopleReader({ readPublishedSnapshot: source, suggestFreshMs: 10000, suggestStaleMs: 60000, now: () => clock })
  assert.equal((await reader.suggest({ query: 'ali' })).people[0].id, 'exact')
  assert.equal(reads, 1)
  clock += 9999
  await reader.suggest({ query: 'alice' })
  assert.equal(reads, 1, 'fresh window answers from the kept index')
  // Stale: answered at once from the kept index while one read refreshes it.
  clock += 2; release = true
  data = { ...published(), revision: 'suggest-v2', profiles: [person('new', 'Ali New')] }
  assert.equal((await reader.suggest({ query: 'ali' })).people[0].id, 'exact')
  await reader.suggest({ query: 'ali' })
  assert.equal(reads, 2, 'a single background refresh')
  release(); release = null
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await reader.suggest({ query: 'ali' })).people[0].id, 'new')
  // A failed refresh drops the kept index; the next suggestion fails closed.
  clock += 20000; data = null
  await reader.suggest({ query: 'ali' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(reader.suggest({ query: 'ali' }), { status: 503 })
  // Past the stale bound a suggestion waits for a fresh read.
  data = published(); await reader.suggest({ query: 'ali' }); const before = reads
  clock += 60000
  await reader.suggest({ query: 'ali' })
  assert.equal(reads, before + 1)
  // Defaults keep every suggestion checking the source.
  let plainReads = 0
  const plainSource = async () => { plainReads++; return published() }
  const plainReader = createPublicPeopleReader({ readPublishedSnapshot: plainSource })
  await plainReader.suggest({ query: 'ali' }); await plainReader.suggest({ query: 'ali' })
  assert.equal(plainReads, 2)
  assert.throws(() => createPublicPeopleReader({ suggestFreshMs: 5, suggestStaleMs: 1 }), TypeError)
})

test('warm starts one background read and returns nothing', async () => {
  let reads = 0
  const source = async () => { reads++; return published() }
  const reader = createPublicPeopleReader({ readPublishedSnapshot: source, suggestFreshMs: 10000, suggestStaleMs: 60000 })
  assert.equal(reader.warm(), undefined)
  reader.warm()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
  reader.warm()
  await reader.suggest({ query: 'ali' })
  assert.equal(reads, 1)
})

test('the name-only shortcut returns exactly what the full ranking would', async () => {
  const first = ['Ali', 'Alice', 'Allison', 'Alan', 'Jacob', 'Maya', 'Priya'], last = ['Smith', 'Cole', 'Chen', 'Shah', 'Alder']
  const profiles = []
  for (let i = 0; i < 700; i++) profiles.push({ id: 'p' + i, name: first[i % first.length] + ' ' + last[Math.floor(i / 7) % last.length], headline: ['Investor at Alder Capital', 'Engineer at Acme', 'Alice fan club'][i % 3], positions: [{ title: 'Engineer', company: ['Acme Labs', 'Alder Capital', 'Smithy'][i % 3] }], education: [], skills: ['Alchemy'] })
  const snapshot = { state: 'published', complete: true, revision: 'shortcut-v1', profiles, connections: [] }
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
  const normalized = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  const ordered = [...profiles].sort((a, b) => normalized(a.name) < normalized(b.name) ? -1 : normalized(a.name) > normalized(b.name) ? 1 : a.id < b.id ? -1 : 1)
  const text = p => ({ name: words(p.name), text: words([p.name, p.headline, ...p.positions.flatMap(x => [x.title, x.company]), ...p.skills].join(' ')) })
  for (const query of ['al', 'ali', 'alice', 'alice sm', 'smith', 'alder', 'jacob cole', 'acme', 'engineer', 'al ch', 'priya zz']) {
    const search = normalized(query), matcher = createQueryMatcher(search)
    const priority = name => normalized(name) === search ? 2 : normalized(name).startsWith(search) ? 1 : 0
    const expected = rankMatches(ordered, matcher, text).rows.sort((a, b) => priority(b.name) - priority(a.name)).slice(0, 5).map(p => p.id)
    assert.deepEqual((await reader.suggest({ query })).people.map(p => p.id), expected, query)
  }
})
