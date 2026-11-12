import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { PROFESSIONAL_PEOPLE_DATASET, prepareProfessionalSnapshot, professionalProfileId } from '../src/utils/public-people/professional-profiles.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createMemoryProfileHandleStore, createProfileHandles } from '../mcp-server/profile-handles.mjs'
import { profilePath, setProfileHandleLookup } from '../src/utils/public-people/profile-handles.mjs'

const linkedinUrl = 'https://www.linkedin.com/in/ada-fictional'
const professionalId = professionalProfileId(linkedinUrl)
const person = (id, extra = {}) => ({ id, name: 'Ada Fictional', linkedinUrl, positions: [], education: [], skills: [], ...extra })
const publication = () => prepareProfessionalSnapshot(Buffer.from(JSON.stringify([person(professionalId, { about: 'Public biography', company: 'Public Company' })])))

function setup({ profiles = [], decisions = [], members = [], verified = [], preferSurvivor } = {}) {
  const state = { profiles, decisions, publication: publication() }
  const read = createMemberPublicIndex({
    readLegacy: async () => ({ state: 'published', complete: true, revision: 'legacy:identity', profiles: state.profiles, connections: [] }),
    discover: async () => [],
    getBackend: async () => { throw Error('unexpected account access') },
    readDecisions: async () => state.decisions,
    readMembers: async () => members,
    readLegacyMembers: async () => verified,
    publicPeople: { read: async dataset => dataset === PROFESSIONAL_PEOPLE_DATASET ? state.publication : null },
    professionalProfiles: true, mergeSameLinkedin: true, preferSurvivor,
  })
  return { state, read, reader: createPublicPeopleReader({ readPublishedSnapshot: read }) }
}

