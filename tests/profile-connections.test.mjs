import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { profileDetailLevel, companyDetailLevel } from '../src/utils/public-people/detail-level.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = () => ({ state: 'published', complete: true, revision: 'connection-depth-v1', members: ['owner', 'basic'], profiles: [person('owner', 'Owner'), person('basic', 'Aaron Basic', { headline: 'Engineer', positions: [{ title: 'Engineer', company: 'Unknown Co' }] }), person('rich', 'Zoe Detailed', { about: 'Climate engineer' }), person('other', 'Outside Person', { about: 'Climate engineer' })], connections: [{ fromId: 'owner', toId: 'basic' }, { fromId: 'rich', toId: 'owner' }] })

test('content depth counts meaningful details, never membership, reach, photos or empty arrays', () => {
  assert.equal(profileDetailLevel(person('x', 'X', { presence: 'member', connectionCount: 900, headline: 'Engineer', photo: '/photo', positions: [{ title: 'Engineer', company: 'Co' }], education: [{ institution: ' ' }], skills: [' '] })), 'basic')
  for (const extra of [{ about: 'Bio' }, { skills: ['Design'] }, { education: [{ institution: 'College' }] }, { positions: [{ title: 'Lead', company: 'Co', startDate: '2020' }] }, { positions: [{ title: 'Lead' }, { title: 'Designer' }] }]) assert.equal(profileDetailLevel(person('x', 'X', extra)), 'detailed')
  assert.equal(companyDetailLevel({ name: 'Co', description: ' ' }), 'basic')
  assert.equal(companyDetailLevel({ name: 'Co', industry: 'Design' }), 'detailed')
})

test('detail order applies before pagination, search stays within the person’s connections and cursors bind to both', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot(), pageSize: 1 })
  const first = await reader.profile({ id: 'owner', sort: 'detail' })
  assert.equal(first.profile.connectionCount, 2)
  assert.equal(first.profile.connections[0].id, 'rich')
  assert.equal(first.profile.connections[0].presence, 'shadow')
  const next = await reader.profile({ id: 'owner', sort: 'detail', cursor: first.profile.nextConnectionsCursor })
  assert.equal(next.profile.connections[0].id, 'basic'); assert.equal(next.profile.nextConnectionsCursor, undefined)
  assert.equal((await reader.profile({ id: 'owner', sort: 'name' })).profile.connections[0].id, 'basic')
  await assert.rejects(reader.profile({ id: 'owner', sort: 'name', cursor: first.profile.nextConnectionsCursor }), { status: 400 })
  await assert.rejects(reader.profile({ id: 'owner', sort: 'detail', query: 'engineer', cursor: first.profile.nextConnectionsCursor }), { status: 400 })
  const searched = await reader.profile({ id: 'owner', query: 'climate engineer', sort: 'detail' })
  assert.deepEqual(searched.profile.connections.map(value => value.id), ['rich']); assert.equal(searched.profile.connectionsTotal, 1)
  assert.equal((await reader.profile({ id: 'owner', query: 'outside' })).profile.connectionsTotal, 0)
  await assert.rejects(reader.profile({ id: 'owner', sort: 'invalid' }), { status: 400 })
})

test('anonymous connections browser works with native GET forms, and people/company stubs have accessible cues', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({}), finish: async () => ({}) }, resolveOwner: async () => null, getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot() })
  const response = await fetch(`${endpoint}/people/owner/connections`)
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.ok(body.indexOf('href="/people/rich"') < body.indexOf('href="/people/basic"'))
  assert.match(body, /method="get" action="\/people\/owner\/connections"/)
  assert.match(body, /More detail first/); assert.match(body, /Name A–Z/)
  assert.match(body, /sr-only"> Basic profile/)
  const searched = await fetch(`${endpoint}/people/owner/connections?q=outside&sort=name`)
  assert.match(await searched.text(), /No connections match this search/)
  const basic = await (await fetch(`${endpoint}/people/basic`)).text()
  assert.match(basic, /Basic profile · Additional details/)
  assert.match(basic, /href="\/companies\/Unknown%20Co".*Basic company page/s)
  const company = await (await fetch(`${endpoint}/companies/Unknown%20Co`)).text()
  assert.match(company, /Basic company page · Company details/)
  assert.equal((await fetch(`${endpoint}/people/owner/connections?sort=bad`)).status, 400)
  assert.equal((await fetch(`${endpoint}/people/owner/connections?sort=name&sort=detail`)).status, 400)
})

test('a person’s connections narrow to members or to people the viewer knows, with counts within the search and cursors bound to the narrowing', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot(), pageSize: 1 })
  const known = new Set(['rich'])
  const all = await reader.profile({ id: 'owner', sort: 'detail', known })
  assert.deepEqual(all.profile.connectionFacets, { all: 2, members: 1, known: 1 })
  assert.equal(all.profile.connectionCount, 2)
  const members = await reader.profile({ id: 'owner', sort: 'detail', show: 'members' })
  assert.deepEqual(members.profile.connections.map(value => value.id), ['basic']); assert.equal(members.profile.connectionsTotal, 1); assert.equal(members.profile.connectionCount, 2)
  const mutual = await reader.profile({ id: 'owner', sort: 'detail', show: 'known', known })
  assert.deepEqual(mutual.profile.connections.map(value => value.id), ['rich'])
  assert.deepEqual((await reader.profile({ id: 'owner', query: 'engineer', known })).profile.connectionFacets, { all: 2, members: 1, known: 1 })
  assert.deepEqual((await reader.profile({ id: 'owner', query: 'climate', known })).profile.connectionFacets, { all: 1, members: 0, known: 1 })
  // A cursor from one narrowing never pages another, or another viewer's set.
  await assert.rejects(reader.profile({ id: 'owner', sort: 'detail', cursor: all.profile.nextConnectionsCursor, show: 'members' }), { status: 400 })
  const twoKnown = await reader.profile({ id: 'owner', sort: 'detail', show: 'known', known: new Set(['rich', 'basic']) })
  await assert.rejects(reader.profile({ id: 'owner', sort: 'detail', show: 'known', known: new Set(['basic', 'other']), cursor: twoKnown.profile.nextConnectionsCursor }), { status: 400 })
  await assert.rejects(reader.profile({ id: 'owner', show: 'known' }), { status: 400 })
  await assert.rejects(reader.profile({ id: 'owner', show: 'everyone' }), { status: 400 })
  await assert.rejects(reader.profile({ id: 'owner', known: ['rich'] }), { status: 400 })
})

