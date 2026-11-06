import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnectionVisibility, connectionPrivacyValue, connectionPolicies, describeConnectionPrivacy, DEFAULT_CONNECTION_PRIVACY } from '../src/utils/public-people/connection-privacy.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'
import { createKnownConnectionsReader } from '../src/utils/public-people/known-connections.mjs'
import { createMemoryConnectionPrivacyStore } from '../mcp-server/connection-privacy-store.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { renderBringArchive, renderSettings } from '../mcp-server/private-onboarding-views.mjs'

// Graph (fictional people):
//   alice (member) listed bob, carol, vic   ·   vic listed dan   ·   eve listed carol
// So vic is alice's connection; dan is 2nd-degree to alice through vic;
// stranger is connected to nobody; carol is shared by alice and eve.
const person = id => ({ id, name: id[0].toUpperCase() + id.slice(1), positions: [], education: [], skills: [] })
const ids = ['alice', 'bob', 'carol', 'vic', 'dan', 'eve', 'stranger']
const edges = [['alice', 'bob'], ['alice', 'carol'], ['alice', 'vic'], ['vic', 'dan'], ['eve', 'carol'], ['dan', 'eve']]
const snapshot = connectionPrivacy => ({ state: 'published', complete: true, revision: 'privacy-test-' + JSON.stringify(connectionPrivacy ?? null).length, profiles: ids.map(person),
  connections: edges.map(([fromId, toId]) => ({ fromId, toId })), members: [...ids], legacyMembers: [], ...(connectionPrivacy ? { connectionPrivacy } : {}) })
const readerOver = value => createPublicPeopleReader({ readPublishedSnapshot: async () => structuredClone(value) })
const listOf = async (reader, id, viewer, extra = {}) => (await reader.profile({ id, ...(viewer ? { viewer } : {}), ...extra })).profile.connections.map(row => row.id).sort()
const as = id => ({ signedIn: true, id })

test('choices are validated; "Only you" drops the second choice; descriptions read plainly', () => {
  assert.deepEqual(connectionPrivacyValue({ audience: 'everyone', scope: 'all' }), DEFAULT_CONNECTION_PRIVACY)
  assert.deepEqual(connectionPrivacyValue({ audience: 'only_me', scope: 'shared' }), { audience: 'only_me', scope: 'all' })
  for (const bad of [null, {}, { audience: 'friends', scope: 'all' }, { audience: 'members', scope: 'some' }]) assert.equal(connectionPrivacyValue(bad), null)
  assert.throws(() => connectionPolicies({ alice: { audience: 'nope', scope: 'all' } }))
  assert.equal(describeConnectionPrivacy(DEFAULT_CONNECTION_PRIVACY), 'Anyone can see your connections.')
  assert.equal(describeConnectionPrivacy({ audience: 'connections', scope: 'shared' }), 'Your connections can see the connections you have in common with them.')
  assert.equal(describeConnectionPrivacy({ audience: 'only_me', scope: 'all' }), 'Only you can see your connections.')
})

test('default stays fully public, including counts', async () => {
  const reader = readerOver(snapshot())
  assert.deepEqual(await listOf(reader, 'alice'), ['bob', 'carol', 'vic'])
  assert.equal((await reader.list()).profiles.find(row => row.id === 'alice').connectionCount, 3)
})

test('each audience, viewed by: anonymous, a stranger, a 2nd-degree member, a connection and alice herself', async () => {
  const cases = {
    everyone: { anon: 3, stranger: 3, dan: 3, vic: 3 },
    members: { anon: 0, stranger: 3, dan: 3, vic: 3 },
    second_degree: { anon: 0, stranger: 0, dan: 3, vic: 3 },
    connections: { anon: 0, stranger: 0, dan: 0, vic: 3 },
    only_me: { anon: 0, stranger: 0, dan: 0, vic: 0 },
  }
  for (const [audience, expected] of Object.entries(cases)) {
    const reader = readerOver(snapshot({ alice: { audience, scope: 'all' } }))
    const seen = { anon: (await listOf(reader, 'alice')).length, stranger: (await listOf(reader, 'alice', as('stranger'))).length,
      dan: (await listOf(reader, 'alice', as('dan'))).length, vic: (await listOf(reader, 'alice', as('vic'))).length }
    assert.deepEqual(seen, expected, audience)
    assert.deepEqual(await listOf(reader, 'alice', as('alice')), ['bob', 'carol', 'vic'], audience + ': alice always sees her own')
    // Listing counts are what an anonymous visitor may see.
    assert.equal((await reader.list()).profiles.find(row => row.id === 'alice').connectionCount, expected.anon, audience)
  }
})

