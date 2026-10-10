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
  assert.match(response.headers.get('cache-control'), /^no-store/)
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
  assert.match(TOP_BAR_SCRIPT, /\}, 100\)/)
  assert.match(TOP_BAR_SCRIPT, /omni-known/)
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

test('the prefix index finds exactly the people a full scan would, without scanning', async () => {
  const first = ['Ali', 'Alice', 'Allison', 'Alan', 'Jacob', 'Maya', 'Priya', 'Andrew'], last = ['Smith', 'Cole', 'Chen', 'Shah', 'Alder']
  const profiles = []
  for (let i = 0; i < 700; i++) profiles.push({ id: 'p' + i, name: first[i % first.length] + ' ' + last[Math.floor(i / 8) % last.length], headline: ['Investor at Alder Capital', 'Engineer at Acme', 'Alice fan club'][i % 3], about: 'Loves zebras', positions: [{ title: 'Engineer', company: ['Acme Labs', 'Alder Capital', 'Smithy'][i % 3], description: 'quokka' }], education: [], skills: ['Alchemy'] })
  const snapshot = { state: 'published', complete: true, revision: 'prefix-v1', profiles, connections: [] }
  const { buildSuggestIndex, suggestPeople, suggestTerms } = await import('../src/utils/public-people/suggest-index.mjs')
  const { wordForms } = await import('../src/utils/public-people/text-match.mjs')
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot, reuse: true })
  await reader.suggest({ query: 'al' })
  // Reference: every profile tested word by word with the documented rules.
  const reference = query => {
    const terms = suggestTerms(query)
    return profiles.filter(p => {
      const name = words(p.name), text = [...name, ...words([p.headline, ...p.positions.flatMap(x => [x.title, x.company]), ...p.skills].join(' '))]
      return terms.every((term, i) => wordForms(term).some(form => name.some(w => w === form || (form.length >= 2 && w.startsWith(form))) || text.some(w => w === form || (form.length >= 4 && w.startsWith(form))))
        || (i === terms.length - 1 && (name.some(w => w.startsWith(term)) || (term.length >= 2 && text.some(w => w.startsWith(term))))))
    }).map(p => p.id).sort()
  }
  const data = { ordered: [...profiles].map(p => ({ id: p.id, name: p.name, headline: p.headline })), details: new Map(profiles.map(p => [p.id, p])), companyList: [] }
  const index = buildSuggestIndex(data)
  for (const query of ['al', 'ali', 'alice', 'alice sm', 'smith', 'alder', 'jacob cole', 'jacob c', 'acme', 'engineer', 'engineers', 'al ch', 'priya zz', 'zebras', 'quokka', 'andrew an', 'investor alder', 'engineer ac', 'alder cap']) {
    assert.deepEqual(suggestPeople(index, data, query, { limit: 10000 }).map(p => p.id).sort(), reference(query), query)
  }
  // Free text outside the professional fields is left to the full search.
  assert.deepEqual((await reader.suggest({ query: 'zebras' })).people, [])
  // The last word completes from one letter: “jacob c” finds Jacob Cole/Chen.
  assert.ok((await reader.suggest({ query: 'jacob c' })).people.every(p => /^Jacob C/.test(p.name)))
  // Names with every word come first; leading name matches next.
  const top = (await reader.suggest({ query: 'alice' })).people
  assert.ok(top.every(p => p.name.startsWith('Alice')))
})

test('suggestions are one per person and mark people the member knows first', async () => {
  const profiles = [
    { id: 'shadow-roger', name: 'Roger Cole', headline: 'Founder', linkedinUrl: 'https://www.linkedin.com/in/roger-cole', positions: [], education: [], skills: [] },
    { id: 'member-roger', name: 'Roger Cole', headline: 'Founder at Sleep Intelligence', linkedinUrl: 'https://www.linkedin.com/in/roger-cole', positions: [], education: [], skills: [] },
    { id: 'other-roger', name: 'Roger Cole', headline: 'Chef', positions: [], education: [], skills: [] },
    { id: 'roger-colefax', name: 'Roger Colefax', headline: 'Pilot', positions: [], education: [], skills: [] },
  ]
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'known-v1', profiles, connections: [], members: ['member-roger'] }) })
  const anonymous = (await reader.suggest({ query: 'roger cole' })).people
  // Same LinkedIn address: one suggestion, the member. A namesake stays separate.
  assert.deepEqual(anonymous.map(p => p.id).slice(0, 2), ['member-roger', 'other-roger'])
  assert.equal(anonymous.filter(p => p.name === 'Roger Cole').length, 2)
  assert.ok(anonymous.every(p => p.known === undefined))
  const signedIn = (await reader.suggest({ query: 'roger col', known: new Set(['other-roger']) })).people
  assert.equal(signedIn[0].id, 'other-roger'); assert.equal(signedIn[0].known, true)
  assert.ok(signedIn.slice(1).every(p => !p.known))
  await assert.rejects(reader.suggest({ query: 'roger', known: ['other-roger'] }), { status: 400 })
})

