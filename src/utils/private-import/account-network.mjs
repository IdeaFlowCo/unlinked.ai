import { privateId } from './job.mjs'
import { createScopedImportReader } from './noos-adapter.mjs'
import { COMBINED_UPLOAD_CONSENT, requireCombinedUploadConsent } from './consent.mjs'
import { createPrivateSearch } from './ai-search.mjs'

// One authenticated account, all its currently published imports. Source
// assertions keep their original IDs and provenance; no email/URL ownership.
export function createAccountNetwork({ owner, getBackend, complete }) {
  if (!owner?.ownerId || !owner.userId || typeof getBackend !== 'function') throw new Error('verified_owner_required')
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
      const readImport = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId: owner.ownerId, importIds: [id] } })
      const publication = await readImport(id, { signal })
      requireCombinedUploadConsent(publication.consent)
      if (assertions.length + publication.assertions.length > 100000) throw new Error('account_observation_limit')
      for (const row of publication.assertions) assertions.push(row)
      indexed += publication.indexed ?? 0
      imports.push(id)
    }
    return { id: networkId, ownerId: owner.ownerId, imports, indexed, assertions, consent: COMBINED_UPLOAD_CONSENT }
  }
  return { readNetwork, search: typeof complete === 'function' ? async ({ query, signal }) => {
    const result = await createPrivateSearch({ readImport: readNetwork, complete })({ importId: networkId, query, signal })
    return { ...result, scope: 'owner_network' }
  } : null }
}
