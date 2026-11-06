import { parentPort } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { createPublicPeopleReader } from './reader.mjs'

// Worker side of the public People index host (index-host.mjs). Holds the
// compiled index for the newest snapshot of each source (and the previous one
// for a short grace period) and answers reader calls with the very same
// reader code the main thread used to run in-process.

const PREVIOUS_GRACE_MS = 60000
const METHODS = new Set(['suggest', 'list', 'profile', 'card', 'unlistedGroup', 'suspended', 'suspensions', 'addresses', 'lookupLinkedin', 'linkedinProfileIds', 'linkedinRef', 'lookup', 'linked', 'neighbors', 'company'])
const sources = new Map() // sourceKey -> { current, previous, timer }
const transfers = new Map() // transfer id -> { sourceKey, cacheKey, snapshot }
let nextTransfer = 1

const entryFor = (sourceKey, cacheKey) => {
  const slot = sources.get(sourceKey)
  if (slot?.current?.cacheKey === cacheKey) return slot.current
  if (slot?.previous?.cacheKey === cacheKey) return slot.previous
  return null
}
// One reader per (entry, page size, limits); all share the entry's source
// function and therefore its one compiled index.
const readerFor = (entry, pageSize, limits) => {
  const key = JSON.stringify([pageSize, limits.maxProfiles, limits.maxConnections, limits.maxTextBytes])
  let reader = entry.readers.get(key)
  if (!reader) {
    reader = createPublicPeopleReader({ readPublishedSnapshot: entry.source, pageSize, ...limits, timeoutMs: 30000, suggestFreshMs: 300000, suggestStaleMs: 300000 })
    entry.readers.set(key, reader)
  }
  return reader
}
const errorOf = error => ({ status: Number.isSafeInteger(error?.status) ? error.status : 503, code: typeof error?.code === 'string' ? error.code : 'public_people_unavailable' })

async function handle(message) {
  if (message.type === 'begin') {
    const id = nextTransfer++
    const snapshot = { ...message.meta }
    for (const [field, length] of Object.entries(message.lengths)) { snapshot[field] = []; snapshot[field].expected = length }
    // An install the main thread abandoned (it timed out or lost us) is dropped.
    const timer = setTimeout(() => transfers.delete(id), 300000); timer.unref?.()
    transfers.set(id, { sourceKey: message.sourceKey, cacheKey: message.cacheKey, snapshot, timer })
    return id
  }
  if (message.type === 'chunk') {
    const transfer = transfers.get(message.transfer)
    if (!transfer) throw { status: 503, code: 'public_people_unavailable' }
    const target = transfer.snapshot[message.field]
    for (const value of message.values) target.push(value)
    return true
  }
  if (message.type === 'end') {
    const transfer = transfers.get(message.transfer)
    transfers.delete(message.transfer)
    if (!transfer) throw { status: 503, code: 'public_people_unavailable' }
    clearTimeout(transfer.timer)
    const { sourceKey, cacheKey, snapshot } = transfer
    for (const field of Object.keys(snapshot)) if (Array.isArray(snapshot[field]) && 'expected' in snapshot[field]) {
      if (snapshot[field].length !== snapshot[field].expected) throw { status: 503, code: 'public_people_unavailable' }
      delete snapshot[field].expected
    }
    let served = snapshot
    const source = async () => served
    source.revisionIdentifiesContent = true
    const entry = { cacheKey, source, readers: new Map() }
    // Compile now, off the main thread, so the first call finds it ready.
    await readerFor(entry, 50, message.limits).suspensions({})
    // Every later read finds the compiled index by revision and limits (the
    // entry's only ones), so the raw rows are no longer needed: serve an empty
    // stub of the same revision and let them be collected.
    served = { state: snapshot.state, complete: snapshot.complete, revision: snapshot.revision, profiles: [], connections: [] }
    const slot = sources.get(sourceKey) ?? {}
    if (slot.current?.cacheKey !== cacheKey) {
      clearTimeout(slot.timer)
      slot.previous = slot.current ?? null
      slot.current = entry
      if (slot.previous) { slot.timer = setTimeout(() => { slot.previous = null }, PREVIOUS_GRACE_MS); slot.timer.unref?.() }
      sources.set(sourceKey, slot)
    }
    return true
  }
  if (message.type === 'call') {
    if (!METHODS.has(message.method)) throw { status: 400, code: 'public_people_input_invalid' }
    const entry = entryFor(message.sourceKey, message.cacheKey)
    if (!entry) throw { status: 503, code: 'public_people_unavailable', stale: true }
    return readerFor(entry, message.pageSize, message.limits)[message.method](message.request ?? {})
  }
  throw { status: 400, code: 'public_people_input_invalid' }
}

// Every reply carries this isolate's heap use, for the main thread's runtime health.
const heap = () => { const stats = getHeapStatistics(); return { usedMb: Math.round(stats.used_heap_size / 1048576), limitMb: Math.round(stats.heap_size_limit / 1048576) } }
parentPort.on('message', message => {
  Promise.resolve().then(() => handle(message)).then(
    result => parentPort.postMessage({ id: message.id, result, heap: heap() }),
    error => parentPort.postMessage({ id: message.id, error: { ...errorOf(error), ...(error?.stale ? { stale: true } : {}) }, heap: heap() }))
})