test('a live-size index answers a keystroke in a few milliseconds', async () => {
  const first = ['Ali', 'Alice', 'Jacob', 'Maya', 'Priya', 'Roger', 'Sam', 'Lee', 'Noor', 'Omar'], last = ['Smith', 'Cole', 'Chen', 'Shah', 'Alder', 'Kim', 'Park', 'Garcia']
  const profiles = Array.from({ length: 25000 }, (_, i) => ({ id: 'p' + i, name: `${first[i % 10]} ${last[(i >> 3) % 8]}${i}`, headline: ['Investor at Alder Capital', 'Engineer at Acme', 'Founder'][i % 3], positions: [{ title: 'Engineer', company: 'Company ' + (i % 900) }], education: [], skills: ['React'] }))
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'size-v1', profiles, connections: [] }), reuse: true })
  await reader.suggest({ query: 'al' })
  const timings = []
  for (const query of ['al', 'ali', 'alice', 'alice sm', 'jacob cole', 'roger c', 'acme', 'company 12', 'engineer', 'founder', 'investor alder', 'react', 'zz']) {
    const started = performance.now(); await reader.suggest({ query }); timings.push(performance.now() - started)
  }
  timings.sort((a, b) => a - b)
  assert.ok(timings[Math.floor(timings.length / 2)] < 30, `median ${timings[Math.floor(timings.length / 2)]} ms`)
})

test('signed-in suggestions mark people the member knows, read off the keystroke path and kept per member', async t => {
  const { COMBINED_UPLOAD_CONSENT } = await import('../src/utils/private-import/consent.mjs')
  const owner = { ownerId: 'suggest-owner', userId: 'suggest-user' }
  const importId = 'e'.repeat(64), rowId = 'f'.repeat(64)
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: Date.UTC(2026, 0, 1), status: 'indexed', assertionIds: [rowId], counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    [rowId, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: rowId, ownerId: owner.ownerId, importId, category: 'connections', fields: { 'first name': 'Roger', 'last name': 'Cole', url: 'https://www.linkedin.com/in/roger-cole' } } }],
  ])
  const profiles = [
    { id: 'roger', name: 'Roger Cole', headline: 'Founder at Sleep Intelligence', linkedinUrl: 'https://www.linkedin.com/in/roger-cole', positions: [], education: [], skills: [] },
    { id: 'roger-namesake', name: 'Roger Cole', headline: 'Chef', positions: [], education: [], skills: [] },
  ]
  let networkReads = 0, handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test' }) }, resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'suggest-known', profiles, connections: [], members: ['roger', 'roger-namesake'] }),
    selfClaims: { lookupSlug: async slug => slug === 'roger-cole' ? 'roger' : null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    getBackend: async () => ({ adapter: {}, listImportIds: async () => { networkReads++; return [importId] }, listImportJobIds: async () => [], readResource: async (_, id) => structuredClone(resources.get(id) ?? null) }) })
  const go = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  // Anonymous: no marks, no private reads.
  assert.ok((await (await go('/search-suggestions?q=roger')).json()).people.every(p => !p.known))
  assert.equal(networkReads, 0)
  const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await go('/auth/callback/ideaflow?state=test&code=test', loginCookie)
  const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  networkReads = 0
  // The field's focus warm-up starts reading who the member knows; it answers nothing.
  const warm = await go('/search-suggestions?q=', cookie)
  assert.deepEqual(await warm.json(), { people: [], companies: [] })
  assert.equal(warm.headers.get('vary'), 'Cookie'); assert.match(warm.headers.get('cache-control'), /no-store/)
  for (let i = 0; i < 20 && networkReads === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 30))
  const people = (await (await go('/search-suggestions?q=roger+cole', cookie)).json()).people
  assert.deepEqual(people.map(p => [p.id, p.known === true]), [['roger', true], ['roger-namesake', false]])
  await go('/search-suggestions?q=roger+c', cookie)
  assert.equal(networkReads, 1, 'the known set is kept, not reread per keystroke')
})
