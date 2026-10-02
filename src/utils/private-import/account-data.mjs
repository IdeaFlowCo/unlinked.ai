import { privateId } from './job.mjs'
import { createScopedImportReader } from './noos-adapter.mjs'

const SHA = /^[a-f0-9]{64}$/
const TOMBSTONE_BATCH = 400
const RECEIPT_PROBE_LIMIT = 600

// The whole account in one reviewable JSON document. Reads use the same
// owner-fenced readers as the pages; nothing bypasses tombstones or consent.
export async function exportAccountData({ owner, backend, jobs, grants = [], signal }) {
  const imports = []
  for (const resource of jobs) {
    signal?.throwIfAborted()
    const job = resource.payload
    const entry = { id: job.id, filename: job.filename ?? null, archiveSha256: job.archiveSha256 ?? null, status: job.status ?? null,
      phase: job.phase ?? null, counts: job.counts ?? null, consent: job.consent ?? null, createdAt: job.createdAt ?? null, observations: [] }
    if (['indexed', 'partial'].includes(job.status)) {
      try {
        const read = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId: owner.ownerId, importIds: [job.id] } })
        entry.observations = (await read(job.id, { signal })).assertions
      } catch { entry.observations = null; entry.observationsError = 'import_observations_unreadable' }
    }
    imports.push(entry)
  }
  let legacy = null
  try {
    if (typeof backend.readLegacyProfile === 'function') {
      const link = await backend.readLegacyProfile()
      if (link) legacy = { profileId: link.profileId, profile: link.profile ?? null, connections: link.connections ?? [] }
    }
    if (typeof backend.readLegacyFiles === 'function') {
      const files = await backend.readLegacyFiles()
      if (files?.objects?.length) legacy = { ...(legacy ?? {}), recoveredFiles: files.objects }
    }
    if (typeof backend.readLegacyObservations === 'function') {
      const recovered = await backend.readLegacyObservations({ signal })
      if (recovered?.assertions?.length) legacy = { ...(legacy ?? {}), recoveredObservations: recovered.assertions }
    }
  } catch { legacy = { ...(legacy ?? {}), error: 'legacy_records_unavailable' } }
  return { format: 'unlinked-account-export', version: 1, exportedAt: new Date().toISOString(),
    account: { ownerId: owner.ownerId }, imports, agentGrantIds: [...grants], legacy }
}

// Permanently tombstones every resource the account produced: assertions,
// observation chunks, source receipts, import receipts, the jobs themselves and
// agent grants. Tombstones erase the stored payloads and can never be revived.
// Content is erased first and each job last, so an interrupted run stays
// discoverable through the job listing and can simply be run again.
export async function deleteAccountData({ owner, backend, jobs, grantIds = [], signal }) {
  const ownerId = owner.ownerId
  const writeBatch = typeof backend.writeBatch === 'function'
    ? items => backend.writeBatch(items)
    : async items => { for (const item of items) await backend.writeResource(item) }
  const tombstone = (type, sourceId, sourceRevision) => ({ namespace: 'unlinked', type, sourceId, sourceOwnerId: ownerId,
    sourceRevision: sourceRevision + 1, expectedRevision: sourceRevision, audience: 'owner', deleted: true, payload: null })
  let deleted = 0
  const eraseOne = async item => {
    const current = await backend.readResource(item.type, item.sourceId)
    if (!current || current.sourceOwnerId !== ownerId) return
    if (current.deleted) { deleted++; return }
    if (!Number.isSafeInteger(current.sourceRevision) || current.sourceRevision < 1) return
    await writeBatch([tombstone(item.type, item.sourceId, current.sourceRevision)])
    deleted++
  }
  const erase = async items => {
    for (let start = 0; start < items.length; start += TOMBSTONE_BATCH) {
      signal?.throwIfAborted()
      const slice = items.slice(start, start + TOMBSTONE_BATCH)
      try { await writeBatch(slice); deleted += slice.length }
      catch { for (const item of slice) { signal?.throwIfAborted(); await eraseOne(item) } }
    }
  }
  for (const resource of jobs) {
    signal?.throwIfAborted()
    if (!resource || resource.deleted || resource.sourceOwnerId !== ownerId || resource.payload?.id !== resource.sourceId ||
        resource.payload.kind || resource.payload.receiptOf) continue
    const job = resource.payload
    const assertionIds = new Set(), chunks = [], others = []
    const chunkIds = [...new Set([...(Array.isArray(job.assertionChunks) ? job.assertionChunks : []),
      ...(Array.isArray(job.stagedChunks) ? job.stagedChunks : [])])]
    for (const chunkId of chunkIds) {
      if (typeof chunkId !== 'string' || !SHA.test(chunkId)) continue
      signal?.throwIfAborted()
      const chunk = await backend.readResource('import', chunkId)
      if (!chunk || chunk.deleted || chunk.sourceOwnerId !== ownerId || chunk.payload?.kind !== 'private_observation_chunk' || chunk.payload.importId !== job.id) continue
      for (const assertionId of Array.isArray(chunk.payload.assertionIds) ? chunk.payload.assertionIds : []) if (typeof assertionId === 'string' && SHA.test(assertionId)) assertionIds.add(assertionId)
      chunks.push(tombstone('import', chunkId, chunk.sourceRevision))
    }
    for (const assertionId of Array.isArray(job.assertionIds) ? job.assertionIds : []) if (typeof assertionId === 'string' && SHA.test(assertionId)) assertionIds.add(assertionId)
    for (const source of Array.isArray(job.sources) ? job.sources : []) {
      const sourceId = typeof source === 'string' ? source : source?.id
      if (typeof sourceId !== 'string' || !SHA.test(sourceId)) continue
      signal?.throwIfAborted()
      const record = await backend.readResource('source', sourceId)
      if (record && !record.deleted && record.sourceOwnerId === ownerId && Number.isSafeInteger(record.sourceRevision)) others.push(tombstone('source', sourceId, record.sourceRevision))
    }
    const revisions = Number.isSafeInteger(job.revision) && job.revision > 0 ? Math.min(job.revision, RECEIPT_PROBE_LIMIT) : 1
    for (let revision = 1; revision <= revisions; revision++) {
      signal?.throwIfAborted()
      const receiptId = privateId(ownerId, 'receipt', job.id, revision)
      const receipt = await backend.readResource('import', receiptId)
      if (receipt && !receipt.deleted && receipt.sourceOwnerId === ownerId && receipt.payload?.receiptOf === job.id && Number.isSafeInteger(receipt.sourceRevision)) others.push(tombstone('import', receiptId, receipt.sourceRevision))
    }
    // Written-once observations are tombstoned optimistically at revision 1;
    // the per-item fallback rereads anything that has moved on.
    await erase([...assertionIds].map(assertionId => tombstone('assertion', assertionId, 1)))
    await erase(chunks)
    await erase(others)
    await erase([tombstone('import', resource.sourceId, resource.sourceRevision)])
  }
  for (const grantId of grantIds) {
    signal?.throwIfAborted()
    if (typeof grantId !== 'string' || !SHA.test(grantId)) continue
    await eraseOne({ type: 'import', sourceId: grantId })
  }
  return { deletedResources: deleted }
}
