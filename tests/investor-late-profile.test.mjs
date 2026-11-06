import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture } from './helpers/investor-fixture.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { createPrivateContext } from '../mcp-server/private-context.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const slug = 'synthetic-late-profile', ref = sha(slug)
const profile = { id: 'public-after-import', name: 'Public Person', linkedinUrl: `https://www.linkedin.com/in/${slug}`, positions: [], education: [], skills: [] }
const grant = ownerId => ({ ownerId, userId: ownerId, agent: 'Synthetic', version: CURRENT_ACCOUNT_GRANT_VERSION,
  scope: 'owner_network_and_private_notes', tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, 'owner_network_and_private_notes')] })

test('private investor predating a public persona attaches by exact public URL in connector and browser, without writes or foreign data', async () => {
  const f = fixture(), owner = grant('alice'), other = grant('bob')
  let profiles = [], revision = 0, writes = 0
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: `late-${revision}`, profiles, connections: [] })
  const overlay = { request: async (identity, method, path, body) => {
    if (method !== 'GET' && path !== 'lookup') writes++
    return f.options.overlay.request(identity, method, path, body)
  } }
  const service = createAccountToolService({ ...f.options, overlay, readPublishedSnapshot,
    getBackend: async who => ({ ...await f.getBackend(who), listImportIds: async () => [] }),
    lookupSlug: async value => value === slug && profiles.length ? profile.id : null })
  const call = (name, input, who = owner) => service.call({ grant: who, name, input }).then(value => value.result)
  const staged = await call('unlinked_stage_investor_csv', { csv: `Name,URL,Note\nPrivate Person,https://linkedin.com/in/${slug},Private late note`, listName: 'Private list', mapping: { name: 'Name', linkedinUrl: 'URL', notes: ['Note'] } })
  await call('unlinked_resume_investor_import', { importId: staged.importId })
  const privatePerson = [...f.state('alice').entities.values()].find(value => value.kind === 'person')
  assert.deepEqual(privatePerson.refs, [`linkedin:in:${ref}`])
  profiles = [profile]; revision++
  const before = writes
  for (const profileId of [profile.id, `https://linkedin.com/in/${slug}`]) {
    const card = await call('unlinked_get_person_private', { profileId })
    assert.deepEqual(card.entities.map(value => value.id), [privatePerson.id])
    assert.deepEqual((await call('unlinked_get_person_private', { profileId }, other)).entities, [])
  }
  const context = createPrivateContext({ identityFor: f.options.identityFor,
    lookupContact: (who, input) => call('unlinked_lookup_contact', input, who),
    overlay: { lookup: async (identity, value) => {
      const result = await overlay.request(identity, 'POST', 'lookup', { ref: value })
      return result.status === 200 ? result.body.entity : null
    } } })
  assert.equal((await context.forProfile(owner, profile.id)).entities[0].id, privatePerson.id)
  assert.equal((await context.forProfile(other, profile.id)).state, 'empty')
  assert.equal(writes, before, 'private reads must not create or join graph records')
  const added = await call('unlinked_add_private_note', { subjectKind: 'unlinked', subjectId: profile.id, text: 'New private comment' })
  assert.equal(added.entityId, privatePerson.id)
  assert.equal(f.state('alice').entities.size, 2, 'no duplicate person beside existing list')
  assert.equal(f.state('bob').entities.size, 0)
  assert.equal((await call('unlinked_list_connections', {})).total, 0)
  assert.deepEqual(profiles, [profile])
  await f.options.overlay.request(await f.options.identityFor(owner), 'POST', 'entities', { kind: 'person', name: 'Separate private record', refs: [`unlinked:person:${profile.id}`] })
  const beforeConflict = writes
  await assert.rejects(call('unlinked_add_private_note', { subjectKind: 'unlinked', subjectId: profile.id, text: 'Must not choose a record' }), e => e.code === 'identity_conflict')
  assert.equal(writes, beforeConflict)
  profiles = []; revision++
  await assert.rejects(call('unlinked_get_person_private', { profileId: profile.id }), e => e.code === 'not_found')
})

