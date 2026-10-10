import test from 'node:test'
import assert from 'node:assert/strict'
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
