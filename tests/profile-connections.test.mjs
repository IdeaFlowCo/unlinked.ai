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
