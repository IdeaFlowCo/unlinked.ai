// A published public dataset revision is immutable, but reading one (all of
// its chunks, then hashing and validating them) costs most of a second for the
// recovered legacy dataset. Keep the last snapshot read for each dataset and
// reuse it while a cheap pointer read says the same revision is still the
// published one. Every read still asks the graph, so a revoke or a new
// publication is seen by the very next request.

const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 64 * 1024 * 1024

const retainedBytes = (value, limit) => {
  if (typeof value === 'string') return 32 + value.length * 2
  if (value === null || typeof value !== 'object') return 16
  let bytes = 64
  for (const key of Object.keys(value)) {
    bytes += 32 + key.length * 2 + retainedBytes(value[key], limit - bytes)
    if (bytes > limit) break
  }
  return bytes
}

// `currentRevision(dataset)` returns the published revision and its digest, or
// null. Any failure there falls through to the store's own full read.
export function cachePublicPeopleReads(store, currentRevision, { maxEntries = MAX_CACHE_ENTRIES, maxBytes = MAX_CACHE_BYTES } = {}) {
  if (!store || typeof store.read !== 'function' || typeof currentRevision !== 'function') return store
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_CACHE_ENTRIES || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_CACHE_BYTES) throw new RangeError('Invalid public dataset cache limits')
  const kept = new Map()
  let bytes = 0
  const remove = dataset => {
    const entry = kept.get(dataset)
    if (entry) bytes -= entry.bytes
    kept.delete(dataset)
  }
  const read = async dataset => {
    const held = kept.get(dataset)
    const pointer = await Promise.resolve().then(() => currentRevision(dataset)).catch(() => null)
    if (held && kept.get(dataset) === held && pointer && pointer.revision === held.revision && pointer.digest === held.digest) {
      kept.delete(dataset)
      kept.set(dataset, held)
      return held.snapshot
    }
    remove(dataset)
    const snapshot = await store.read(dataset)
    // Cache only when the snapshot read is the revision the pointer named, so
    // a publication racing this read is never kept under the wrong digest.
    remove(dataset)
    if (snapshot && pointer && snapshot.revision === pointer.revision && maxEntries > 0) {
      const entry = { revision: pointer.revision, digest: pointer.digest, snapshot }
      const size = retainedBytes({ dataset, ...entry }, maxBytes)
      if (size <= maxBytes) {
        while (kept.size >= maxEntries || bytes + size > maxBytes) remove(kept.keys().next().value)
        kept.set(dataset, { ...entry, snapshot: deepFreeze(snapshot), bytes: size })
        bytes += size
      }
    }
    return snapshot
  }
  return new Proxy(store, { get: (target, key) => key === 'read' ? read : typeof target[key] === 'function' ? target[key].bind(target) : target[key] })
}

// The pointer read the Noos public store uses, without its chunks.
export const publishedRevisionReader = (driver, database = 'neo4j') => async dataset => {
  const session = driver.session({ database, defaultAccessMode: 'READ' })
  try {
    const result = await session.executeRead(tx => tx.run(`MATCH (p:UnlinkedPublicDataset {id:$dataset})
      MATCH (r:UnlinkedPublicRevision {dataset:$dataset,revision:p.revision}) WHERE r.state='published'
      RETURN r.revision AS revision, r.digest AS digest LIMIT 1`, { dataset }))
    const record = result.records[0]
    return record ? { revision: record.get('revision'), digest: record.get('digest') } : null
  } finally { await session.close() }
}