test('public identity comes only from the readable canonical URL; forged hash IDs, names and email do not match', async () => {
  let profiles = [{ ...profile, id: `li-${ref}`, linkedinUrl: undefined, email: 'private@example.invalid' }], revision = 1
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: `identity-${revision}`, profiles, connections: [] }) })
  assert.equal(await reader.linkedinRef({ id: `li-${ref}` }), null)
  profiles = [{ ...profile, linkedinUrl: 'https://www.linkedin.com/in/Synthetic%2DLate%2DProfile/' }]; revision++
  assert.equal(await reader.linkedinRef({ id: profile.id }), ref)
  profiles = []; revision++
  assert.equal(await reader.linkedinRef({ id: profile.id }), null)
})

test('current public identity and owner source refs are reconciled without joining conflicts', async () => {
  const f = fixture(), alice = grant('alice'), bob = grant('bob')
  let profiles = [profile], writes = 0, rows = []
  const oldSlug = 'old-source-address', oldRef = sha(oldSlug)
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'current', profiles, connections: [] })
  const overlay = { request: async (identity, method, path, body) => {
    if (method !== 'GET' && path !== 'lookup') writes++
    return f.options.overlay.request(identity, method, path, body)
  } }
  const service = createAccountToolService({ ...f.options, overlay, readPublishedSnapshot,
    lookupSlug: async value => value === oldSlug ? profile.id : null,
    getBackend: async who => ({ ...await f.getBackend(who), listImportIds: async () => [],
      readMemberConnections: async () => who.ownerId === 'alice' ? [{ requestId: 'accepted', name: 'Person', publicProfileId: profile.id }] : [],
      readLegacyObservations: async () => ({ assertions: who.ownerId === 'alice' ? rows : [] }) }) })
  const call = (name, input, who = alice) => service.call({ grant: who, name, input }).then(value => value.result)
  const identity = await f.options.identityFor(alice)
  const publicEntity = (await overlay.request(identity, 'POST', 'entities', { kind: 'person', name: 'Private', refs: [`linkedin:in:${ref}`] })).body.entity
  const before = writes
  for (const subject of [profile.id, `https://linkedin.com/in/${slug}`]) {
    assert.deepEqual((await call('unlinked_get_person_private', { profileId: subject })).entities.map(e => e.id), [publicEntity.id])
    assert.deepEqual((await call('unlinked_get_person_private', { profileId: subject }, bob)).entities, [])
  }
  const context = createPrivateContext({ identityFor: f.options.identityFor, lookupContact: (who, input) => call('unlinked_lookup_contact', input, who),
    overlay: { lookup: async (who, value) => (await overlay.request(who, 'POST', 'lookup', { ref: value })).body?.entity ?? null } })
  assert.equal((await context.forProfile(alice, profile.id)).entities[0].id, publicEntity.id)
  assert.equal(writes, before)
  // An explicit source target can carry a different owner-import identity.
  rows = [{ id: 'source-row', category: 'connections', fields: { 'first name': 'Source', url: `https://linkedin.com/in/${oldSlug}` }, provenance: { source: 'recovered-legacy-public-v1', toId: profile.id } }]
  const sourceEntity = (await overlay.request(identity, 'POST', 'entities', { kind: 'person', name: 'Other', refs: [`linkedin:in:${oldRef}`] })).body.entity
  const sourceLookup = await call('unlinked_lookup_contact', { connectionId: 'source-row' })
  assert.equal(sourceLookup.contact.linkedinRefHash, ref)
  assert.equal(sourceLookup.contact.sourceLinkedinRefHash, oldRef)
  assert.deepEqual(new Set((await call('unlinked_get_person_private', { profileId: 'source-row' })).entities.map(e => e.id)), new Set([sourceEntity.id, publicEntity.id]))
  const beforeConflict = writes
  for (const subjectId of ['source-row', profile.id, `https://linkedin.com/in/${slug}`]) await assert.rejects(call('unlinked_add_private_note', { subjectKind: 'unlinked', subjectId, text: 'Ambiguous' }), e => e.code === 'identity_conflict')
  assert.equal(writes, beforeConflict)
  rows = []
  for (const linkedinUrl of [`https://linkedin.com/in/${oldSlug}`, `https://linkedin.com/in/${slug}`]) {
    profiles = [{ ...profile, linkedinUrl: undefined }]
    await assert.rejects(call('unlinked_get_person_private', { profileId: linkedinUrl }), e => e.code === 'not_found')
  }
  profiles = [{ ...profile, linkedinUrl: 'https://linkedin.com/in/changed-address' }]
  await assert.rejects(call('unlinked_get_person_private', { profileId: `https://linkedin.com/in/${slug}` }), e => e.code === 'not_found')
})

