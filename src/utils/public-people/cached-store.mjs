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

// `currentRevision(dataset)` returns the published revision and its digest, or
// null. Any failure there falls through to the store's own full read.
export function cachePublicPeopleReads(store, currentRevision) {
  if (!store || typeof store.read !== 'function' || typeof currentRevision !== 'function') return store
  const kept = new Map()
  const read = async dataset => {
    const held = kept.get(dataset)
    const pointer = await Promise.resolve().then(() => currentRevision(dataset)).catch(() => null)
    if (held && pointer && pointer.revision === held.revision && pointer.digest === held.digest) return held.snapshot
    const snapshot = await store.read(dataset)
    // Cache only when the snapshot read is the revision the pointer named, so
    // a publication racing this read is never kept under the wrong digest.
    if (snapshot && pointer && snapshot.revision === pointer.revision) kept.set(dataset, { revision: pointer.revision, digest: pointer.digest, snapshot: deepFreeze(snapshot) })
    else kept.delete(dataset)
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