test('the profile sidebar filters with a native form and links, offers "You both know" only to a signed-in viewer, and keeps the narrowing into the full list', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({}), finish: async () => ({}) }, resolveOwner: async () => null, getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot() })
  const page = await (await fetch(`${endpoint}/people/owner`)).text()
  assert.match(page, /data-profile-connections/)
  assert.match(page, /<form class="pconn-filter" method="get" action="\/people\/owner#connections" role="search">.*id="pconn-q" name="q"/s)
  assert.match(page, /<nav class="network-segments pconn-shows"[^>]*><a href="\/people\/owner#connections" aria-current="true">All <span>2<\/span><\/a><a href="\/people\/owner\?show=members#connections">On Unlinked <span>1<\/span><\/a><\/nav>/)
  assert.doesNotMatch(page, /You both know/)
  assert.match(page, /data-profile-connections.*pconn-q.*<script nonce="[^"]+">.*\[data-profile-connections\]/s)
  const members = await (await fetch(`${endpoint}/people/owner?show=members`)).text()
  assert.match(members, /href="\/people\/basic"/); assert.doesNotMatch(members, /class="crow" href="\/people\/rich"/)
  assert.match(members, /1 match · <a href="\/people\/owner#connections">Clear<\/a>/)
  assert.match(members, /href="\/people\/owner\?show=members#connections" aria-current="true"/)
  assert.match(members, /href="\/people\/owner\/connections\?show=members">Open the full list →/)
  const searched = await (await fetch(`${endpoint}/people/owner?q=nobody`)).text()
  assert.match(searched, /0 matches for “nobody”/); assert.match(searched, /No connections match\./)
  assert.match(searched, /value="nobody"/)
  // Signed out, "You both know" quietly falls back to everyone.
  const signedOut = await (await fetch(`${endpoint}/people/owner?show=known`)).text()
  assert.match(signedOut, /href="\/people\/owner#connections" aria-current="true">All/)
  const full = await (await fetch(`${endpoint}/people/owner/connections?show=members`)).text()
  assert.match(full, /<input type="hidden" name="show" value="members">/)
  assert.match(full, /href="\/people\/owner\/connections\?show=members" aria-current="true">On Unlinked/)
  assert.doesNotMatch(full, /class="person".*href="\/people\/rich"/s)
  assert.equal((await fetch(`${endpoint}/people/owner?show=everyone`)).status, 400)
  assert.equal((await fetch(`${endpoint}/people/owner?show=members&show=known`)).status, 400)
})

test('removing a connection sits behind the “…” menu, never beside Connected', async () => {
  const { renderPerson } = await import('../mcp-server/private-onboarding-views.mjs')
  const view = renderPerson({ csrf: 'c'.repeat(43), accountLabel: 'Me', profile: { id: 'p1', name: 'Ada Lovelace', positions: [], education: [], skills: [], connections: [] }, connect: { state: 'connected', requestId: 'r1' } })
  assert.match(view.content, /✓ Connected<\/span>(?:(?!more-actions).)*<details class="more-actions profile-more"><summary aria-label="More actions for Ada Lovelace" title="More"><svg/s)
  // The same menu carries Report (and Block / Request removal where they apply; docs/report-and-block.md).
  assert.match(view.content, /<div class="more-panel">.*action="\/connections\/remove".*>Remove connection<\/button><\/form><p class="more-links"><a href="\/people\/p1\/report">Report Ada Lovelace<\/a><\/p><\/div><\/details>/s)
  assert.doesNotMatch(view.content, /Remove connection…|Confirm removal/)
})

test('a hover card is the public summary; only a signed-in viewer’s known set adds a mutual count', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot() })
  const plain = await reader.card({ id: 'owner' })
  assert.equal(plain.card.name, 'Owner'); assert.equal(plain.card.presence, 'member'); assert.equal(plain.card.connectionCount, 2)
  assert.equal('mutual' in plain.card, false)
  assert.equal((await reader.card({ id: 'owner', known: new Set(['rich', 'other']) })).card.mutual, 1)
  assert.equal(await reader.card({ id: 'missing' }), null)
  await assert.rejects(reader.card({ id: 'owner', known: ['rich'] }), { status: 400 })
})

test('the hover card endpoint answers signed-out visitors with public facts only, and has a strict input', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({}), finish: async () => ({}) }, resolveOwner: async () => null, getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot() })
  const response = await fetch(`${endpoint}/api/people/owner/card`)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store, private')
  const { card } = await response.json()
  assert.equal(card.name, 'Owner')
  for (const key of ['mutual', 'relation', 'message']) assert.equal(key in card, false)
  assert.equal((await fetch(`${endpoint}/api/people/missing/card`)).status, 404)
  assert.equal((await fetch(`${endpoint}/api/people/owner/card?x=1`)).status, 400)
  const page = await (await fetch(`${endpoint}/people/owner`)).text()
  assert.match(page, /\/api\/people\/'\+encodeURIComponent\(id\)\+'\/card'/)
})
