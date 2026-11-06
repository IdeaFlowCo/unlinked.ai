import { investorJobsForAccount, investorReceiptId } from './investor-job.mjs'
import { privateId } from './job.mjs'
import { createScopedImportReader } from './noos-adapter.mjs'
import { withoutSuspendedRows } from '../public-people/suspension-filter.mjs'
import { sharedImportRowCache } from './import-row-cache.mjs'

const SHA = /^[a-f0-9]{64}$/
const TOMBSTONE_BATCH = 400
const RECEIPT_PROBE_LIMIT = 600

// A row receipt is durable before its checkpoint. At most one extra receipt
// can exist beyond offset, including after an interrupted first row.
const investorReceiptCount = job => Math.min(job.total, job.offset + 1)

// The whole account in one reviewable JSON document. Reads use the same
// owner-fenced readers as the pages; nothing bypasses tombstones or consent.
export async function exportAccountData({ owner, backend, jobs, grants = [], signupLookup, signal }) {
  // Suspended people are left out of parsed rows (docs/profile-suspension.md);
  // the original uploaded files are the owner's own and stay as uploaded.
  const suppressions = typeof backend.readSuppressions === 'function' ? await backend.readSuppressions({ signal }) : null
  const imports = []
  for (const resource of jobs) {
    signal?.throwIfAborted()
    const job = resource.payload
    const entry = { id: job.id, filename: job.filename ?? null, archiveSha256: job.archiveSha256 ?? null, status: job.status ?? null,
      phase: job.phase ?? null, counts: job.counts ?? null, consent: job.consent ?? null, createdAt: job.createdAt ?? null, observations: [] }
    if (['indexed', 'partial'].includes(job.status)) {
      try {
        const read = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId: owner.ownerId, importIds: [job.id] } })
        entry.observations = withoutSuspendedRows((await read(job.id, { signal })).assertions, suppressions)
      } catch { entry.observations = null; entry.observationsError = 'import_observations_unreadable' }
    }
    imports.push(entry)
  }
  let legacy = null
  try {
    if (typeof backend.readLegacyProfile === 'function') {
      const link = await backend.readLegacyProfile()
      if (link) legacy = { profileId: link.profileId, profile: link.profile ?? null, connections: (link.connections ?? []).filter(edge => !suppressions?.ids?.has(edge?.toId)) }
    }
    if (typeof backend.readLegacyFiles === 'function') {
      const files = await backend.readLegacyFiles()
      if (files?.objects?.length) legacy = { ...(legacy ?? {}), recoveredFiles: files.objects }
    }
    if (typeof backend.readLegacyObservations === 'function') {
      const recovered = await backend.readLegacyObservations({ signal })
      if (recovered?.assertions?.length) legacy = { ...(legacy ?? {}), recoveredObservations: withoutSuspendedRows(recovered.assertions, suppressions) }
    }
  } catch { legacy = { ...(legacy ?? {}), error: 'legacy_records_unavailable' } }
  const confirmed = signupLookup ? await (typeof signupLookup.readForExport === 'function' ? signupLookup.readForExport(owner) : signupLookup.read(owner)) : null
  const signupProfile = confirmed ? { profile: confirmed.profile, receiptId: confirmed.receiptId, ...(confirmed.retired ? { retired: true, retiredByProfileId: confirmed.retiredByProfileId } : {}),
    provenance: { source: 'profile-lookup', selfAsserted: true, confirmation: 'self-asserted-public-profile-v1' } } : null
  const investorImports = []
  for (const resource of (await investorJobsForAccount(owner.ownerId, backend)).jobs) {
    signal?.throwIfAborted()
    const job = resource.payload, receipts = []
    for (let ordinal = 0; ordinal < investorReceiptCount(job); ordinal++) {
      signal?.throwIfAborted()
      const receipt = await backend.readResource('import', investorReceiptId(owner.ownerId, job.id, ordinal))
      if (receipt && !receipt.deleted && receipt.sourceOwnerId === owner.ownerId) receipts.push(receipt.payload)
    }
    const bytes = await backend.readAsset(job.sourceDigest)
    investorImports.push({ job, ...(job.source?.format === 'xlsx' ? { originalFile: { ...job.source, encoding: 'base64', base64: bytes.toString('base64') } } : { csv: bytes.toString('utf8') }), receipts })
  }
  return { investorImports, format: 'unlinked-account-export', version: 1, exportedAt: new Date().toISOString(),
    account: { ownerId: owner.ownerId }, imports, agentGrantIds: [...grants], legacy, signupProfile }
}

// Permanently tombstones the account's operational resources: assertions,
// observation chunks, source receipts, import receipts, the jobs themselves and
// agent grants. Tombstones erase the stored payloads and can never be revived.
// Content is erased first and each job last, so an interrupted run stays
// discoverable through the job listing and can simply be run again.
export async function deleteAccountData({ rowCache = sharedImportRowCache, ...input }) {
  // Rows are tombstoned before their import: the owner's cache is bypassed
  // for the whole erase and emptied before and after it.
  rowCache?.beginErase(input.owner.ownerId)
  try { return await eraseAccountData(input) } finally { rowCache?.endErase(input.owner.ownerId) }
}

async function eraseAccountData({ owner, backend, jobs, grantIds = [], signupLookup, signal }) {
  if (signupLookup) await signupLookup.removeOwner(owner)
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
  const investor = await investorJobsForAccount(ownerId, backend)
  for (const resource of investor.jobs) {
    const job = resource.payload
    for (let ordinal = 0; ordinal < investorReceiptCount(job); ordinal++) {
      signal?.throwIfAborted()
      await eraseOne({ type: 'import', sourceId: investorReceiptId(ownerId, job.id, ordinal) })
    }
    await eraseOne({ type: 'import', sourceId: resource.sourceId })
  }
  if (investor.catalog) await eraseOne({ type: 'import', sourceId: investor.catalog.sourceId })
  for (const grantId of grantIds) {
    signal?.throwIfAborted()
    if (typeof grantId !== 'string' || !SHA.test(grantId)) continue
    await eraseOne({ type: 'import', sourceId: grantId })
  }
  return { deletedResources: deleted }
}
