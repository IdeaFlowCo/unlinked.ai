import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { linkedinRefHash, linkedinSlug } from '../src/utils/public-people/url-identity.mjs'

// unlinked_lookup_contact (unlinked-9kk.3): resolve one of the owner's own
// contacts without paging, with the private-graph key linkedin:in:<hash>.
const sha = value => createHash('sha256').update(value).digest('hex')
const owner = { ownerId: 'synthetic-lookup-owner', userId: 'synthetic-lookup-user' }
const stranger = { ownerId: 'synthetic-other-owner', userId: 'synthetic-other-user' }
const row = (id, first, last, url, extra = {}) => ({ id, ownerId: owner.ownerId, importId: sha('legacy-storage'), sourceId: sha('raw'), rowId: `Connections.csv#record=${id.slice(0, 4)}`, category: 'connections',
  fields: { 'first name': first, 'last name': last, url, company: 'Synthetic Co', position: 'Engineer' }, provenance: { source: 'recovered-legacy-storage-v1' }, ...extra })
const ada = row(sha('ada'), 'Ada', 'Lovelace', 'https://www.linkedin.com/in/Synthetic-Ada')
const grace = row(sha('grace'), 'Grace', 'Hopper', 'https://www.linkedin.com/in/synthetic-grac%C3%A9')
const nameOnly = row(sha('nourl'), 'No', 'Address', '')
const member = { requestId: 'request-1', name: 'Member Person', publicProfileId: 'pub-member', other: {} }

function backendFor(who) {
  const mine = who.ownerId === owner.ownerId
  return {
    listImportIds: async () => [],
    readLegacyFiles: async () => (mine ? { objects: [] } : null),
    readLegacyObservations: async () => (mine ? { assertions: [ada, grace, nameOnly] } : null),
    readMemberConnections: async () => (mine ? [member] : []),
  }
}
const snapshot = async () => ({ state: 'published', complete: true, revision: 'lookup-fixture-v1', connections: [],
  profiles: ['pub-ada', 'pub-member', 'pub-stranger', 'pub-grace-legacy'].map(id => ({ id, name: `Published ${id}`, headline: 'Public headline', positions: [], education: [], skills: [] })) })
const slugs = new Map([['synthetic-ada', 'pub-ada'], ['someone-public', 'pub-stranger']])
const service = createAccountToolService({ getBackend: async who => backendFor(who), readPublishedSnapshot: snapshot, lookupSlug: slug => slugs.get(slug) ?? null })
const grantFor = who => ({ ...who, scope: 'owner_network_and_public', version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, 'owner_network_and_public')] })
const lookup = async (input, who = owner) => (await service.call({ grant: grantFor(who), name: 'unlinked_lookup_contact', input })).result
const refused = async (input, code, who = owner) => assert.rejects(service.call({ grant: grantFor(who), name: 'unlinked_lookup_contact', input }), error => error.code === code)

test('catalog v6 adds the read-only lookup to every scope', () => {
  assert.ok(CURRENT_ACCOUNT_GRANT_VERSION >= 6)
  for (const scope of ['owner_network', 'owner_network_and_public', 'owner_network_and_write', 'owner_network_and_public_and_write']) {
    const v5 = accountGrantTools(5, scope), v6 = accountGrantTools(6, scope)
    assert.deepEqual(v6.filter(name => name !== 'unlinked_lookup_contact'), [...v5])
    assert.ok(v6.includes('unlinked_lookup_contact'))
  }
})

test('the ref hash is SHA-256 of the canonical (decoded, lowercased) slug', () => {
  assert.equal(linkedinSlug('https://www.linkedin.com/in/synthetic-grac%C3%A9'), 'synthetic-gracé')
  assert.equal(linkedinRefHash('synthetic-ada'), sha('synthetic-ada'))
  assert.equal(linkedinRefHash(''), null)
})

