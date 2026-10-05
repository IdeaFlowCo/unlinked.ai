import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'

const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
// Two members and three shadows; names sort in id order.
const published = (extra = {}) => ({ state: 'published', complete: true, revision: 'presence-fixture-1', profiles: [person('a', 'Ada Member'), person('b', 'Bea Shadow'), person('c', 'Cy Member'), person('d', 'Di Shadow'), person('e', 'Ed Shadow')], connections: [{ fromId: 'a', toId: 'b' }], members: ['a', 'c'], ...extra })

test('the directory filters to members or shadows, binds the filter into the cursor, and rejects unknown values', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published(), pageSize: 2 })
  const members = await reader.list({ presence: 'member' })
  assert.deepEqual(members.profiles.map(value => value.id), ['a', 'c']); assert.equal(members.total, 2); assert.equal(members.nextCursor, undefined)
  const shadows = await reader.list({ presence: 'shadow' })
  assert.deepEqual(shadows.profiles.map(value => value.id), ['b', 'd']); assert.equal(shadows.total, 3)
  assert.deepEqual((await reader.list({ presence: 'shadow', cursor: shadows.nextCursor })).profiles.map(value => value.id), ['e'])
  // A cursor from one filter never pages another, or the unfiltered list.
  await assert.rejects(reader.list({ presence: 'member', cursor: shadows.nextCursor }), { status: 400 })
  await assert.rejects(reader.list({ cursor: shadows.nextCursor }), { status: 400 })
  const searched = await reader.list({ query: 'shadow', presence: 'shadow' })
  assert.deepEqual(searched.profiles.map(value => value.id), ['b', 'd']); assert.equal(searched.total, 3)
  assert.deepEqual((await reader.list({ query: 'member', presence: 'shadow' })).profiles.map(value => value.presence).filter(value => value !== 'shadow'), [])
  assert.equal((await reader.list()).total, undefined)
  for (const presence of ['invited', 'MEMBER', '', 1]) await assert.rejects(reader.list({ presence }), { status: 400 })
  // Without member data nothing has presence, so neither filter matches.
  assert.deepEqual((await createPublicPeopleReader({ readPublishedSnapshot: async () => published({ members: undefined }) }).list({ presence: 'member' })).profiles, [])
})

test('the filter control keeps the search and mode, marks the current choice, and explains an empty member list', () => {
  const content = renderPeople({ query: 'Ada & co', mode: 'exact', presence: 'member', everyone: [] }).content
  assert.match(content, /<a [^>]+aria-current="true">On Unlinked<\/a>/)
  assert.match(content, /<a href="\/network\?q=Ada%20%26%20co&amp;mode=exact">All<\/a>/)
  assert.match(content, /<a href="\/network\?q=Ada%20%26%20co&amp;mode=exact&amp;presence=shadow">Not yet on Unlinked<\/a>/)
  assert.match(content, /<h2>On Unlinked<\/h2>/); assert.match(content, /No one who joined matches that yet\. Most profiles here were imported/)
  assert.match(content, /href="\/network\?q=Ada%20%26%20co&amp;presence=member">Best match<\/a>/)
  const paged = renderPeople({ presence: 'shadow', everyone: [person('b', 'Bea Shadow')], nextCursor: 'next' }).content
  assert.match(paged, /href="\/network\?presence=shadow&amp;cursor=next">Show more/)
  const plain = renderPeople({ everyone: [person('a', 'Ada Member')] }).content
  assert.match(plain, /<a [^>]+aria-current="true">All<\/a>/); assert.match(plain, /<h2>Everyone on Unlinked<\/h2>/)
  assert.doesNotMatch(renderPeople({ own: [] }).content, /aria-label="Who to show"/)
})

test('anonymous People pages and the public API apply the filter; repeated or unknown values are 400', async t => {
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live', readPublishedSnapshot: async () => published(),
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => { throw Error('unused') } },
    resolveOwner: async () => null, signup: async () => null, getBackend: async () => { throw Error('unused') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  const get = path => fetch(endpoint + path, { redirect: 'manual' })
  const api = await (await get('/api/people?presence=member')).json()
  assert.deepEqual(api.profiles.map(value => [value.id, value.presence]), [['a', 'member'], ['c', 'member']]); assert.equal(api.total, 2)
  const page = await (await get('/people?presence=shadow')).text()
  assert.match(page, /<h2>Not yet on Unlinked<\/h2>/); assert.match(page, /Bea Shadow/); assert.doesNotMatch(page, /Ada Member/)
  for (const path of ['/api/people?presence=invited', '/api/people?presence=member&presence=shadow', '/people?presence=x']) assert.equal((await get(path)).status, 400, path)
})

test('agents can list members or shadows through the same filter, and unknown values fail validation', async () => {
  const service = createAccountToolService({ getBackend: async () => { throw Error('unused') }, readPublishedSnapshot: async () => published() })
  const grant = { ownerId: 'owner', userId: 'user', grantId: 'x'.repeat(64), scope: 'owner_network_and_public', version: 2, tools: ['unlinked_list_people'] }
  const result = (await service.call({ grant, name: 'unlinked_list_people', input: { presence: 'shadow' } })).result
  assert.deepEqual(result.profiles.map(value => value.id), ['b', 'd', 'e']); assert.equal(result.total, 3)
  await assert.rejects(service.call({ grant, name: 'unlinked_list_people', input: { presence: 'everyone' } }), error => error instanceof AccountToolError || /invalid/i.test(error.message))
})
