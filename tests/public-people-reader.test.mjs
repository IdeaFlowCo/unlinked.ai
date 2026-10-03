import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicPeopleReader, PublicPeopleReaderError } from '../src/utils/public-people/reader.mjs'

const person = (id, name, company = 'Example') => ({ id, name, company, headline: 'Research', about: 'Published biography', positions: [{ title: '', company, email: 'private@example.test' }], education: [{ institution: 'College', phone: 'private-phone' }], skills: ['Research'], email: 'private@example.test', phone: 'private-phone', notes: 'private-notes', rawImport: 'private-archive' })
const published = () => ({ state: 'published', complete: true, revision: 'immutable-fence-1', profiles: [{ ...person('z', 'Zoë'), headline: 'Graph systems researcher' }, person('b', 'alice', 'Climate'), person('a', 'Alice', 'Energy')], connections: [{ fromId: 'z', toId: 'a' }, { fromId: 'z', toId: 'b' }] })
const unavailable = error => error.status === 503 && error.code === 'public_people_unavailable'
const invalid = error => error.status === 400 && error.code === 'public_people_input_invalid'

test('default missing/unpublished/incomplete/failed provider is 503, never an empty fixture directory', async () => {
  await assert.rejects(createPublicPeopleReader().list(), unavailable)
  for (const snapshot of [null, { ...published(), state: 'unavailable' }, { ...published(), complete: false }]) {
    const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
    await assert.rejects(reader.list(), unavailable)
    await assert.rejects(reader.profile({ id: 'unknown' }), unavailable)
  }
  for (const failure of [Error('secret-backend-message'), new PublicPeopleReaderError(503, 'secret-backend-message'), new PublicPeopleReaderError(400, 'secret-backend-message')]) {
    const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => { throw failure } })
    for (const read of [() => reader.list(), () => reader.profile({ id: 'a' })]) await assert.rejects(read(), error => unavailable(error) && error.message === 'public_people_unavailable')
  }
})

test('stable normalized name/id ordering and query-bound pagination survives provider reorder', async () => {
  for (const revision of ['r', 'r'.repeat(128), '\u0000'.repeat(128)]) {
    const reader = createPublicPeopleReader({ pageSize: 1, readPublishedSnapshot: async () => ({ ...published(), revision }) })
    const first = await reader.list()
    assert.ok(first.nextCursor.length <= 2048)
    const second = await reader.list({ cursor: first.nextCursor })
    const third = await reader.list({ cursor: second.nextCursor })
    assert.deepEqual([...first.profiles, ...second.profiles, ...third.profiles].map(profile => profile.id), ['a', 'b', 'z'])
    const connectionPage = await reader.profile({ id: 'z' })
    assert.ok(connectionPage.profile.nextConnectionsCursor.length <= 2048)
    const next = await reader.profile({ id: 'z', cursor: connectionPage.profile.nextConnectionsCursor })
    assert.deepEqual(next.profile.connections.map(profile => profile.id), ['b'])
  }
  const source = published(), reader = createPublicPeopleReader({ readPublishedSnapshot: async () => source, pageSize: 1 })
  const first = await reader.list();assert.deepEqual(first.profiles.map(p => p.id), ['a'])
  source.profiles.reverse()
  const second = await reader.list({ cursor: first.nextCursor });assert.deepEqual(second.profiles.map(p => p.id), ['b'])
  const third = await reader.list({ cursor: second.nextCursor });assert.deepEqual(third.profiles.map(p => p.id), ['z']);assert.equal(third.nextCursor, undefined)
  assert.deepEqual((await reader.list({ query: 'ＡＬＩＣＥ climate' })).profiles.map(p => p.id), ['b'])
  assert.deepEqual((await reader.list({ query: 'Graph' })).profiles.map(p => p.id), ['z'])
  await assert.rejects(reader.list({ query: 'alice', cursor: first.nextCursor }), invalid)
  const connectionPage = await reader.profile({ id: 'z' })
  source.revision = 'immutable-fence-2'
  source.connections = []
  await assert.rejects(reader.profile({ id: 'z', cursor: connectionPage.profile.nextConnectionsCursor }), unavailable)
  source.profiles = []
  await assert.rejects(reader.profile({ id: 'z', cursor: connectionPage.profile.nextConnectionsCursor }), unavailable)
  await assert.rejects(reader.list({ cursor: second.nextCursor }), unavailable)
})

test('explicit DTO whitelist excludes contact details, notes, source archive and search-only company', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published() })
  const list = await reader.list(), detail = await reader.profile({ id: 'a' })
  assert.deepEqual(Object.keys(list.profiles[0]), ['id', 'name', 'headline', 'detailLevel'])
  assert.doesNotMatch(JSON.stringify({ list, detail }), /private@example|private-phone|private-notes|private-archive|rawImport/)
  assert.deepEqual(detail.profile.positions, [{ title: '', company: 'Energy' }])
  assert.deepEqual(detail.profile.education, [{ institution: 'College' }])
  assert.deepEqual(detail.profile.skills, ['Research'])
})

test('unknown public profile is null for HTTP404, empty published snapshot is ready, connections show from both ends', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published(), pageSize: 1 })
  assert.equal(await reader.profile({ id: 'unknown' }), null)
  const first = await reader.profile({ id: 'z' });assert.deepEqual(first.profile.connections.map(p => p.id), ['a'])
  const second = await reader.profile({ id: 'z', cursor: first.profile.nextConnectionsCursor });assert.deepEqual(second.profile.connections.map(p => p.id), ['b'])
  assert.deepEqual((await reader.profile({ id: 'a' })).profile.connections.map(p => p.id), ['z'])
  assert.deepEqual(await createPublicPeopleReader({ readPublishedSnapshot: async () => ({ ...published(), profiles: [], connections: [] }) }).list(), { profiles: [] })
})

