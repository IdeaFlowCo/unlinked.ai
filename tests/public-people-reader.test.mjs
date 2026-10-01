import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

const person = (id, name, company = 'Example') => ({ id, name, company, headline: 'Research', about: 'Published biography', positions: [{ title: '', company, email: 'private@example.test' }], education: [{ institution: 'College', phone: 'private-phone' }], skills: ['Research'], email: 'private@example.test', phone: 'private-phone', notes: 'private-notes', rawImport: 'private-archive' })
const published = () => ({ state: 'published', complete: true, revision: 'immutable-fence-1', profiles: [person('z', 'Zoë'), person('b', 'alice', 'Climate'), person('a', 'Alice', 'Energy')], connections: [{ fromId: 'z', toId: 'a' }, { fromId: 'z', toId: 'b' }] })
const unavailable = error => error.status === 503 && error.code === 'public_people_unavailable'
const invalid = error => error.status === 400 && error.code === 'public_people_input_invalid'

test('default missing/unpublished/incomplete/failed provider is 503, never an empty fixture directory', async () => {
  await assert.rejects(createPublicPeopleReader().list(), unavailable)
  for (const snapshot of [null, { ...published(), state: 'unavailable' }, { ...published(), complete: false }]) {
    const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
    await assert.rejects(reader.list(), unavailable)
    await assert.rejects(reader.profile({ id: 'unknown' }), unavailable)
  }
  await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => { throw Error('secret-backend-message') } }).list(), error => unavailable(error) && !error.message.includes('secret'))
})

test('stable normalized name/id ordering and query-bound pagination survives provider reorder', async () => {
  const source = published(), reader = createPublicPeopleReader({ readPublishedSnapshot: async () => source, pageSize: 1 })
  const first = await reader.list();assert.deepEqual(first.profiles.map(p => p.id), ['a'])
  source.profiles.reverse()
  const second = await reader.list({ cursor: first.nextCursor });assert.deepEqual(second.profiles.map(p => p.id), ['b'])
  const third = await reader.list({ cursor: second.nextCursor });assert.deepEqual(third.profiles.map(p => p.id), ['z']);assert.equal(third.nextCursor, undefined)
  assert.deepEqual((await reader.list({ query: 'ＡＬＩＣＥ climate' })).profiles.map(p => p.id), ['b'])
  await assert.rejects(reader.list({ query: 'alice', cursor: first.nextCursor }), invalid)
  source.revision = 'immutable-fence-2'
  await assert.rejects(reader.list({ cursor: first.nextCursor }), unavailable)
})

test('explicit DTO whitelist excludes contact details, notes, source archive and search-only company', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published() })
  const list = await reader.list(), detail = await reader.profile({ id: 'a' })
  assert.deepEqual(Object.keys(list.profiles[0]), ['id', 'name', 'headline'])
  assert.doesNotMatch(JSON.stringify({ list, detail }), /private@example|private-phone|private-notes|private-archive|rawImport/)
  assert.deepEqual(detail.profile.positions, [{ title: '', company: 'Energy' }])
  assert.deepEqual(detail.profile.education, [{ institution: 'College' }])
  assert.deepEqual(detail.profile.skills, ['Research'])
})

test('unknown public profile is null for HTTP404, empty published snapshot is ready, connections remain directed', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published(), pageSize: 1 })
  assert.equal(await reader.profile({ id: 'unknown' }), null)
  const first = await reader.profile({ id: 'z' });assert.deepEqual(first.profile.connections.map(p => p.id), ['a'])
  const second = await reader.profile({ id: 'z', cursor: first.profile.nextConnectionsCursor });assert.deepEqual(second.profile.connections.map(p => p.id), ['b'])
  assert.deepEqual((await reader.profile({ id: 'a' })).profile.connections, [])
  assert.deepEqual(await createPublicPeopleReader({ readPublishedSnapshot: async () => ({ ...published(), profiles: [], connections: [] }) }).list(), { profiles: [] })
})

test('snapshot limits, malformed DTOs, duplicate/dangling edges fail closed without truncation', async () => {
  for (const source of [{ ...published(), profiles: [person('a', 'A'), person('a', 'Duplicate')] }, { ...published(), connections: [{ fromId: 'a', toId: 'unknown' }] }, { ...published(), connections: [{ fromId: 'a', toId: 'b' }, { fromId: 'a', toId: 'b' }] }, { ...published(), profiles: [{ ...person('a', 'A'), skills: Array(501).fill('x') }] }]) await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => source }).list(), unavailable)
  for (const limits of [{ maxProfiles: 2 }, { maxConnections: 1 }, { maxTextBytes: 1 }]) await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => published(), ...limits }).list(), unavailable)
})

test('viewer authority comes only from immutable factory config, never query input', async () => {
  const viewer = Object.freeze({ memberId: 'server-resolved-member' });let seen
  const reader = createPublicPeopleReader({ viewer, readPublishedSnapshot: async input => { seen = input;return published() } })
  await reader.list({ viewer: { memberId: 'attacker' }, email: 'attacker@example.test' })
  assert.equal(seen.viewer, viewer)
  assert.equal(seen.maxProfiles, 20000);assert.equal(seen.maxConnections, 100000);assert.ok(seen.signal instanceof AbortSignal)
  assert.throws(() => createPublicPeopleReader({ viewer: { memberId: 'mutable' } }), /configuration_invalid/)
})

test('hanging provider and caller abort return bounded unavailable', async () => {
  const controller = new AbortController();controller.abort()
  const reader = createPublicPeopleReader({ timeoutMs: 10, readPublishedSnapshot: async () => new Promise(() => {}) })
  await assert.rejects(reader.list({ signal: controller.signal }), unavailable)
  await assert.rejects(reader.list(), unavailable)
})

test('malformed input cannot become authority or oversized backend query', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published() })
  await assert.rejects(reader.list({ query: 'x'.repeat(201) }), invalid)
  await assert.rejects(reader.profile({ id: '..' }), invalid)
  await assert.rejects(reader.list({ cursor: 'broken!' }), invalid)
  assert.throws(() => createPublicPeopleReader({ pageSize: 101 }), /configuration_invalid/)
})
