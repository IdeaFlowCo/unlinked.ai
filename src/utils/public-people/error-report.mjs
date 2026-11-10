// Fixed-vocabulary error reports for the public People index (worker and
// reader). They name an error's class and its first public-people source
// location only: never its message, stack text or any data.
const ERROR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'DataCloneError'])
export const errorClass = error => ERROR_CLASSES.has(error?.name) ? error.name : 'other'
export const errorLocation = error => {
  const match = typeof error?.stack === 'string' ? /public-people\/([a-z0-9-]+\.mjs):(\d+):\d+/.exec(error.stack) : null
  return match ? `${match[1]}:${match[2]}` : 'unknown'
}
// One stderr line, e.g. `unlinked_public_index_worker_error method=lookup class=TypeError at=reader.mjs:531`.
export function reportIndexError(kind, method, error) {
  try { process.stderr.write(`unlinked_public_index_${kind}_error method=${method} class=${errorClass(error)} at=${errorLocation(error)}\n`) } catch { /* reporting never fails a read */ }
}
