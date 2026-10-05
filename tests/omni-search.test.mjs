import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderLanding, renderPeople, TOP_BAR_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'

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
  // The suggestion burst budget is separate from public page loads.
  for (let i = 0; i < 125; i++) assert.equal((await request('/search-suggestions?q=a')).status, 200)
  assert.equal((await request('/api/people?q=ali')).status, 200)
})

test('every header keeps native search and QR navigation with progressively enhanced autocomplete', () => {
  for (const view of [renderLanding(), renderPeople({ accountLabel: 'owner@example.test', state: 'ready', query: '<script>', mode: 'exact' })]) {
    assert.match(view.content, /class="header-search" method="get" action="\/network" role="search"/)
    assert.match(view.content, /class="omni-panel" hidden/)
    assert.match(view.content, /id="omni-suggestions" role="listbox" aria-label="Search suggestions"/)
    assert.match(view.content, /class="scan" href="\/scan"/)
    assert.doesNotMatch(view.content, /value="<script>"/)
  }
  assert.match(TOP_BAR_SCRIPT, /search-suggestions/)
})
