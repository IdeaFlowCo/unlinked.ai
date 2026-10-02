import { randomUUID } from 'node:crypto'
import { digest, LIMITS, parseArchive, PARSER_VERSION } from './archive.mjs'
import { privateId } from './job.mjs'
import { requireCombinedUploadConsent } from './consent.mjs'

const terminal = job => ['indexed', 'partial', 'failed'].includes(job.status)
const ownCategories = new Set(['profile', 'positions', 'education', 'skills'])
const counts = () => ({ accepted: 0, rejected: 0, skippedFiles: 0, failedFiles: 0, indexed: 0 })
const LEASE_MS = 180000

// The original private asset and uploaded receipt must be durable before the
// browser receives a redirect. A browser disconnect never owns the worker.
// A person a member added by hand is staged as a one-row Connections.csv with
// this origin, so Settings and the import status can tell it from an export.
export const ADDED_PERSON = 'added-person'
const originValid = origin => origin === undefined || (origin && Object.keys(origin).length === 2 && origin.kind === ADDED_PERSON && typeof origin.label === 'string' && origin.label.trim() && [...origin.label].length <= 241)
export async function stageArchive({ ownerId, filename, bytes, adapter, consent, origin, now = Date.now }) {
  requireCombinedUploadConsent(consent)
  if (!originValid(origin)) throw new Error('archive_origin_invalid')
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.archiveBytes) throw new Error('archive_size_limit')
  const archiveSha256 = digest(bytes), id = privateId(ownerId, 'import', archiveSha256, filename, PARSER_VERSION)
  return adapter.withImport(ownerId, id, async store => {
    const existing = await store.getJob(id)
    if (existing) return existing // Replay never broadens an older disclosure.
    const job = { id, ownerId, filename, archiveSha256, parserVersion: PARSER_VERSION,
      status: 'uploaded', phase: 'uploaded', revision: 1, createdAt: now(),
      counts: counts(), sources: [], consent: structuredClone(consent),
      backgroundVersion: 'profile-first-v1', progress: { processed: 0, total: null, profileReady: false }, ...(origin ? { origin: structuredClone(origin) } : {}) }
    await store.putAsset(archiveSha256, bytes)
    try { await store.saveJob(job) }
    catch (error) {
      // A commit with a lost HTTP response is a successful stage. A concurrent
      // different receipt or a tombstone must still fail closed.
      const replay = await store.getJob(id)
      if (!replay || replay.archiveSha256 !== archiveSha256 || replay.ownerId !== ownerId || replay.parserVersion !== PARSER_VERSION) throw error
      return replay
    }
    return job
  })
}

