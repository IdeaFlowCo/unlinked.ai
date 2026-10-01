import { hasCombinedUploadConsent } from './consent.mjs'
import { digest, parseArchive, PARSER_VERSION, LIMITS } from './archive.mjs'

export function privateId(ownerId, ...parts) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) throw new Error('verified_owner_required')
  return digest(JSON.stringify(['unlinked', ownerId, ...parts]))
}
const emptyCounts = () => ({ accepted: 0, rejected: 0, skippedFiles: 0, failedFiles: 0, indexed: 0 })

// The adapter is bound to a verified owner by its caller; imported URLs/emails
// never resolve that principal. No browser route mounts this foundation yet.
export async function ingestArchive({ ownerId, filename, bytes, adapter, consent }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.archiveBytes) throw new Error('archive_size_limit')
  const archiveSha256 = digest(bytes)
  const id = privateId(ownerId, 'import', archiveSha256, filename, PARSER_VERSION)
  return adapter.withImport(ownerId, id, async store => {
    const existing = await store.getJob(id)
    if (existing && ['partial', 'failed', 'indexed'].includes(existing.status)) return existing
    const job = existing ?? {
      id, ownerId, filename, archiveSha256, parserVersion: PARSER_VERSION,
      status: 'uploaded', phase: 'uploaded', revision: 1,
      counts: emptyCounts(), sources: [],
      ...(hasCombinedUploadConsent(consent) ? { consent: structuredClone(consent) } : {}),
    }
    if (!existing) {
      await store.putAsset(archiveSha256, bytes)
      await store.saveJob(job)
    }
    job.sources = []; job.counts = emptyCounts()
    job.status = 'parsing'; job.phase = 'parsing'; job.revision++
    await store.saveJob(job)
    let parsed
    try { parsed = parseArchive(bytes, job.filename) }
    catch {
      job.status = 'failed'; job.phase = 'failed'; job.error = 'archive_parse_failed'; job.revision++
      await store.saveJob(job)
      return job
    }
    // Persistence errors propagate unchanged and leave a retryable parsing
    // receipt, regardless of the adapter's error type. Only parser errors above
    // become archive failures.
    const assertions = []
    for (const source of parsed.sources) {
      await store.putAsset(source.sha256, source.rawBytes)
      const sourceId = privateId(ownerId, 'source', id, source.path, source.sha256)
      const { accepted } = source
      const receipt = { ...source }; delete receipt.rawBytes; delete receipt.accepted
      if (store.compactSourceReceipts) {
        // Original bytes + parser version preserve every rejected record for
        // recovery; the bounded graph receipt stores the accurate count.
        receipt.rejectedCount = receipt.rejected.length; delete receipt.rejected
      }
      const status = source.error ? 'failed' : source.skipped ? 'skipped' : accepted.length ? 'partial' : 'failed'
      job.sources.push({ ...receipt, id: sourceId, ...(job.consent ? { consent: structuredClone(job.consent) } : {}), acceptedCount: accepted.length, indexedCount: 0,
        status,
      })
      for (const row of accepted) assertions.push({
        id: privateId(ownerId, 'assertion', sourceId, row.rowId), ownerId, sourceId, importId: id,
        visibility: 'owner', ...row,
      })
      job.counts.accepted += accepted.length
      job.counts.rejected += source.rejected.length
      job.counts.skippedFiles += source.skipped ? source.skippedFileCount ?? 1 : 0
      job.counts.failedFiles += Number(status === 'failed')
    }
    const supportError = store.validatePublication?.(job, assertions)
    if (supportError) {
      job.status = 'failed'; job.phase = 'unsupported_private_publication'; job.error = supportError
      job.unsupportedSourceIds = job.sources.map(source => source.id); job.sources = []
      job.indexGate = Object.hasOwn(store, 'publicationGate') ? store.publicationGate : 'noos_private_index_not_connected'; job.revision++
      await store.saveJob(job)
      return job
    }
    // Publication is one atomic operation. Retrying an interrupted parsing job
    // cannot accumulate row counts or reveal only half an owner's assertions.
    job.status = job.counts.accepted ? (store.publicationStatus ?? 'partial') : 'failed'
    if (job.status === 'indexed' && (job.counts.rejected || job.counts.failedFiles)) job.status = 'partial'
    if (job.counts.accepted && store.publicationStatus === 'indexed') job.counts.indexed = job.counts.accepted
    job.phase = job.counts.accepted ? (store.publicationPhase ?? 'awaiting_private_index') : 'no_accepted_rows'
    job.indexGate = Object.hasOwn(store, 'publicationGate') ? store.publicationGate : 'noos_private_index_not_connected'; job.revision++
    await store.publish(job, assertions)
    return job
  })
}