test('all entry paths reconcile owner sources, preserve source annotations, and fail closed on outages', async () => {
  const f = fixture(), alice = grant('alice'), bob = grant('bob')
  const oldSlugs = ['first-owner-source', 'second-owner-source'], hashes = oldSlugs.map(sha)
  const rows = oldSlugs.map((value, i) => ({ id: `row-${i}`, category: 'connections', fields: { 'first name': `Person ${i}`, url: `https://linkedin.com/in/${value}` }, provenance: { source: 'recovered-legacy-public-v1', toId: profile.id } }))
  let networkDown = false, addressesDown = false, writes = 0
  const overlay = { request: async (identity, method, path, body) => {
    if (method !== 'GET' && path !== 'lookup') writes++
    return f.options.overlay.request(identity, method, path, body)
  } }
  const service = createAccountToolService({ ...f.options, overlay,
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'test', profiles: [profile], connections: [] }),
    contactAddresses: async () => { if (addressesDown) throw Error('unavailable'); return new Map() },
    getBackend: async who => ({ ...await f.getBackend(who), listImportIds: async () => { if (networkDown) throw Error('unavailable'); return [] },
      readLegacyObservations: async () => ({ assertions: who.ownerId === 'alice' ? rows : [] }) }) })
  const call = (name, input, who = alice) => service.call({ grant: who, name, input }).then(value => value.result)
  const identity = await f.options.identityFor(alice)
  const entities = []
  for (const hash of hashes) entities.push((await overlay.request(identity, 'POST', 'entities', { kind: 'person', name: hash, refs: [`linkedin:in:${hash}`] })).body.entity)
  const before = writes
  for (const subjectId of ['row-0', 'row-1', profile.id, `https://linkedin.com/in/${slug}`, `https://linkedin.com/in/${oldSlugs[0]}`]) {
    assert.deepEqual(new Set((await call('unlinked_get_person_private', { profileId: subjectId })).entities.map(e => e.id)), new Set(entities.map(e => e.id)))
    await assert.rejects(call('unlinked_add_private_note', { subjectKind: 'unlinked', subjectId, text: 'Do not choose' }), e => e.code === 'identity_conflict')
  }
  assert.equal(writes, before)
  assert.equal((await call('unlinked_get_private_thing', { thingId: entities[0].id })).entity.connectionId, 'row-0')
  assert.equal((await call('unlinked_lookup_contact', { refHashes: hashes })).contacts[1].linkedinRefHash, hashes[1])
  assert.deepEqual((await call('unlinked_get_person_private', { profileId: profile.id }, bob)).entities, [])
  const context = createPrivateContext({ identityFor: f.options.identityFor, lookupContact: (who, input) => call('unlinked_lookup_contact', input, who),
    overlay: { lookup: async (who, value) => (await overlay.request(who, 'POST', 'lookup', { ref: value })).body?.entity ?? null } })
  assert.equal((await context.forContact(alice, 'row-0')).entities.length, 2)
  for (const outage of ['network', 'addresses']) {
    networkDown = outage === 'network'; addressesDown = outage === 'addresses'
    for (const subjectId of ['row-0', profile.id, `https://linkedin.com/in/${slug}`]) {
      await assert.rejects(call('unlinked_add_private_note', { subjectKind: 'unlinked', subjectId, text: 'Unavailable' }), e => e.code === 'upstream_unavailable')
    }
    await assert.rejects(context.forProfile(alice, profile.id), e => e.code === 'overlay_unavailable')
    assert.equal(writes, before)
  }
})

test('published LinkedIn lookup uses current snapshot and prefers a member', async () => {
  let profiles = [{ ...profile, id: 'z-member' }, { ...profile, id: 'a-shadow' }], revision = 1
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: `${revision}`, profiles, connections: [], members: ['z-member'] }) })
  assert.equal((await reader.lookupLinkedin({ address: profile.linkedinUrl })).id, 'z-member')
  profiles = [{ ...profile, id: 'z-member', linkedinUrl: undefined }, profiles[1]]; revision++
  assert.equal((await reader.lookupLinkedin({ address: profile.linkedinUrl })).id, 'a-shadow')
})