test('by connection id: the owner contact with its ref hash and published profile', async () => {
  const found = await lookup({ connectionId: ada.id })
  assert.equal(found.visibility, 'owner_private')
  assert.deepEqual(found.contact, { connectionId: ada.id, name: 'Ada Lovelace', headline: 'Engineer', company: 'Synthetic Co',
    linkedinRefHash: sha('synthetic-ada'), publishedProfileId: 'pub-ada', provenance: { type: 'owner_import', importId: ada.importId, rowId: ada.rowId } })
  const plain = await lookup({ connectionId: grace.id })
  assert.equal(plain.contact.linkedinRefHash, sha('synthetic-gracé'))
  assert.equal(plain.contact.publishedProfileId, null)
  // A contact without an address has no ref hash; an accepted connection names its profile.
  assert.equal((await lookup({ connectionId: nameOnly.id })).contact.linkedinRefHash, null)
  const connected = (await service.call({ grant: grantFor(owner), name: 'unlinked_list_connections', input: {} })).result.connections.find(value => value.name === 'Member Person')
  assert.equal((await lookup({ connectionId: connected.id })).contact.publishedProfileId, 'pub-member')
})

test('by LinkedIn address, with or without scheme, trailing slash or case', async () => {
  for (const linkedinUrl of ['linkedin.com/in/SYNTHETIC-ADA/', 'http://www.linkedin.com/in/synthetic-ada', 'https://www.linkedin.com/in/synthetic-ada'])
    assert.equal((await lookup({ linkedinUrl })).contact.connectionId, ada.id)
  // Not imported, but a published profile has that address: public data only.
  const published = await lookup({ linkedinUrl: 'https://www.linkedin.com/in/someone-public' })
  assert.deepEqual(published, { kind: 'unlinked_lookup_contact', contact: { connectionId: null, name: 'Published pub-stranger', headline: 'Public headline', linkedinRefHash: sha('someone-public'), publishedProfileId: 'pub-stranger' }, visibility: 'public' })
  await refused({ linkedinUrl: 'https://www.linkedin.com/in/nobody-here' }, 'not_found')
  await refused({ linkedinUrl: 'https://example.com/in/synthetic-ada' }, 'invalid_input')
})

test('by published profile id: the owner connection when there is one, otherwise public only', async () => {
  const mine = await lookup({ profileId: 'pub-ada' })
  assert.equal(mine.contact.connectionId, ada.id)
  assert.equal(mine.contact.linkedinRefHash, sha('synthetic-ada'))
  const publicOnly = await lookup({ profileId: 'pub-stranger' })
  assert.equal(publicOnly.visibility, 'public')
  assert.equal(publicOnly.contact.connectionId, null)
  assert.equal(publicOnly.contact.publishedProfileId, 'pub-stranger')
  await refused({ profileId: 'pub-absent' }, 'not_found')
})

test('by ref hashes: only the owner contacts among them', async () => {
  const found = await lookup({ refHashes: [sha('synthetic-gracé'), sha('synthetic-ada'), sha('not-a-contact')] })
  assert.deepEqual(found.contacts.map(value => value.connectionId), [ada.id, grace.id])
  assert.equal(found.visibility, 'owner_private')
})

test('never another owner contacts; exactly one input', async () => {
  await refused({ connectionId: ada.id }, 'not_found', stranger)
  assert.deepEqual((await lookup({ refHashes: [sha('synthetic-ada')] }, stranger)).contacts, [])
  await refused({}, 'invalid_input')
  await refused({ connectionId: ada.id, profileId: 'pub-ada' }, 'invalid_input')
  await refused({ refHashes: ['NOT-HEX'] }, 'invalid_input')
})

test('whoami counts a recovered legacy archive as an import (importCount was 0 with 3,155 owner_import rows)', async () => {
  const who = (await service.call({ grant: grantFor(owner), name: 'unlinked_whoami', input: {} })).result
  assert.equal(who.importCount, 1)
  assert.deepEqual(who.imports, { uploaded: 0, recoveredArchive: true })
  assert.ok(who.grant.tools.includes('unlinked_lookup_contact'))
  const other = (await service.call({ grant: grantFor(stranger), name: 'unlinked_whoami', input: {} })).result
  assert.equal(other.importCount, 0)
})
