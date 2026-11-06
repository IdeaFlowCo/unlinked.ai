// Owner-scoped cache of a finished import's verified observation rows.
//
// Each row is its own operational resource, so reading an owner network
// costs one loopback HTTP + graph round trip per connection: a 4,416-row
// network took 42-85 s on every unlinked_list_connections / ai_search call.
// Observations are written once and an indexed import's sourceRevision
// changes on any republication, so (owner, import, sourceRevision) names an
// immutable row set. The reader still re-reads the import resource on every
// call (live, same revision) before and after using cached rows, so a
// tombstoned or republished import is never served from here.
//
// Rows are only tombstoned individually while the owner's whole account data
// is erased (account-data.mjs), which calls forgetOwner first; the generation
// counter stops a fill that started before that from re-inserting its rows.
export const IMPORT_ROW_CACHE_MAX_ROWS = 60000
export const IMPORT_ROW_CACHE_TTL_MS = 30 * 60 * 1000
const FILL_TIMEOUT_MS = 180000

export function createImportRowCache({ maxRows = IMPORT_ROW_CACHE_MAX_ROWS, ttlMs = IMPORT_ROW_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('import_row_cache_configuration_invalid')
  const entries = new Map() // key -> { ownerId, ids, rows, at }; Map order is LRU order
  const inflight = new Map() // key -> Promise<{ ids, rows }>
  const generations = new Map() // ownerId -> integer
  let total = 0
  const keyOf = (ownerId, importId, revision) => `${ownerId}\0${importId}\0${revision}`
  const generation = ownerId => generations.get(ownerId) ?? 0
  const drop = key => { const entry = entries.get(key); if (entry) { total -= entry.rows.length; entries.delete(key) } }
  const store = (key, ownerId, value) => {
    if (value.rows.length > maxRows) return
    drop(key)
    entries.set(key, { ownerId, ids: value.ids, rows: value.rows, at: now() })
    total += value.rows.length
    for (const oldest of entries.keys()) { if (total <= maxRows) break; drop(oldest) }
  }
  return {
    // Returns { ids, rows } for this exact owner/import/revision, or null.
    get(ownerId, importId, revision) {
      const key = keyOf(ownerId, importId, revision), entry = entries.get(key)
      if (!entry) return null
      if (now() - entry.at > ttlMs) { drop(key); return null }
      entries.delete(key); entries.set(key, entry)
      return { ids: entry.ids, rows: entry.rows }
    },
    // Runs fill once per key, detached from any one caller's signal so a
    // caller that hits its deadline still leaves a warm cache for the retry.
    // The caller's own signal bounds only its wait.
    async load(ownerId, importId, revision, fill, signal) {
      signal?.throwIfAborted()
      const key = keyOf(ownerId, importId, revision)
      let pending = inflight.get(key)
      if (!pending) {
        const startedAt = generation(ownerId)
        pending = Promise.resolve().then(() => fill(AbortSignal.timeout(FILL_TIMEOUT_MS))).then(value => {
          if (generation(ownerId) === startedAt) store(key, ownerId, value)
          return value
        })
        const settled = () => { if (inflight.get(key) === pending) inflight.delete(key) }
        pending.then(settled, settled)
        inflight.set(key, pending)
      }
      if (!signal) return pending
      return Promise.race([pending, new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })])
    },
    forgetOwner(ownerId) {
      generations.set(ownerId, generation(ownerId) + 1)
      for (const [key, entry] of entries) if (entry.ownerId === ownerId) drop(key)
      for (const key of inflight.keys()) if (key.startsWith(`${ownerId}\0`)) inflight.delete(key)
    },
    stats: () => ({ entries: entries.size, rows: total, inflight: inflight.size }),
  }
}

// One per process: the runtime serves every owner from one Node process.
export const sharedImportRowCache = createImportRowCache()
