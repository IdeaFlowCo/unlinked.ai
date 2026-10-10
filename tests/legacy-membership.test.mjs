import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { renderPeople, renderPerson } from '../mcp-server/private-onboarding-views.mjs'

const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
const snapshot = { state: 'published', complete: true, revision: 'legacy-test-1', profiles: [person('old', 'Legacy Person'), person('active', 'Active Person'), person('contact', 'Imported Contact')], connections: [] }
const provider = ({ recovered = ['old', 'active'], claimed = ['active'], decisions = [] } = {}) => createMemberPublicIndex({
  readLegacy: async () => snapshot, discover: async () => [], publicPeople: { read: async () => null },
  readMembers: async () => claimed, readLegacyMembers: async () => recovered, readDecisions: async () => decisions,
})

test('recovered membership is distinct from login membership in profiles, suggestions and filters', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: provider() })
  assert.equal((await reader.profile({ id: 'old' })).profile.presence, 'legacy')
  assert.equal((await reader.profile({ id: 'active' })).profile.presence, 'member')
  assert.equal((await reader.profile({ id: 'contact' })).profile.presence, 'shadow')
  assert.deepEqual((await reader.list({ presence: 'legacy' })).profiles.map(x => x.id), ['old'])
  assert.deepEqual((await reader.list({ presence: 'member' })).profiles.map(x => x.id), ['active'])
  assert.deepEqual((await reader.list({ presence: 'shadow' })).profiles.map(x => x.id), ['contact'])
  assert.equal((await reader.suggest({ query: 'Legacy' })).people[0].presence, 'legacy')
})

test('legacy display evidence follows aliases and cannot create current account membership', async () => {
  const read = provider({ recovered: ['old'], claimed: [], decisions: [{ id: 'merge-old', kind: 'merge', profileId: 'old', survivorId: 'contact' }] })
  const projected = await read()
  assert.deepEqual(projected.members, [])
  assert.deepEqual(projected.legacyMembers, ['contact'])
  const reader = createPublicPeopleReader({ readPublishedSnapshot: read })
  assert.equal((await reader.profile({ id: 'contact' })).profile.presence, 'legacy')
  assert.deepEqual((await reader.list({ presence: 'member' })).profiles, [])
  await assert.rejects(provider({ recovered: ['unknown'] })(), /public_legacy_presence_invalid/)
})

test('claim and revocation change public state and invalidate old filtered cursors', async () => {
  let recovered = ['old', 'contact'], claimed = []
  const read = createMemberPublicIndex({ readLegacy: async () => snapshot, discover: async () => [], publicPeople: { read: async () => null }, readMembers: async () => claimed, readLegacyMembers: async () => recovered })
  const reader = createPublicPeopleReader({ readPublishedSnapshot: read, pageSize: 1 })
  const before = await reader.list({ presence: 'legacy' })
  assert.ok(before.nextCursor)
  claimed = ['old']; recovered = ['old']
  assert.equal((await reader.profile({ id: 'old' })).profile.presence, 'member')
  assert.equal((await reader.profile({ id: 'contact' })).profile.presence, 'shadow')
  await assert.rejects(reader.list({ presence: 'legacy', cursor: before.nextCursor }), { status: 503 })
})

test('legacy pages explain reclaiming without offering member-only messaging', () => {
  const profile = { ...person('old', 'Legacy Person'), presence: 'legacy', connections: [] }
  const page = renderPerson({ profile }).content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
  assert.match(page, /Legacy member · awaiting claim/)
  assert.match(page, /href="\/legacy-account">Sign in to reclaim it/)
  assert.doesNotMatch(page, /Not on Unlinked|messages\?profile|Invite to Unlinked/)
  const directory = renderPeople({ everyone: [profile], presence: 'legacy' }).content
  assert.match(directory, /aria-current="true">Legacy members/)
  assert.match(directory, /<h2>Legacy members<\/h2>/)
})

test('legacy presence reaches public HTTP, agent filtering, and the guarded reclaim entry', async t => {
  const readPublishedSnapshot = provider()
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  handler = createPrivateBrowserHandler({
    baseUrl: `https://127.0.0.1:${server.address().port}`, readPublishedSnapshot,
    login: { begin: async () => { throw Error('unexpected login') }, finish: async () => {} },
    resolveOwner: async () => null,
    getBackend: async () => { throw Error('unexpected private read') },
  })
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual', ...options })
  const response = await request('/api/people?presence=legacy')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).profiles.map(row => [row.id, row.presence]), [['old', 'legacy']])
  const suggestions = await (await request('/search-suggestions?q=Legacy')).json()
  assert.equal(suggestions.people[0].presence, 'legacy')
  const page = await (await request('/people?presence=legacy')).text()
  assert.match(page, /Legacy member · awaiting claim/)
  assert.doesNotMatch(page, /Active Person|Imported Contact/)
  const reclaim = await request('/legacy-account')
  assert.equal(reclaim.status, 401)
  assert.match(await reclaim.text(), /Sign in with Ideaflow/)
  assert.equal((await request('/legacy-account', { method: 'POST', headers: { Origin: `https://127.0.0.1:${server.address().port}` }, body: 'action=confirm' })).status, 401)
  const service = createAccountToolService({ readPublishedSnapshot, getBackend: async () => { throw Error('unexpected private read') } })
  const grant = { ownerId: 'owner', userId: 'user', grantId: 'x'.repeat(64), scope: 'owner_network_and_public', version: 2, tools: ['unlinked_list_people'] }
  const result = (await service.call({ grant, name: 'unlinked_list_people', input: { presence: 'legacy' } })).result
  assert.deepEqual(result.profiles.map(row => [row.id, row.presence]), [['old', 'legacy']])
})
