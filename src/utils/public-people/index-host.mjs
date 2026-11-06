import { Worker, isMainThread } from 'node:worker_threads'

// Main-thread side of the public People index worker (docs/public-people-reader.md).
//
// Compiling a published snapshot into the reader's index (maps, search tokens,
// adjacency) and answering its queries are CPU- and memory-heavy. On the main
// event loop a compile stalled every request for seconds and a recompile held
// two full indexes in the main heap. With a host installed, cacheable readers
// keep only a small descriptor here; one worker thread owns each source's
// compiled index for a revision and runs the same reader code against it.
//
// - A snapshot is sent only when its compiled key (revision + limits) is new
//   to the worker, in chunks with a yield between them, so no single message
//   blocks the loop. The main thread never holds a compiled index.
// - The worker keeps the newest index per source and the one before it for a
//   short grace period, so a request-scoped reader pinned to the previous
//   revision still finishes its page.
// - If the worker dies (for example its own heap limit), the process lives:
//   pending calls fail as unavailable, and the next read starts a new worker
//   and installs the snapshot again.

const CHUNK = 2000
const CALL_TIMEOUT_MS = 30000
// A cold compile at the index caps takes seconds; allow it generously.
const INSTALL_TIMEOUT_MS = 180000
// A worker that never manages one install after this many losses is broken
// here (for example it cannot start): readers compile in-process again.
const MAX_FAILURES_WITHOUT_INSTALL = 3
const RESPAWN_BACKOFF_MS = 5000
// Top-level snapshot arrays that can be large; sent in chunks.
const CHUNKED = ['profiles', 'connections', 'members', 'legacyMembers', 'suspended', 'suspendedRefs', 'removed', 'unlisted']
const yieldLoop = () => new Promise(resolve => setImmediate(resolve))

export class PublicIndexHostError extends Error {
  constructor(status, code, stale = false) { super(code); this.name = 'PublicIndexHostError'; this.status = status; this.code = code; this.stale = stale }
}
const unavailable = () => new PublicIndexHostError(503, 'public_people_unavailable')

let active = null
// The host cacheable readers use, or null (compile in-process, as before).
// Never inside a worker: the index worker itself compiles in-process, even
// when it inherited a preload or flags that installed a host.
export const activePublicIndexHost = () => isMainThread ? active : null
export const installPublicIndexHost = host => { active = host ?? null; return active }

