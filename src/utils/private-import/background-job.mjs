import { randomUUID } from 'node:crypto'
import { digest, LIMITS, parseArchive, PARSER_VERSION, RUNNABLE_PARSER_VERSIONS } from './archive.mjs'
import { privateId } from './job.mjs'
import { requireCombinedUploadConsent } from './consent.mjs'
import { firstWorkingPhoto } from './profile-photo.mjs'

const terminal = job => ['indexed', 'partial', 'failed'].includes(job.status)
const ownCategories = new Set(['profile', 'positions', 'education', 'skills'])
const counts = () => ({ accepted: 0, rejected: 0, skippedFiles: 0, failedFiles: 0, indexed: 0 })
const LEASE_MS = 180000
// Only fixed lower-case codes leave the worker; never messages with data in them.
const codes = new Set(['private_worker_stopped', 'private_import_owner_invalid', 'private_archive_recovery_invalid', 'private_worker_discovery_limit',
  'private_upload_consent_required', 'tombstone_conflict', 'verified_owner_required', 'private_import_deleted', 'private_import_not_found',
  'private_noos_binding_not_found', 'private_noos_timeout', 'private_owner_mismatch', 'private_publication_incomplete',
  'private_publication_support_limit', 'private_resource_key_invalid', 'private_asset_key_invalid', 'private_asset_invalid',
  'private_observation_recovery_unavailable', ...Array.from({ length: 500 }, (_, i) => `private_noos_${i + 100}`)])
