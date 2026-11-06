import { AsyncLocalStorage } from 'node:async_hooks'

const runtimeCoordinators = new WeakMap(), memoryRuntime = {}
export function coordinatorFor(store) {
  const key = store ?? memoryRuntime
  if (runtimeCoordinators.has(key)) return runtimeCoordinators.get(key)
  const sessionMaps = new Set(), deletingProfiles = new Map(), locks = new Map(), versions = new Map(), context = new AsyncLocalStorage()
  let generation = 0
  const drain = (ownerId, state) => {
    const queue = state.queue
    if (!state.writer && !state.readers && !queue.length) { locks.delete(ownerId); return }
    if (state.writer || !queue.length) return
    if (queue[0].exclusive) {
      if (state.readers) return
      state.writer = true
      queue.shift().resolve(() => { state.writer = false; drain(ownerId, state) })
      return
    }
    while (queue.length && !queue[0].exclusive) {
      state.readers++
      queue.shift().resolve(() => { state.readers--; drain(ownerId, state) })
    }
  }
  const acquire = (ownerId, exclusive, nested = false) => {
    if (!locks.has(ownerId)) locks.set(ownerId, { queue: [], readers: 0, writer: false })
    const state = locks.get(ownerId), queue = state.queue
    return new Promise(resolve => {
      if (nested && !exclusive) queue.unshift({ exclusive, resolve })
      else queue.push({ exclusive, resolve })
      drain(ownerId, state)
    })
  }
  const tryAcquireShared = ownerId => {
    let state = locks.get(ownerId)
    if (state?.writer || state?.queue.length) return null
    if (!state) { state = { queue: [], readers: 0, writer: false }; locks.set(ownerId, state) }
    state.readers++
    return () => { state.readers--; drain(ownerId, state) }
  }
  const run = async (keys, work, { exclusive = false } = {}) => {
    const held = new Map([...(context.getStore() ?? [])].filter(([, value]) => value.active)), next = new Map(held), releases = [], acquired = []
    const borrowed = []
    for (const name of new Set(keys)) {
      const token = held.get(name)
      if (token?.exclusive) {
        let done
        const pending = new Promise(resolve => { done = resolve })
        token.children.add(pending)
        borrowed.push(() => { token.children.delete(pending); done() })
      }
    }
    try {
      for (const name of [...new Set(keys)].sort()) {
        if (held.has(name)) {
          if (exclusive && !held.get(name).exclusive) throw new Error('owner_lock_upgrade_forbidden')
          if (held.get(name).exclusive) continue
        }
        releases.push(await acquire(name, exclusive, held.size > 0))
        const token = { exclusive, active: true, children: new Set() }
        acquired.push(token)
        next.set(name, token)
      }
      return await context.run(next, work)
    } finally {
      for (const token of acquired) { while (token.children.size) await Promise.allSettled([...token.children]); token.active = false }
      for (const release of releases.reverse()) release()
      for (const done of borrowed) done()
    }
  }
  const withHeld = async (key, exclusive, work) => {
    const held = new Map(context.getStore() ?? []), token = { exclusive, active: true, children: new Set() }
    held.set(key, token)
    try { return await context.run(held, work) } finally { while (token.children.size) await Promise.allSettled([...token.children]); token.active = false }
  }
  const coordinator = { sessionMaps, deletingProfiles, acquire, tryAcquireShared, run, withHeld,
    checkpoint: () => generation,
    version: ownerId => versions.get(ownerId) ?? 0,
    deleted: ownerId => versions.set(ownerId, ++generation) }
  runtimeCoordinators.set(key, coordinator)
  return coordinator
}
