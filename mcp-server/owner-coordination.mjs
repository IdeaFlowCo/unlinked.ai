const runtimeCoordinators = new WeakMap(), memoryRuntime = {}
export function coordinatorFor(store) {
  const key = store ?? memoryRuntime
  if (runtimeCoordinators.has(key)) return runtimeCoordinators.get(key)
  const sessionMaps = new Set(), deletingProfiles = new Map(), locks = new Map(), versions = new Map()
  const acquire = (ownerId, exclusive) => {
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
    return new Promise(resolve => { queue.push({ exclusive, resolve }); drain() })
  }
  const coordinator = { sessionMaps, deletingProfiles, acquire,
    version: ownerId => versions.get(ownerId) ?? 0,
    deleted: ownerId => versions.set(ownerId, (versions.get(ownerId) ?? 0) + 1) }
  runtimeCoordinators.set(key, coordinator)
  return coordinator
}

