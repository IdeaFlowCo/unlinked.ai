// Process-only read capability. Created only after verified owner resolution;
// never exposed through a browser, grant, or operational HTTP route.
export const OWNER_RESOURCE_BATCH_LIMIT = 128
const MAX_DOCUMENT_BYTES = 64 * 1024
const READ = `MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId})
  WHERE coalesce(b.active, true) = true
  UNWIND $ids AS id
  MATCH (r:OperationalResource {namespace: 'unlinked', type: 'assertion', sourceId: id, userId: $userId})
  RETURN r.sourceId AS id, CASE WHEN size(r.document) <= $maxDocumentBytes THEN r.document ELSE null END AS document`

export function createOwnerResourceBatchReader({ driver, authorizeOwner, owner, isClosed = () => false }) {
  const ownerId = owner?.ownerId, userId = owner?.userId
  if (!ownerId || !userId || typeof authorizeOwner !== 'function') throw Error('verified_owner_required')
  // Copy authority into the closure: a caller cannot mutate it after creation.
  const principal = Object.freeze({ userId, namespaces: Object.freeze(['unlinked']) })
  const check = async () => {
    if (isClosed()) throw Error('private_owner_recovery_required')
    await authorizeOwner(principal, 'unlinked', ownerId)
    if (isClosed()) throw Error('private_owner_recovery_required')
  }
  return async (type, ids) => {
    if (type !== 'assertion' || !Array.isArray(ids) || !ids.length || ids.length > OWNER_RESOURCE_BATCH_LIMIT ||
        Array.from(ids).some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw Error('private_resource_key_invalid')
    const requested = [...ids]
    await check()
    const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
    let rows
    try {
      const result = await session.executeRead(tx => tx.run(READ, { ownerId, userId, ids: requested, maxDocumentBytes: MAX_DOCUMENT_BYTES }))
      rows = new Map()
      for (const record of result.records) {
        const id = record.get('id'), document = record.get('document')
        if (!requested.includes(id) || rows.has(id) || typeof document !== 'string' || Buffer.byteLength(document) > MAX_DOCUMENT_BYTES) throw Error('private_publication_incomplete')
        const row = JSON.parse(document)
        // The graph joins user + live binding; document ownership and exact key
        // are checked again before anything reaches the publication reader.
        if (row.namespace !== 'unlinked' || row.type !== type || row.sourceId !== id || row.sourceOwnerId !== ownerId) throw Error('private_publication_incomplete')
        rows.set(id, row)
      }
    } finally { await session.close() }
    await check()
    return requested.map(id => rows.get(id) ?? null)
  }
}