test('"shared" shows only connections the viewer listed too; a private known set never widens it', async () => {
  const reader = readerOver(snapshot({ alice: { audience: 'members', scope: 'shared' } }))
  // eve also has carol; vic is alice's connection himself and so sees himself only.
  assert.deepEqual(await listOf(reader, 'alice', as('eve')), ['carol'])
  assert.deepEqual(await listOf(reader, 'alice', as('vic')), ['vic'])
  assert.deepEqual(await listOf(reader, 'alice', as('stranger')), [])
  assert.deepEqual(await listOf(reader, 'alice', { signedIn: true }, { known: new Set(['bob']) }), [])
  assert.deepEqual(await listOf(reader, 'alice'), [])
})

test('the other end of a hidden connection hides it too, unless that person listed it publicly themselves', async () => {
  const reader = readerOver(snapshot({ alice: { audience: 'only_me', scope: 'all' } }))
  assert.deepEqual(await listOf(reader, 'bob'), [], 'bob is only connected through alice’s private list')
  assert.deepEqual(await listOf(reader, 'carol'), ['eve'], 'carol keeps eve’s public listing, not alice’s')
  assert.deepEqual(await listOf(reader, 'vic'), ['dan'])
  // vic's own listing of dan is public, and only alice's own pages show all of hers.
  assert.deepEqual(await listOf(reader, 'bob', as('alice')), ['alice'])
})

test('hover-card mutual counts and neighbors follow the same rule; cursors are bound to the viewer', async () => {
  const value = snapshot({ alice: { audience: 'connections', scope: 'all' } })
  const reader = readerOver(value)
  const known = new Set(['bob', 'carol'])
  assert.equal((await reader.card({ id: 'alice', known })).card.mutual, 0)
  assert.equal((await reader.card({ id: 'alice', known, viewer: as('vic') })).card.mutual, 2)
  assert.deepEqual((await reader.neighbors({ id: 'bob' })).map(row => row.id), [])
  assert.deepEqual((await reader.neighbors({ id: 'bob', viewer: as('alice') })).map(row => row.id), ['alice'])
  const paged = createPublicPeopleReader({ pageSize: 1, readPublishedSnapshot: async () => structuredClone(value) })
  const first = await paged.profile({ id: 'alice', viewer: as('vic') })
  assert.ok(first.profile.nextConnectionsCursor)
  await assert.rejects(paged.profile({ id: 'alice', viewer: as('dan'), cursor: first.profile.nextConnectionsCursor }), /public_people_input_invalid/)
  await assert.rejects(reader.profile({ id: 'alice', viewer: { signedIn: 'yes' } }), /public_people_input_invalid/)
})

test('visibility: a page shows a connection when its own choice allows it and someone who listed it allows it', () => {
  const connected = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]])
  const vis = (policies, listed) => createConnectionVisibility({ policies: new Map(Object.entries(policies)), connected, listedBy: (x, y) => listed.includes(`${x}>${y}`), viewer: null })
  // Both listed it: a's private page hides it, b's public page shows it.
  assert.equal(vis({ a: { audience: 'only_me', scope: 'all' } }, ['a>b', 'b>a']).visible('a', 'b'), false)
  assert.equal(vis({ a: { audience: 'only_me', scope: 'all' } }, ['a>b', 'b>a']).visible('b', 'a'), true)
  // Only private a listed it: hidden on b's page too.
  assert.equal(vis({ a: { audience: 'only_me', scope: 'all' } }, ['a>b']).visible('b', 'a'), false)
})

test('a self-made list never makes you someone’s connection or 2nd degree', async () => {
  // mallory uploads a file naming alice and everyone alice knows.
  const value = snapshot({ alice: { audience: 'connections', scope: 'shared' } })
  value.profiles.push(person('mallory'))
  value.connections.push(...['alice', 'bob', 'carol', 'vic'].map(toId => ({ fromId: 'mallory', toId })))
  value.members.push('mallory')
  const reader = readerOver(value)
  assert.deepEqual(await listOf(reader, 'alice', as('mallory')), [])
  const second = snapshot({ alice: { audience: 'second_degree', scope: 'all' } })
  second.profiles.push(person('mallory')); second.members.push('mallory')
  second.connections.push({ fromId: 'mallory', toId: 'vic' })
  assert.deepEqual(await listOf(readerOver(second), 'alice', as('mallory')), [], 'listing vic yourself is not being listed by vic')
  second.connections.push({ fromId: 'vic', toId: 'mallory' })
  assert.deepEqual(await listOf(readerOver(second), 'alice', as('mallory')), ['bob', 'carol', 'vic'], 'vic listing mallory is')
})