const phases = new Set(['uploaded', 'parsing', 'failed', 'unsupported_private_publication', 'no_accepted_rows', 'staging_private_observations', 'private_observation_index_ready'])
const safeCode = value => codes.has(value) ? value : 'unknown'
const jobNumbers = job => ({ accepted: job.counts?.accepted ?? 0, rejected: job.counts?.rejected ?? 0, indexed: job.counts?.indexed ?? 0,
  failedFiles: job.counts?.failedFiles ?? 0, sources: Array.isArray(job.sources) ? job.sources.length : 0 })

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
export async function runArchiveJob({ ownerId, id, adapter, readAsset, now = Date.now, leaseId = randomUUID(), stopped = () => false, onProgress = () => {}, onParsedSources = () => {}, fetchProfilePhoto }) {
  return adapter.withImport(ownerId, id, async store => {
    let current = await store.getJob(id)
    if (!current || terminal(current) || current.backgroundVersion !== 'profile-first-v1') return current
    if (current.ownerId !== ownerId || !RUNNABLE_PARSER_VERSIONS.includes(current.parserVersion)) throw new Error('private_import_owner_invalid')
    if (current.lease && current.lease.expiresAt > now() && current.lease.id !== leaseId) return current
    requireCombinedUploadConsent(current.consent)
    const save = async changes => {
      if (stopped()) throw new Error('private_worker_stopped')
      const next = { ...current, ...changes, revision: current.revision + 1,
        lease: { id: leaseId, expiresAt: now() + LEASE_MS } }
      await store.saveJob(next)
      current = next
      onProgress()
    }
    await save({ status: 'parsing', phase: 'parsing', ...(current.parserVersion !== PARSER_VERSION ? { parsedWith: PARSER_VERSION } : {}) })
    const bytes = await readAsset(current.archiveSha256)
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.archiveBytes || digest(bytes) !== current.archiveSha256) throw new Error('private_archive_recovery_invalid')
    let parsed
    try { parsed = parseArchive(bytes, current.filename) }
    catch (error) {
      await save({ status: 'failed', phase: 'failed', error: 'archive_parse_failed', failureReason: /^[a-z0-9_]{1,64}$/.test(error?.message) ? error.message : 'unknown', progress: { processed: 0, total: null, profileReady: false } })
      return current
    }
    onParsedSources(parsed.sources.length)
    // The owner's profile photo (docs/profile-photos.md): the newest link that
    // downloads becomes one owner-private asset and one observation holding
    // only its hash, type and size. Without a fetcher, or when none works,
    // the source is skipped with a reason; the import itself is unaffected.
    for (const source of parsed.sources) {
      if (source.category !== 'profile_photo' || !source.accepted.length) continue
      const found = typeof fetchProfilePhoto === 'function' ? await firstWorkingPhoto(source.accepted, { fetchPhoto: fetchProfilePhoto, now }) : { reason: 'photo_import_off' }
      if (!found.photo) { Object.assign(source, { accepted: [], skipped: true, photoSkipped: found.reason }); continue }
      await store.putAsset(found.photo.sha256, found.photo.bytes)
      source.accepted = [{ rowId: found.row.rowId, category: 'profile_photo', subject: 'archive_owner_observation',
        fields: { 'photo sha256': found.photo.sha256, 'photo type': found.photo.type, 'photo bytes': String(found.photo.bytes.length), 'uploaded at': new Date(found.row.uploadedAt).toISOString() } }]
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
      await save({ status: 'failed', phase: supportError ? 'unsupported_private_publication' : 'no_accepted_rows', error: supportError ?? 'no_accepted_rows',
        ...(supportError ? {} : { failureReason: emptyImportReason(sources) }), counts: totals })
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
export function createArchiveWorker({ listPendingImports, getBackend, coordination, intervalMs = 2000, slowAfterMs = 10 * 60 * 1000, onError = () => {}, now = Date.now, fetchProfilePhoto }) {
  if (typeof listPendingImports !== 'function' || typeof getBackend !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('private_worker_configuration_required')
  let closed = false, discovery = null, timer, active = 0, discoveryFailures = 0
  const scheduled = new Map(), ownerTails = new Map(), waiters = []
  // Per-job failure history, so a job that keeps failing is visible (reason,
  // attempt, first failure) instead of retrying silently every interval.
  const failures = new Map(), finished = new Set(), notRunnable = new Set()
  const notify = event => { void Promise.resolve().then(() => onError(event)).catch(() => {}) }
  const slot = () => new Promise(resolve => {
    const enter = () => { active++; resolve(() => { active--; waiters.shift()?.() }) }
    if (active < 8) enter(); else waiters.push(enter)
  })
  const schedule = item => {
    const key = JSON.stringify([item.owner.ownerId, item.id])
    if (scheduled.has(key)) return scheduled.get(key)
    const ownerId = item.owner.ownerId
    const work = (ownerTails.get(ownerId) ?? Promise.resolve()).then(async () => {
      if (closed) return
      const releaseSlot = await slot()
      try {
        if (closed) return
        const release = coordination ? coordination.tryAcquireShared('owner:' + ownerId) : () => {}
        if (!release) return
        const startedAt = now()
        // A run still going after slowAfterMs is reported once (long delay, no error).
        const slow = setTimeout(() => { void notify({ event: 'import_job_running_long', importId: item.id, elapsedMs: now() - startedAt }) }, slowAfterMs)
        slow.unref?.()
        try {
          const backend = await getBackend(item.owner)
          let progressed = false, parsedSources
          const result = await runArchiveJob({ ownerId, id: item.id, adapter: backend.adapter, readAsset: backend.readAsset, now, stopped: () => closed, onProgress: () => { progressed = true }, onParsedSources: count => { parsedSources = count }, fetchProfilePhoto })
          const history = failures.get(key)
          if (progressed || (result && terminal(result))) failures.delete(key)
          if (result && terminal(result) && !finished.has(key)) {
            finished.add(key)
            notify({ event: 'import_job_finished', importId: item.id, status: result.status, phase: phases.has(result.phase) ? result.phase : 'unknown',
              durationMs: now() - startedAt, ...jobNumbers(result), ...(parsedSources === undefined ? {} : { sources: parsedSources }), ...(history ? { attemptsBeforeSuccess: history.attempt } : {}) })
          } else if (result && !terminal(result) && result.backgroundVersion !== 'profile-first-v1' && !notRunnable.has(key)) {
            notRunnable.add(key)
            notify({ event: 'import_job_not_runnable', importId: item.id, reason: 'background_version_unsupported' })
          }
        } finally { clearTimeout(slow); release() }
      } finally { releaseSlot() }
    }).catch(error => {
      if (closed && error?.message === 'private_worker_stopped') return
      const previous = failures.get(key)
      const attempt = (previous?.attempt ?? 0) + 1, firstFailedAt = previous?.firstFailedAt ?? now()
      failures.set(key, { attempt, firstFailedAt })
      // Report attempts 1, 2, 4, 8, ... so a poison job cannot fill the
      // bounded audit file; flag it as stuck once, at the fifth attempt.
      if ((attempt & (attempt - 1)) === 0) return notify({ event: 'import_worker_retry', importId: item.id, reason: safeCode(error?.message), attempt, failingForMs: now() - firstFailedAt })
      if (attempt === 5) return notify({ event: 'import_worker_stuck', importId: item.id, reason: safeCode(error?.message), attempt, failingForMs: now() - firstFailedAt })
    })
    const settled = work.finally(() => { scheduled.delete(key); if (ownerTails.get(ownerId) === settled) ownerTails.delete(ownerId) })
    scheduled.set(key, settled)
    ownerTails.set(ownerId, settled)
    return settled
  }
  const tick = () => {
    if (closed) return Promise.resolve()
    if (discovery) return discovery.then(jobs => Promise.all(jobs))
    discovery = (async () => {
      const pending = await listPendingImports()
      if (!Array.isArray(pending) || pending.length > 200) throw new Error('private_worker_discovery_limit')
      return pending.map(schedule)
    })().then(jobs => { discoveryFailures = 0; return jobs }, async error => {
      discoveryFailures++
      // Same 1, 2, 4, 8, ... throttle: a lasting outage stays visible without flooding.
      if ((discoveryFailures & (discoveryFailures - 1)) === 0) notify({ event: 'import_worker_discovery_failed', reason: safeCode(error?.message), attempt: discoveryFailures })
      return []
    }).finally(() => { discovery = null })
    return discovery.then(jobs => Promise.all(jobs))
  }
  return { tick, start() { if (!timer && !closed) { timer = setInterval(tick, intervalMs); timer.unref?.(); void tick() } },
    async stop() { closed = true; clearInterval(timer); if (discovery) await discovery; await Promise.all(scheduled.values()) } }

}

export function importJobStatus(job) {
  return { id: job.id, status: job.status, profileReady: job.progress?.profileReady === true,
    processed: job.progress?.processed ?? (terminal(job) ? job.counts?.indexed ?? 0 : 0),
    total: job.progress?.total ?? (terminal(job) ? job.counts?.accepted ?? 0 : null),
    rejected: job.counts?.rejected ?? 0, failedFiles: job.counts?.failedFiles ?? 0,
    statusUrl: `/imports/${job.id}/status`,
    ...(job.error ? { errorMessage: importErrorMessage(job) } : {}) }
}

// Why a file produced no people, from its per-file receipts. The first
// specific cause wins; a file we do not read at all is the commonest one.
export function emptyImportReason(sources) {
  const read = sources.filter(source => !source.skipped)
  if (!read.length) return 'unrecognized_file'
  const error = read.map(source => source.error).find(Boolean)
  if (['invalid_utf8', 'csv_header_not_found', 'invalid_csv_header'].includes(error)) return error
  if (error) return 'csv_unreadable'
  return read.some(source => source.rejectedCount ?? source.rejected?.length) ? 'rows_rejected' : 'no_rows'
}

const READS = 'Unlinked reads Connections.csv (and Profile.csv, Positions.csv, Education.csv, Skills.csv) from your LinkedIn export, or the whole export ZIP.'
const failureMessages = {
  unrecognized_file: name => `We didn’t recognize “${name}”. ${READS} If you renamed the file, name it Connections.csv and upload it again.`,
  csv_header_not_found: name => `“${name}” is missing the First Name, Last Name and URL columns. Upload the file as LinkedIn exported it, without removing or renaming columns.`,
  invalid_csv_header: name => `“${name}” has a repeated or blank column name. Upload the file as LinkedIn exported it.`,
  invalid_utf8: name => `“${name}” isn’t saved as UTF-8 text. Upload the file straight from your LinkedIn export, or re-save it as “CSV UTF-8”.`,
  csv_unreadable: name => `“${name}” isn’t a CSV file we can read. Upload the file as LinkedIn exported it.`,
  rows_rejected: name => `No row in “${name}” had a first name, last name and a linkedin.com/in/ profile address, so no one was added.`,
  no_rows: name => `“${name}” has no people in it.`,
  unsupported_archive_format: () => 'Only .zip and .csv files can be imported.',
  file_size_limit: () => 'This CSV is larger than 8 MB. Upload the whole export ZIP instead.',
  archive_size_limit: () => 'This file is larger than 64 MB. Upload Connections.csv on its own instead.',
  archive_row_limit: () => 'This file has more than 100,000 rows, more than Unlinked can import at once. Upload Connections.csv on its own instead.',
  private_publication_support_limit: () => 'This file is larger than Unlinked can import at once. Upload Connections.csv on its own instead.',
}

// Plain-language reason for a failed or partial import. Jobs saved before
// failureReason existed fall back to the stored error code.
export function importErrorMessage(job) {
  const name = String(job?.filename ?? 'this file').slice(0, 120)
  const reason = job?.failureReason ?? job?.error
  if (failureMessages[reason]) return failureMessages[reason](name)
  if (job?.error === 'no_accepted_rows') return `No people were found in “${name}”. ${READS} If you renamed the file, name it Connections.csv and upload it again.`
  if (job?.error === 'archive_parse_failed') return `We couldn’t open “${name}”. Upload the ZIP or CSV exactly as LinkedIn exported it.`
  return 'This file could not be fully imported. See Settings for details.'
}
