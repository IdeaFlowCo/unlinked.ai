// One honest answer to "has this member brought their LinkedIn data, and how
// did it go?" for the signed-in home, profile and import pages (unlinked-5e5).
// Two sources count, the same two that the agent `whoami` tool and the export
// reminder email already count:
//   - uploads to this runtime: durable import jobs (payloads from /upload);
//   - LinkedIn files recovered from the member's original Unlinked account
//     (legacy storage, listed by `readLegacyFiles`), or, when no files were
//     recovered, the connections of the confirmed legacy profile itself.
// It only reads; it never changes an import or its status.
import { importJobStatus } from './background-job.mjs'

const ACTIVE = new Set(['uploaded', 'parsing', 'indexing'])
const STATES = Object.freeze(['none', 'in_progress', 'complete', 'partial', 'failed', 'unknown'])
export const IMPORT_SUMMARY_STATES = STATES

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const at = value => Number.isSafeInteger(value) && value > 0 ? value : null
// A partial upload whose files all read is finished: only some rows were skipped.
const finished = job => job.status === 'indexed' || (job.status === 'partial' && !count(job.counts?.failedFiles))

const upload = payload => {
  const status = importJobStatus(payload)
  return {
    source: 'upload', id: payload.id, status: payload.status, at: at(payload.createdAt),
    records: count(payload.counts?.accepted), indexed: count(payload.counts?.indexed), skipped: count(payload.counts?.rejected),
    failedFiles: count(payload.counts?.failedFiles), ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}),
    complete: finished(payload), active: ACTIVE.has(payload.status), job: status,
  }
}

// Recovered legacy files: per-category accepted rows, and the original upload
// time (each file's storage timestamp, the newest when there are several).
const recoveredFiles = (files, legacyConnections) => {
  const objects = Array.isArray(files?.objects) ? files.objects : null
  if (!objects?.length) {
    const connections = count(legacyConnections)
    return connections ? { source: 'recovered', files: 0, connections, skipped: 0, profile: false, positions: 0, education: 0, skills: 0, at: null, complete: true } : null
  }
  const sum = (category, key = 'accepted') => objects.filter(file => file.category === category).reduce((total, file) => total + count(file[key]), 0)
  const times = objects.map(file => at(file.uploadedAt)).filter(Boolean)
  const value = {
    source: 'recovered', files: objects.length, connections: sum('connections'), skipped: sum('connections', 'rejected'),
    profile: sum('profile') > 0, positions: sum('positions'), education: sum('education'), skills: sum('skills'),
    at: times.length ? Math.max(...times) : null,
  }
  return { ...value, complete: value.connections > 0 || value.profile || value.positions > 0 }
}

/**
 * @param {object} input
 * @param {object[]} [input.jobs] upload job payloads for this owner (hand-added people excluded by the caller)
 * @param {object|null} [input.recovered] `readLegacyFiles()` result, or null when the account has none
 * @param {number} [input.legacyConnections] connections of the confirmed legacy profile (used only when no files were recovered)
 * @param {boolean} [input.recoveredUnavailable] the recovered-files read failed, so absence is not known
 */
export function summarizeImports({ jobs = [], recovered = null, legacyConnections = 0, recoveredUnavailable = false } = {}) {
  const uploads = jobs.filter(payload => payload && typeof payload.id === 'string' && typeof payload.status === 'string').map(upload)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.id.localeCompare(a.id))
  const legacy = recoveredFiles(recovered, legacyConnections)
  const active = uploads.find(value => value.active) ?? null
  // Newest finished source wins; a recovered archive without a date is older than any upload.
  const finishedSources = [...uploads.filter(value => value.complete), ...(legacy?.complete ? [legacy] : [])]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const lastComplete = finishedSources[0] ?? null
  const newestUpload = uploads.find(value => !value.active) ?? null
  // A newer upload that failed or only partly read is worth saying, even when an earlier import stands.
  const attention = newestUpload && !newestUpload.complete && (!lastComplete || (newestUpload.at ?? 0) > (lastComplete.at ?? 0)) ? newestUpload : null
  let state
  if (active) state = 'in_progress'
  else if (lastComplete) state = 'complete'
  else if (attention?.status === 'partial' || (legacy && !legacy.complete)) state = 'partial'
  else if (attention?.status === 'failed') state = 'failed'
  else if (recoveredUnavailable) state = 'unknown'
  else state = 'none'
  return {
    state, active, lastComplete, attention: state === 'complete' || state === 'partial' || state === 'failed' ? attention : null,
    recovered: legacy, uploads: uploads.length,
    // Anything at all to show: the onboarding reminder is for members with nothing.
    hasImport: state !== 'none' && state !== 'unknown',
  }
}