test('second-degree search for an agent skips people reachable only through a private list', async () => {
  const owner = { ownerId: 'owner-dan', userId: 'user-dan' }
  const getBackend = async () => ({ readLegacyProfile: async () => ({ profileId: 'eve', receiptId: 'r', revision: 1 }) })
  // eve listed carol; carol is listed by alice too. eve's 2nd degree goes through her own list only.
  const read = value => createKnownConnectionsReader({ owner, getBackend, readPublishedSnapshot: async () => value })
  const viaVic = { ...snapshot(), connections: [...snapshot().connections, { fromId: 'eve', toId: 'vic' }] }
  assert.deepEqual((await read(viaVic)({ degree: 2 })).profiles.map(row => row.id), ['dan'])
  assert.deepEqual((await read({ ...viaVic, connectionPrivacy: { vic: { audience: 'only_me', scope: 'all' } } })({ degree: 2 })).profiles.map(row => row.id), [])
  assert.deepEqual((await read({ ...viaVic, connectionPrivacy: { vic: { audience: 'connections', scope: 'all' } } })({ degree: 2 })).profiles.map(row => row.id), [], 'eve listing vic does not make her vic’s connection')
  const mutual = { ...viaVic, connections: [...viaVic.connections, { fromId: 'vic', toId: 'eve' }], connectionPrivacy: { vic: { audience: 'connections', scope: 'all' } } }
  assert.deepEqual((await read(mutual)({ degree: 2 })).profiles.map(row => row.id), ['dan'], 'vic listed eve')
})

test('the public index carries each account’s choice on its resolved profile and rebuilds when it changes', async () => {
  const id = 'a'.repeat(64), owner = { ownerId: 'bound-owner', userId: 'bound-user' }
  const job = { id, ownerId: owner.ownerId, archiveSha256: 'c'.repeat(64), consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: 2, indexed: 2 } }
  const assertions = [{ id: 'b'.repeat(64), importId: id, ownerId: owner.ownerId, category: 'profile', fields: { 'first name': 'Test', 'last name': 'Member' } },
    { id: 'd'.repeat(64), importId: id, ownerId: owner.ownerId, category: 'connections', subject: 'https://www.linkedin.com/in/someone', fields: { 'first name': 'Some', 'last name': 'One', 'email address': 'hidden@example.invalid' } }]
  const legacy = { state: 'published', complete: true, revision: 'legacy-v1', profiles: [person('legacy')], connections: [] }
  const store = createMemoryConnectionPrivacyStore()
  let clock = 0
  const read = createMemberPublicIndex({ freshMs: 60000, now: () => clock, readLegacy: async () => legacy, discover: async () => [{ id, owner, revision: 4 }], readConnectionPrivacy: () => store.list(),
    getBackend: async () => ({ readResource: async () => ({ sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: 4, payload: job }) }),
    publicPeople: { read: async dataset => ENRICHMENT_DATASETS.includes(dataset) ? null : projectPublicMemberImport({ job, assertions }), publish: async () => {} } })
  const open = await read()
  assert.equal(open.connectionPrivacy, undefined)
  await store.set(owner, { audience: 'connections', scope: 'shared' })
  await store.set({ ownerId: 'nobody', userId: 'nobody' }, { audience: 'only_me', scope: 'all' })
  assert.equal((await read()).revision, open.revision, 'kept build within the freshness window')
  read.invalidate()
  const closed = await read()
  assert.deepEqual(closed.connectionPrivacy, { ['member-import-' + id]: { audience: 'connections', scope: 'shared' } })
  assert.notEqual(open.revision, closed.revision)
  const reader = readerOver(closed)
  assert.deepEqual((await reader.profile({ id: 'member-import-' + id })).profile.connections, [])
  assert.ok(!JSON.stringify(closed).includes('hidden@example.invalid'))
  clock += 1
  await store.set(owner, DEFAULT_CONNECTION_PRIVACY)
  assert.deepEqual(await store.list(), [{ owner: { ownerId: 'nobody', userId: 'nobody' }, audience: 'only_me', scope: 'all' }])
})

test('import form puts the choice under an Advanced disclosure, preselected; Settings shows it and saves it', () => {
  const account = { accountLabel: 'Sam', displayName: 'Sam', csrf: 'x' }
  const none = renderBringArchive(account).content
  assert.doesNotMatch(none, /connectionsAudience/, 'no control without a readable stored choice')
  const form = renderBringArchive({ ...account, connectionPrivacy: { audience: 'second_degree', scope: 'shared' } }).content
  assert.match(form, /<details class="advanced" id="connection-privacy-advanced"><summary>Advanced: who can see your connections<\/summary>/)
  assert.doesNotMatch(form, /<details class="advanced" id="connection-privacy-advanced" open/)
  assert.match(form, /<option value="second_degree" selected>/)
  assert.match(form, /<option value="shared" selected>/)
  for (const value of ['everyone', 'members', 'second_degree', 'connections', 'only_me']) assert.match(form, new RegExp(`value="${value}"`))
  const settings = renderSettings({ ...account, connectionPrivacy: DEFAULT_CONNECTION_PRIVACY, connectionPrivacySaved: true }).content
  assert.match(settings, /id="connection-privacy"/)
  assert.match(settings, /Anyone can see your connections\./)
  assert.match(settings, /action="\/settings\/connection-privacy"/)
  assert.match(settings, /Saved\./)
})