test('snapshot limits, malformed DTOs, duplicate/dangling edges fail closed without truncation', async () => {
  for (const source of [{ ...published(), profiles: [person('a', 'A'), person('a', 'Duplicate')] }, { ...published(), connections: [{ fromId: 'a', toId: 'unknown' }] }, { ...published(), connections: [{ fromId: 'a', toId: 'b' }, { fromId: 'a', toId: 'b' }] }, { ...published(), profiles: [{ ...person('a', 'A'), skills: Array(501).fill('x') }] }]) await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => source }).list(), unavailable)
  for (const revision of [undefined, null, 123, '', 'r'.repeat(129), '界', '界'.repeat(512)]) {
    const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ ...published(), revision }) })
    for (const read of [() => reader.list(), () => reader.profile({ id: 'z' })]) await assert.rejects(read(), error => unavailable(error) && error.message === 'public_people_unavailable')
  }
  for (const field of ['positions', 'education', 'skills']) {
    for (const inherited of [false, true]) {
      const entries = Array(1)
      if (inherited) {
        const prototype = Object.create(Array.prototype)
        prototype[0] = person('a', 'A')[field][0]
        Object.setPrototypeOf(entries, prototype)
      }
      const source = { ...published(), profiles: [{ ...person('a', 'A'), [field]: entries }], connections: [] }
      await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => source }).list(), unavailable)
    }
  }
  for (const limits of [{ maxProfiles: 2 }, { maxConnections: 1 }, { maxTextBytes: 1 }]) await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => published(), ...limits }).list(), unavailable)
})

test('viewer authority comes only from immutable factory config, never query input', async () => {
  const viewer = Object.freeze({ identity: Object.freeze({ memberId: 'server-resolved-member', roles: Object.freeze(['reader']) }) });let seen
  const reader = createPublicPeopleReader({ viewer, readPublishedSnapshot: async input => { seen = input;return published() } })
  await reader.list({ viewer: { memberId: 'attacker' }, email: 'attacker@example.test' })
  assert.equal(seen.viewer, viewer)
  assert.equal(seen.maxProfiles, 20000);assert.equal(seen.maxConnections, 100000);assert.ok(seen.signal instanceof AbortSignal)
  assert.throws(() => createPublicPeopleReader({ viewer: { memberId: 'mutable' } }), /configuration_invalid/)
  const nested = { memberId: 'A' }
  assert.throws(() => createPublicPeopleReader({ viewer: Object.freeze({ identity: nested }) }), /configuration_invalid/)
  const cyclic = {};cyclic.identity = cyclic;Object.freeze(cyclic)
  let getterCalls = 0
  const accessor = Object.freeze({ get memberId() { getterCalls++;return 'A' } })
  for (const identity of [cyclic, accessor, Object.freeze({ identity: new Map() })]) assert.throws(() => createPublicPeopleReader({ viewer: identity }), /configuration_invalid/)
  assert.equal(getterCalls, 0)
  await assert.rejects(reader.list({ viewer: nested, cursor: 'broken!' }), invalid)
  await reader.list()
  assert.equal(seen.viewer.identity.memberId, 'server-resolved-member')
})

test('hanging provider and caller abort return bounded unavailable', async () => {
  const controller = new AbortController();controller.abort()
  const reader = createPublicPeopleReader({ timeoutMs: 10, readPublishedSnapshot: async () => new Promise(() => {}) })
  await assert.rejects(reader.list({ signal: controller.signal }), unavailable)
  await assert.rejects(reader.list(), unavailable)
})

test('malformed input cannot become authority or oversized backend query', async () => {
  let reads = 0
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => { reads++;return published() } })
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const first = await createPublicPeopleReader({ pageSize: 1, readPublishedSnapshot: async () => published() }).list()
  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
  for (const request of [null, [], 'request', new Date(), { signal: {} }, { get query() { throw Error('secret') } }]) {
    await assert.rejects(reader.list(request), invalid)
    await assert.rejects(reader.profile(request), invalid)
  }
  for (const cursor of ['broken!', encode({ ...decoded, revision: 4 }), encode({ ...decoded, revision: '' }), encode({ ...decoded, revision: null }), encode({ ...decoded, revision: 'r'.repeat(129) }), encode({ ...decoded, revision: '界' }), encode({ ...decoded, scope: 'wrong' })]) {
    await assert.rejects(reader.list({ cursor }), invalid)
    await assert.rejects(reader.profile({ id: 'unknown', cursor }), invalid)
    await assert.rejects(createPublicPeopleReader().list({ cursor }), invalid)
  }
  await assert.rejects(reader.profile({ id: 'unknown', cursor: first.nextCursor }), invalid)
  await assert.rejects(reader.list({ query: 'x'.repeat(201) }), invalid)
  await assert.rejects(reader.profile({ id: '..' }), invalid)
  await assert.rejects(reader.list({ cursor: 'broken!' }), invalid)
  assert.equal(reads, 0)
  assert.throws(() => createPublicPeopleReader({ pageSize: 101 }), /configuration_invalid/)
})

test('a connection listed by both people appears once on each profile', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ ...published(), connections: [{ fromId: 'z', toId: 'a' }, { fromId: 'a', toId: 'z' }, { fromId: 'b', toId: 'a' }] }) })
  assert.deepEqual((await reader.profile({ id: 'a' })).profile.connections.map(p => p.id), ['b', 'z'])
  assert.deepEqual((await reader.profile({ id: 'z' })).profile.connections.map(p => p.id), ['a'])
})
