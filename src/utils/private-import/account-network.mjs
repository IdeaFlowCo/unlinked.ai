import { privateId } from './job.mjs'
import { createScopedImportReader } from './noos-adapter.mjs'
import { COMBINED_UPLOAD_CONSENT, requireCombinedUploadConsent } from './consent.mjs'
import { createPrivateSearch } from './ai-search.mjs'

// One authenticated account, all its currently published imports. Source
// assertions keep their original IDs and provenance; no email/URL ownership.
export function createAccountNetwork({ owner, getBackend, complete, observationLimit = 100000 }) {
  if (!owner?.ownerId || !owner.userId || typeof getBackend !== 'function') throw new Error('verified_owner_required')
  if (!Number.isSafeInteger(observationLimit) || observationLimit < 0 || observationLimit > 100000) throw new Error('account_observation_limit')
  const networkId = privateId(owner.ownerId, 'account-network-v1')
  const readNetwork = async (_id, { signal } = {}) => {
    signal?.throwIfAborted()
    const backend = await getBackend(owner)
    if (typeof backend.listImportIds !== 'function') throw new Error('account_import_discovery_unavailable')
    const ids = await backend.listImportIds()
    if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('account_import_limit')
    const assertions = [], imports = []
    let indexed = 0
    for (const id of ids) {
      signal?.throwIfAborted()
      const readImport = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId: owner.ownerId, importIds: [id] }, maxAssertions: observationLimit - assertions.length, limitError: 'account_observation_limit' })
      const publication = await readImport(id, { signal })
      requireCombinedUploadConsent(publication.consent)
      for (const row of publication.assertions) assertions.push(row)
      indexed += publication.indexed ?? 0
      imports.push(id)
    }
    const legacy = typeof backend.readLegacyProfile === 'function' ? await backend.readLegacyProfile() : null
    if (legacy) {
      const people = new Map(legacy.profiles.map(profile => [profile.id, profile]))
      for (const edge of legacy.connections) {
        const person = people.get(edge.toId)
        if (!person || edge.fromId !== legacy.profileId) throw Error('legacy_network_source_invalid')
        if (assertions.length >= observationLimit) throw Error('account_observation_limit')
        const id = privateId(owner.ownerId, 'legacy-connection', legacy.sourceSha256, legacy.profileId, person.id)
        assertions.push({ id, ownerId: owner.ownerId, importId: networkId, sourceId: legacy.sourceSha256, rowId: `legacy:${legacy.profileId}:${person.id}`, category: 'connections', fields: { 'first name': person.name, company: person.company ?? person.positions?.[0]?.company ?? '', position: person.headline ?? '' }, provenance: { source: 'recovered-legacy-public-v1', revision: legacy.revision, fromId: edge.fromId, toId: edge.toId } })
      }
      indexed += legacy.connections.length
      // Linking/revocation is rechecked before these legacy rows are returned.
      const current = await backend.readLegacyProfile()
      if (!current || current.receiptId !== legacy.receiptId || current.revision !== legacy.revision) throw Error('legacy_network_changed')
    }
    // Accepted invites connect two accounts; the row names the other person and,
    // when they have one, their public profile.
    if (typeof backend.readInviteConnections === 'function') {
      for (const value of await backend.readInviteConnections()) {
        if (assertions.length >= observationLimit) throw Error('account_observation_limit')
        assertions.push({ id: privateId(owner.ownerId, 'invite-connection', value.invitationId), ownerId: owner.ownerId, importId: networkId, sourceId: 'unlinked-invites', rowId: `invite:${value.invitationId}`, category: 'connections',
          fields: { 'first name': value.name, company: '', position: '' }, provenance: { source: 'unlinked-invite', invitationId: value.invitationId, ...(value.publicProfileId ? { toId: value.publicProfileId } : {}) } })
      }
    }
    // Accepted connection requests ("Connect") connect two accounts the same way.
    if (typeof backend.readMemberConnections === 'function') {
      for (const value of await backend.readMemberConnections()) {
        if (assertions.length >= observationLimit) throw Error('account_observation_limit')
        assertions.push({ id: privateId(owner.ownerId, 'member-connection', value.requestId), ownerId: owner.ownerId, importId: networkId, sourceId: 'unlinked-connections', rowId: `connection:${value.requestId}`, category: 'connections',
          fields: { 'first name': value.name, company: '', position: '' }, provenance: { source: 'unlinked-connection', requestId: value.requestId, ...(value.publicProfileId ? { toId: value.publicProfileId } : {}) } })
      }
    }
    if(typeof backend.readLegacyObservations==='function'){
      const recovered=await backend.readLegacyObservations({signal,limit:observationLimit-assertions.length})
      if(recovered){assertions.push(...recovered.assertions);indexed+=recovered.assertions.length}
    }
    return { legacyProfileId: legacy?.profileId, id: networkId, ownerId: owner.ownerId, imports, indexed, assertions, consent: COMBINED_UPLOAD_CONSENT }
  }
  return { readNetwork, search: typeof complete === 'function' ? async ({ query, signal }) => {
    const result = await createPrivateSearch({ readImport: readNetwork, complete })({ importId: networkId, query, signal })
    return { ...result, scope: 'owner_network' }
  } : null }
}