export function createPublicIndexHost({ workerUrl = new URL('./index-worker.mjs', import.meta.url), resourceLimits, chunkSize = CHUNK, callTimeoutMs = CALL_TIMEOUT_MS, installTimeoutMs = INSTALL_TIMEOUT_MS, backoffMs = RESPAWN_BACKOFF_MS, onDisabled = () => process.stderr.write('unlinked_public_index_worker_disabled\n'), createWorker = (url, options) => new Worker(url, options), now = Date.now } = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || !Number.isSafeInteger(installTimeoutMs) || installTimeoutMs < 1 || !Number.isSafeInteger(backoffMs) || backoffMs < 0) throw new TypeError('public_index_host_configuration_invalid')
  let worker = null, generation = 0, nextId = 1, crashedAt = -Infinity, previousCrashAt = -Infinity, closed = false, disabled = false, failuresWithoutInstall = 0
  const pending = new Map() // id -> { resolve, reject, timer }
  const installed = new Map() // sourceKey -> Set(cacheKey) believed installed in the current worker
  const installing = new Map() // `${sourceKey}\0${cacheKey}` -> Promise
  const sourceKeys = new WeakMap()
  let sourceCount = 0
  const stats = { spawned: 0, crashed: 0, installs: 0, calls: 0, stale: 0, workerHeapUsedMb: null, workerHeapLimitMb: null }

  // Referenced only while a reply is awaited: an idle index never keeps the
  // process alive, and a pending call always does.
  const settle = () => { if (pending.size === 0) worker?.unref?.() }
  const noteFailure = () => {
    previousCrashAt = crashedAt; crashedAt = now()
    if (++failuresWithoutInstall >= MAX_FAILURES_WITHOUT_INSTALL && stats.installs === 0 && !disabled) { disabled = true; try { onDisabled() } catch {} }
  }
  const failAll = error => { for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); pending.delete(id) } }
  const spawn = () => {
    if (closed) throw unavailable()
    if (worker) return worker
    // A single loss restarts at once; back off only when losses repeat.
    if (now() - crashedAt < backoffMs && crashedAt - previousCrashAt < 30000) throw unavailable()
    const mine = ++generation
    let created
    try { created = createWorker(workerUrl, { ...(resourceLimits ? { resourceLimits } : {}) }) }
    catch { noteFailure(); throw unavailable() }
    created.on('message', message => {
      if (Number.isSafeInteger(message?.heap?.usedMb)) { stats.workerHeapUsedMb = message.heap.usedMb; stats.workerHeapLimitMb = message.heap.limitMb }
      const entry = pending.get(message?.id)
      if (!entry) return
      pending.delete(message.id); clearTimeout(entry.timer); settle()
      if (message.error) entry.reject(new PublicIndexHostError(message.error.status ?? 503, message.error.code ?? 'public_people_unavailable', message.error.stale === true))
      else entry.resolve(message.result)
    })
    const lost = () => {
      if (generation !== mine || worker !== created) return
      worker = null; installed.clear(); stats.crashed++; stats.workerHeapUsedMb = null
      noteFailure()
      failAll(unavailable())
    }
    created.on('error', lost)
    created.on('exit', lost)
    // After the listeners: adding a 'message' listener re-refs the port, and an
    // idle index must never keep the process alive.
    created.unref?.()
    worker = created; stats.spawned++
    return worker
  }
  const send = (message, timeoutMs = callTimeoutMs) => new Promise((resolve, reject) => {
    let target
    try { target = spawn() } catch (error) { reject(error); return }
    const id = nextId++
    const timer = setTimeout(() => { if (pending.delete(id)) { settle(); reject(unavailable()) } }, timeoutMs)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer })
    target.ref?.()
    try { target.postMessage({ ...message, id }) } catch { pending.delete(id); clearTimeout(timer); settle(); reject(unavailable()) }
  })

  // Install `snapshot` under (sourceKey, cacheKey) unless the current worker has it.
  const ensure = async (sourceKey, cacheKey, snapshot, limits) => {
    if (installed.get(sourceKey)?.has(cacheKey) && worker) return
    const key = `${sourceKey}\u0000${cacheKey}`
    let work = installing.get(key)
    if (!work) {
      work = (async () => {
        const target = spawn()
        const meta = {}
        // A chunked field that is not an array travels as-is, so the worker's
        // validation rejects it exactly as an in-process compile would.
        for (const [field, value] of Object.entries(snapshot)) if (!CHUNKED.includes(field) || !Array.isArray(value)) meta[field] = value
        const lengths = Object.fromEntries(CHUNKED.filter(field => Array.isArray(snapshot[field])).map(field => [field, snapshot[field].length]))
        const transfer = await send({ type: 'begin', sourceKey, cacheKey, meta, lengths })
        for (const field of Object.keys(lengths)) {
          const values = snapshot[field]
          for (let start = 0; start < values.length; start += chunkSize) {
            await yieldLoop()
            await send({ type: 'chunk', transfer, field, values: values.slice(start, start + chunkSize) })
          }
        }
        await yieldLoop()
        await send({ type: 'end', transfer, limits }, installTimeoutMs)
        // A worker that restarted meanwhile does not have it (its loss already
        // failed this install's messages); a stale belief is corrected by the
        // worker answering `stale` and the reader installing again.
        if (worker === target) {
          if (!installed.has(sourceKey)) installed.set(sourceKey, new Set())
          const keys = installed.get(sourceKey)
          // The worker keeps the newest two per source; mirror that.
          keys.delete(cacheKey); keys.add(cacheKey)
          while (keys.size > 2) keys.delete(keys.values().next().value)
        }
        stats.installs++; failuresWithoutInstall = 0
      })().finally(() => installing.delete(key))
      installing.set(key, work)
    }
    return work
  }

  return {
    // Stable per source function, so wrappers naming `compiledSource` share one index.
    // False once closed, or after the worker proved unable to install anything.
    available: () => !closed && !disabled,
    sourceKey(source) { let value = sourceKeys.get(source); if (!value) sourceKeys.set(source, value = `source-${++sourceCount}`); return value },
    ensure,
    async call(sourceKey, cacheKey, { pageSize, limits }, method, request) {
      stats.calls++
      try { return await send({ type: 'call', sourceKey, cacheKey, pageSize, limits, method, request }) }
      catch (error) {
        if (error?.stale) { stats.stale++; installed.get(sourceKey)?.delete(cacheKey) }
        throw error
      }
    },
    stats: () => ({ ...stats, pending: pending.size, running: Boolean(worker) }),
    async close() { closed = true; const current = worker; worker = null; failAll(unavailable()); if (current) await current.terminate() },
  }
}
