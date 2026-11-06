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
// is erased (account-data.mjs), which wraps the erase in beginErase/endErase:
// while an owner is erasing the cache is bypassed entirely (reads go to the
// live store), and the generation counter discards any fill that started
// before. Any future path that tombstones individual rows must do the same.
export const IMPORT_ROW_CACHE_MAX_ROWS = 60000
// Rows can be large (asset-backed observations), so bytes are capped too.
export const IMPORT_ROW_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const IMPORT_ROW_CACHE_TTL_MS = 30 * 60 * 1000
const FILL_TIMEOUT_MS = 180000

export function createImportRowCache({ maxRows = IMPORT_ROW_CACHE_MAX_ROWS, maxBytes = IMPORT_ROW_CACHE_MAX_BYTES, ttlMs = IMPORT_ROW_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('import_row_cache_configuration_invalid')
  const entries = new Map() // key -> { ownerId, ids, rows, at }; Map order is LRU order
  const inflight = new Map() // key -> Promise<{ ids, rows }>
  const generations = new Map() // ownerId -> integer
  const erasing = new Map() // ownerId -> active erase count
  let total = 0, totalBytes = 0
  const keyOf = (ownerId, importId, revision) => `${ownerId}\0${importId}\0${revision}`
  const generation = ownerId => generations.get(ownerId) ?? 0
  const drop = key => { const entry = entries.get(key); if (entry) { total -= entry.rows.length; totalBytes -= entry.bytes; entries.delete(key) } }
  const store = (key, ownerId, value) => {
    if (erasing.get(ownerId) || value.rows.length > maxRows) return
    let bytes = 0
    try { bytes = Buffer.byteLength(JSON.stringify(value.rows)) } catch { return }
    if (bytes > maxBytes) return
    drop(key)
    const at = now()
    for (const [old, entry] of entries) if (at - entry.at > ttlMs) drop(old)
    entries.set(key, { ownerId, ids: value.ids, rows: value.rows, bytes, at })
    total += value.rows.length; totalBytes += bytes
    for (const oldest of entries.keys()) { if (total <= maxRows && totalBytes <= maxBytes) break; drop(oldest) }
  }
  return {
    // Returns { ids, rows } for this exact owner/import/revision, or null.
    get(ownerId, importId, revision) {
      if (erasing.get(ownerId)) return null
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
      // Mid-erase: read live, exactly like an uncached reader, and keep nothing.
      if (erasing.get(ownerId)) return fill(signal)
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
    beginErase(ownerId) { erasing.set(ownerId, (erasing.get(ownerId) ?? 0) + 1); this.forgetOwner(ownerId) },
    endErase(ownerId) {
      this.forgetOwner(ownerId)
      const left = (erasing.get(ownerId) ?? 1) - 1
      if (left > 0) erasing.set(ownerId, left); else erasing.delete(ownerId)
    },
    stats: () => ({ entries: entries.size, rows: total, bytes: totalBytes, inflight: inflight.size }),
  }
}

// One per process: the runtime serves every owner from one Node process.
export const sharedImportRowCache = createImportRowCache()