test('professional copies fold into existing imports without changing source IDs', async () => {
  const { state, read, reader } = setup({ profiles: [person('public-A')] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['public-A'])
  assert.equal(snapshot.profiles[0].about, 'Public biography')
  assert.deepEqual(await reader.profile({ id: professionalId }), { moved: 'public-A' })
  assert.deepEqual((await reader.list({})).profiles.map(row => row.id), ['public-A'])
  assert.equal(state.publication.profiles[0].id, professionalId)
  state.publication = null
  const revoked = await read()
  assert.deepEqual(revoked.profiles.map(row => row.id), ['public-A'])
  assert.equal(revoked.profiles[0].about, undefined)
  assert.equal(await reader.profile({ id: professionalId }), null)
})

test('the imported copy holding a readable handle remains the survivor', async t => {
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await handles.initialize()
  await handles.ensure(person('public-B'))
  setProfileHandleLookup(id => handles.handleFor(id))
  t.after(() => setProfileHandleLookup(null))
  const { read, reader } = setup({ profiles: [person('public-A'), person('public-B')], preferSurvivor: ids => ids.find(id => handles.handleFor(id)) })
  assert.deepEqual((await read()).profiles.map(row => row.id), ['public-B'])
  assert.deepEqual(await reader.profile({ id: professionalId }), { moved: 'public-B' })
  assert.deepEqual(await reader.profile({ id: 'public-A' }), { moved: 'public-B' })
  assert.equal(profilePath('public-B'), '/people/ada-fictional')
  assert.equal(handles.resolve('ada-fictional').profileId, 'public-B')
  const withLegacy = setup({ profiles: [person('legacy-A'), person('public-B')], preferSurvivor: ids => ids.find(id => handles.handleFor(id)) })
  assert.deepEqual((await withLegacy.read()).profiles.map(row => row.id), ['public-B'])
})

test('legacy survivors absorb professional and imported copies, retaining their fields', async () => {
  const { read, reader } = setup({ profiles: [person('legacy-A', { about: 'Existing biography' }), person('public-A')] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['legacy-A'])
  assert.equal(snapshot.profiles[0].about, 'Existing biography')
  assert.deepEqual(await reader.profile({ id: professionalId }), { moved: 'legacy-A' })
  assert.deepEqual(await reader.profile({ id: 'public-A' }), { moved: 'legacy-A' })
})

test('explicit legacy merges carry their old LinkedIn identity to the named survivor', async () => {
  const { state, read, reader } = setup({ profiles: [person('legacy-old'), person('legacy-survivor', { linkedinUrl: 'https://www.linkedin.com/in/ada-new-address' }), person('public-A')],
    decisions: [{ id: 'merge-legacy', kind: 'merge', profileId: 'legacy-old', survivorId: 'legacy-survivor' }] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['legacy-survivor'])
  for (const id of ['legacy-old', 'public-A', professionalId]) assert.deepEqual(await reader.profile({ id }), { moved: 'legacy-survivor' })
  state.decisions.push({ id: 'remove-survivor', kind: 'remove', profileId: 'legacy-survivor' })
  assert.deepEqual((await read()).profiles, [])
  for (const id of ['legacy-old', 'legacy-survivor', professionalId]) assert.equal(await reader.profile({ id }), null)
})

test('an explicit imported survivor stays canonical even when another copy sorts first', async () => {
  const { read } = setup({ profiles: [person('public-A'), person('public-old'), person('public-Z')],
    decisions: [{ id: 'merge-import', kind: 'merge', profileId: 'public-old', survivorId: 'public-Z' }] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['public-Z'])
  assert.equal(snapshot.aliases['public-old'], 'public-Z')
  assert.equal(snapshot.aliases[professionalId], 'public-Z')
})

test('removals on imported, legacy or professional copies cannot be bypassed by publication', async () => {
  for (const removedId of ['public-A', 'legacy-A', professionalId]) {
    const { state, read, reader } = setup({ profiles: [person('public-A'), person('legacy-A')], decisions: [{ id: 'remove', kind: 'remove', profileId: removedId }] })
    const snapshot = await read()
    assert.deepEqual(snapshot.profiles, [])
    for (const id of ['public-A', 'legacy-A', professionalId]) {
      assert.ok(snapshot.removed.includes(id))
      assert.equal(await reader.profile({ id }), null)
    }
    state.decisions = []
    assert.equal((await reader.list({})).profiles.length, 1)
  }
})

test('suspension by profile or retained LinkedIn reference hides professional copies', async () => {
  for (const profiles of [[person('public-A')], []]) {
    const { state, read, reader } = setup({ profiles, decisions: [{ id: 'suspend', kind: 'suspend', profileId: 'public-A', linkedinRefHash: professionalId.slice('professional-'.length) }] })
    assert.deepEqual((await read()).profiles, [])
    assert.equal(await reader.suspended({ id: professionalId }), true)
    assert.equal(await reader.profile({ id: professionalId }), null)
    state.decisions = []
    assert.equal((await reader.list({})).profiles.length, 1)
  }
})

test('named operator renames and unlistings survive deduplication', async () => {
  const { read, reader } = setup({ profiles: [person('public-A')], decisions: [
    { id: 'rename', kind: 'rename', profileId: 'public-A', name: 'Operator Name' },
    { id: 'unlist', kind: 'unlist', profileId: 'public-A' },
  ] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => [row.id, row.name]), [['public-A', 'Operator Name']])
  assert.deepEqual(await reader.profile({ id: professionalId }), { moved: 'public-A' })
  assert.deepEqual((await reader.list({})).profiles, [])
  assert.equal(await reader.unlistedGroup({ id: 'public-A' }), null)
})

test('conflicting named decisions never move a named profile', async () => {
  const { read, reader } = setup({ profiles: [person('public-A'), person('public-B')], decisions: [
    { id: 'rename', kind: 'rename', profileId: 'public-A', name: 'Operator Name' },
    { id: 'unlist', kind: 'unlist', profileId: 'public-B' },
  ] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['public-A', 'public-B'])
  assert.equal(snapshot.aliases['public-A'], undefined)
  assert.equal(snapshot.aliases['public-B'], undefined)
  assert.equal((await reader.profile({ id: 'public-A' })).profile.name, 'Operator Name')
  assert.equal(await reader.unlistedGroup({ id: 'public-B' }), null)
})

test('verified members absorb copies without taking public-source fields', async () => {
  const { read } = setup({ profiles: [person('legacy-member'), person('public-A')], members: ['legacy-member'], verified: ['legacy-member'] })
  const snapshot = await read()
  assert.deepEqual(snapshot.profiles.map(row => row.id), ['legacy-member'])
  assert.equal(snapshot.profiles[0].about, undefined)
  assert.equal(snapshot.profiles[0].company, undefined)
  assert.equal(snapshot.aliases[professionalId], 'legacy-member')
})

test('unverified addresses and distinct claimed members never absorb professional identities', async () => {
  for (const members of [['member-A'], ['member-A', 'member-B']]) {
    const { read } = setup({ profiles: members.map(id => person(id)), members, verified: members.length > 1 ? members : [] })
    const snapshot = await read()
    assert.deepEqual(snapshot.profiles.map(row => row.id), [...members, professionalId])
    assert.deepEqual(snapshot.members, members)
    assert.equal(Object.keys(snapshot.aliases ?? {}).length, 0)
  }
})
