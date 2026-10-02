import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader, PublicPeopleReaderError } from '../src/utils/public-people/reader.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderCompany, renderPerson } from '../mcp-server/private-onboarding-views.mjs'
import { companyFacts } from '../mcp-server/company-metadata.mjs'

const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [
  { id: 'ann', name: 'Ann Example', headline: 'Founder at Goldman Sachs Entrepreneurs Network', positions: [], education: [], skills: [] },
  { id: 'jake', name: 'Jake Example', headline: 'Games Investing @ Alignment Growth', positions: [{ title: 'Managing Director', company: 'Alignment Growth' }, { title: 'Corporate Development', company: 'Riot Games' }], education: [], skills: [] },
  { id: 'max', name: 'Max Example', headline: 'Staff Software Engineer at Riot Games', positions: [], education: [], skills: [] },
  { id: 'near', name: 'Near Miss', headline: 'Potter at Riot of Colour', positions: [{ title: 'Potter', company: 'Games' }], education: [], skills: [] },
], connections: [] }
const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })

test('company reader matches the exact name phrase in positions and headlines, never a partial word overlap', async () => {
  const riot = await reader.company({ name: 'Riot Games' })
  assert.deepEqual(riot.people.map(person => person.id), ['jake', 'max'])
  assert.equal(riot.total, 2)
  const contained = await reader.company({ name: 'goldman sachs' })
  assert.deepEqual(contained.people.map(person => person.id), ['ann'])
  assert.equal((await reader.company({ name: 'Nowhere Co' })).total, 0)
  for (const name of ['', '   ', 'x'.repeat(201), 42]) await assert.rejects(reader.company({ name }), PublicPeopleReaderError)
})

test('company people page with a cursor and the cursor is scoped to the company', async () => {
  const paged = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot, pageSize: 1 })
  const first = await paged.company({ name: 'Riot Games' })
  assert.equal(first.people[0].id, 'jake'); assert.ok(first.nextCursor)
  const second = await paged.company({ name: 'Riot Games', cursor: first.nextCursor })
  assert.equal(second.people[0].id, 'max'); assert.equal(second.nextCursor, undefined)
  await assert.rejects(paged.company({ name: 'Goldman Sachs', cursor: first.nextCursor }), PublicPeopleReaderError)
})

test('reviewed company facts resolve by name or alias, return copies and never invent entries', () => {
  assert.equal(companyFacts('Smartcar, Inc.').name, 'Smartcar')
  assert.equal(companyFacts('riot games').name, 'Riot Games')
  assert.equal(companyFacts('Unknown Co'), null)
  const copy = companyFacts('Riot Games'); copy.name = 'changed'
  assert.equal(companyFacts('Riot Games').name, 'Riot Games')
})

test('company view escapes everything, shows facts when given, links members and has no scripts', () => {
  const plain = renderCompany({ name: 'Riot <Games>', people: [{ id: 'max', name: 'Max <b>', headline: 'Engineer' }], total: 1 })
  assert.ok(plain.content.includes('Riot &lt;Games&gt;')); assert.ok(!plain.content.includes('Riot <Games>'))
  assert.ok(plain.content.includes('href="/people/max"'))
  assert.doesNotMatch(plain.content, /<script|onclick=|javascript:/)
  const facts = { name: 'Riot Games', tagline: 'Play seriously', description: 'A games company.', industry: 'Computer Games', employeeCount: 8343, headquarters: 'Los Angeles, CA, US', founded: '2006', linkedinUrl: 'https://www.linkedin.com/company/riot-games/' }
  const rich = renderCompany({ name: 'Riot Games', facts, people: [], total: 0, nextCursor: 'cursor/next' })
  for (const copy of ['Play seriously', 'A games company.', '8,343 employees on LinkedIn', 'Founded 2006', 'LinkedIn page ↗', 'No one on Unlinked lists this company yet.']) assert.ok(rich.content.includes(copy), copy)
  assert.ok(rich.content.includes('href="/companies/Riot%20Games?cursor=cursor%2Fnext"'))
  assert.ok(!renderCompany({ name: 'X', facts: { ...facts, linkedinUrl: 'https://evil.test/' }, people: [], total: 0 }).content.includes('evil.test'))
})

test('profile experience links each company name to its company page', () => {
  const view = renderPerson({ profile: { id: 'jake', name: 'Jake Example', positions: [{ title: 'Director', company: 'Riot Games' }], education: [], skills: [], connections: [] } })
  assert.ok(view.content.includes('href="/companies/Riot%20Games"'))
})

test('anonymous company routes serve the page and JSON, and unknown names stay 404', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a' }) }, resolveOwner: async () => ({ ownerId: 'owner-a', userId: 'user-a' }), getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot })
  const page = await fetch(`${endpoint}/companies/Riot%20Games`)
  assert.equal(page.status, 200)
  const body = await page.text()
  assert.ok(body.includes('Riot Games')); assert.ok(body.includes('href="/people/jake"')); assert.ok(body.includes('href="/people/max"'))
  const api = await fetch(`${endpoint}/api/companies/Riot%20Games`)
  assert.equal(api.status, 200)
  const value = await api.json()
  assert.equal(value.company.total, 2); assert.equal(value.company.facts.name, 'Riot Games')
  const factsOnly = await fetch(`${endpoint}/companies/Smartcar`)
  assert.equal(factsOnly.status, 200); assert.ok((await factsOnly.text()).includes('No one on Unlinked lists this company yet.'))
  assert.equal((await fetch(`${endpoint}/companies/Unknown%20Co`)).status, 404)
  assert.equal((await fetch(`${endpoint}/companies/Riot%20Games?cursor=broken`)).status, 400)
})