// CAS on every lease/progress receipt fences delayed publishers. Immutable
// chunks may survive a crash, but search/MCP require the final job publication.
export async function runArchiveJob({ ownerId, id, adapter, readAsset, now = Date.now, leaseId = randomUUID(), stopped = () => false }) {
  return adapter.withImport(ownerId, id, async store => {
    let current = await store.getJob(id)
    if (!current || terminal(current) || current.backgroundVersion !== 'profile-first-v1') return current
    if (current.ownerId !== ownerId || current.parserVersion !== PARSER_VERSION) throw new Error('private_import_owner_invalid')
    if (current.lease && current.lease.expiresAt > now() && current.lease.id !== leaseId) return current
    requireCombinedUploadConsent(current.consent)
    const save = async changes => {
      if (stopped()) throw new Error('private_worker_stopped')
      const next = { ...current, ...changes, revision: current.revision + 1,
        lease: { id: leaseId, expiresAt: now() + LEASE_MS } }
      await store.saveJob(next)
      current = next
    }
    await save({ status: 'parsing', phase: 'parsing' })
    const bytes = await readAsset(current.archiveSha256)
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.archiveBytes || digest(bytes) !== current.archiveSha256) throw new Error('private_archive_recovery_invalid')
    let parsed
    try { parsed = parseArchive(bytes, current.filename) }
    catch {
      await save({ status: 'failed', phase: 'failed', error: 'archive_parse_failed', progress: { processed: 0, total: null, profileReady: false } })
      return current
    }
    const sources = [], assertions = [], totals = counts()
    // Stable source IDs preserve old receipts. Only staging order changes:
    // profile observations precede connections, regardless of ZIP entry order.
    parsed.sources.sort((a, b) => Number(ownCategories.has(b.category)) - Number(ownCategories.has(a.category)))
    for (const source of parsed.sources) {
      await store.putAsset(source.sha256, source.rawBytes)
      const sourceId = privateId(ownerId, 'source', id, source.path, source.sha256)
      const receipt = { ...source }; delete receipt.rawBytes; delete receipt.accepted
      if (store.compactSourceReceipts) { receipt.rejectedCount = source.rejected.length; delete receipt.rejected }
      const status = source.error ? 'failed' : source.skipped ? 'skipped' : source.accepted.length ? 'partial' : 'failed'
      sources.push({ ...receipt, id: sourceId, consent: structuredClone(current.consent), acceptedCount: source.accepted.length, indexedCount: 0, status })
      for (const row of source.accepted) assertions.push({ id: privateId(ownerId, 'assertion', sourceId, row.rowId), ownerId, sourceId, importId: id, visibility: 'owner', ...row })
      totals.accepted += source.accepted.length; totals.rejected += source.rejected.length
      totals.skippedFiles += source.skipped ? source.skippedFileCount ?? 1 : 0; totals.failedFiles += Number(status === 'failed')
    }
    const candidate = { ...current, sources, counts: totals }
    const supportError = store.validatePublication?.(candidate, assertions)
    if (supportError || !totals.accepted) {
      await save({ status: 'failed', phase: supportError ? 'unsupported_private_publication' : 'no_accepted_rows', error: supportError ?? 'no_accepted_rows', counts: totals })
      return current
    }
    await save({ status: 'indexing', phase: 'staging_private_observations', counts: totals,
      stagedChunks: current.stagedChunks ?? [], progress: { processed: current.progress?.processed ?? 0, total: assertions.length, profileReady: current.progress?.profileReady ?? false } })
    const final = { ...current, sources, counts: { ...totals, indexed: assertions.length },
      status: totals.rejected || totals.failedFiles ? 'partial' : 'indexed', phase: 'private_observation_index_ready', indexGate: null,
      lease: null, revision: current.revision + 1 }
    delete final.stagedChunks
    await store.publish(final, assertions, { onChunk: async ({ chunkId, processed, profileReady }) => {
      await save({ stagedChunks: current.stagedChunks.includes(chunkId) ? current.stagedChunks : [...current.stagedChunks, chunkId],
        progress: { processed: Math.max(current.progress.processed, processed), total: assertions.length, profileReady: current.progress.profileReady || profileReady } })
      final.revision = current.revision + 1
      final.progress = structuredClone(current.progress)
    } })
    return final
  })
}

// One process-wide worker; Noos discovery + CAS leases make restart and a
// second process safe. There is no separate people database or fixture fallback.
export function createArchiveWorker({ listPendingImports, getBackend, intervalMs = 2000, onError = () => {}, now = Date.now }) {
  if (typeof listPendingImports !== 'function' || typeof getBackend !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('private_worker_configuration_required')
  let closed = false, running = null, timer
  const notify = async event => { try { await onError(event) } catch { /* Logging never changes job authority or worker recovery. */ } }
  const tick = () => {
    if (closed || running) return running ?? Promise.resolve()
    running = (async () => {
      const pending = await listPendingImports()
      if (!Array.isArray(pending) || pending.length > 200) throw new Error('private_worker_discovery_limit')
      for (const item of pending) {
        if (closed) break
        try {
          const backend = await getBackend(item.owner)
          await runArchiveJob({ ownerId: item.owner.ownerId, id: item.id, adapter: backend.adapter, readAsset: backend.readAsset, now, stopped: () => closed })
        } catch { await notify({ event: 'import_worker_retry', importId: item.id }) }
      }
    })().catch(() => notify({ event: 'import_worker_discovery_failed' })).finally(() => { running = null })
    return running
  }
  return { tick, start() { if (!timer && !closed) { timer = setInterval(tick, intervalMs); timer.unref?.(); void tick() } },
    async stop() { closed = true; clearInterval(timer); await running } }
}

export function importJobStatus(job) {
  return { id: job.id, status: job.status, profileReady: job.progress?.profileReady === true,
    processed: job.progress?.processed ?? (terminal(job) ? job.counts?.indexed ?? 0 : 0),
    total: job.progress?.total ?? (terminal(job) ? job.counts?.accepted ?? 0 : null), statusUrl: `/imports/${job.id}/status`,
    ...(job.error ? { errorMessage: 'This file could not be fully imported. See Settings for details.' } : {}) }
}
