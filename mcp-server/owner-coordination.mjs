import { AsyncLocalStorage } from 'node:async_hooks'

const runtimeCoordinators = new WeakMap(), memoryRuntime = {}
export function coordinatorFor(store) {
  const key = store ?? memoryRuntime
  if (runtimeCoordinators.has(key)) return runtimeCoordinators.get(key)
  const sessionMaps = new Set(), deletingProfiles = new Map(), locks = new Map(), versions = new Map(), context = new AsyncLocalStorage()
  let generation = 0
  const acquire = (ownerId, exclusive, nested = false) => {
    if (!locks.has(ownerId)) locks.set(ownerId, { queue: [], readers: 0, writer: false })
    const state = locks.get(ownerId), queue = state.queue
    const drain = () => {
      if (!state.writer && !state.readers && !queue.length) { locks.delete(ownerId); return }
      if (state.writer || !queue.length) return
      if (queue[0].exclusive) {
        if (state.readers) return
        state.writer = true
        queue.shift().resolve(() => { state.writer = false; drain() })
        return
      }
      while (queue.length && !queue[0].exclusive) {
        state.readers++
        queue.shift().resolve(() => { state.readers--; drain() })
      }
    }
    return new Promise(resolve => {
      if (nested && !exclusive) queue.unshift({ exclusive, resolve })
      else queue.push({ exclusive, resolve })
      drain()
    })
  }
  const run = async (keys, work, { exclusive = false } = {}) => {
    const held = context.getStore() ?? new Map(), next = new Map(held), releases = []
    try {
      for (const name of [...new Set(keys)].sort()) {
        if (held.has(name)) {
          if (exclusive && !held.get(name)) throw new Error('owner_lock_upgrade_forbidden')
          continue
        }
        releases.push(await acquire(name, exclusive, held.size > 0))
        next.set(name, exclusive)
      }
      return await context.run(next, work)
    } finally { for (const release of releases.reverse()) release() }
  }
  const withHeld = (key, exclusive, work) => {
    const held = new Map(context.getStore() ?? [])
    held.set(key, exclusive)
    return context.run(held, work)
  }
  const coordinator = { sessionMaps, deletingProfiles, acquire, run, withHeld,
    checkpoint: () => generation,
    version: ownerId => versions.get(ownerId) ?? 0,
    deleted: ownerId => versions.set(ownerId, ++generation) }
  runtimeCoordinators.set(key, coordinator)
  return coordinator
}
