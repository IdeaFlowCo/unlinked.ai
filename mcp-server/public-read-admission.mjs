// No IP or user-agent identity is inferred here. Only a verified browser
// session selects the viewer lane; anonymous callers retain a shared fuse.
export function createPublicReadAdmission({ now = Date.now, inFlight = 8, anonymousInFlight = 6, anonymousPerMinute = 120, viewerPerMinute = 240, waitMs = 1500, maxQueue = 16, record = () => {} } = {}) {
  const owners = new Map(), queue = []
  let window = now(), requests = 0, busy = 0, anonymousBusy = 0
  function reserve(lane) {
    busy++; if (lane === 'anonymous') anonymousBusy++
    let released = false
    return () => {
      if (released) return
      released = true; busy--; if (lane === 'anonymous') anonymousBusy--
      while (queue.length && busy < inFlight) queue.shift().admit()
    }
  }
  return {
    async acquire({ ownerId, route, signal } = {}) {
      const lane = ownerId ? 'viewer' : 'anonymous', time = now()
      const result = (reason, retryAfter, release) => {
        try { record({ lane, route, reason }) } catch { /* Diagnostics never gate reads. */ }
        return { reason, retryAfter, release }
      }
      if (signal?.aborted) return result('cancelled')
      if (lane === 'anonymous') {
        if (time - window >= 60000) { window = time; requests = 0 }
        if (++requests > anonymousPerMinute) return result('minute', Math.max(1, Math.ceil((window + 60000 - time) / 1000)))
      } else {
        if (owners.size >= 5000) for (const [id, value] of owners) if (time - value.window >= 60000) owners.delete(id)
        let value = owners.get(ownerId)
        if (!value || time - value.window >= 60000) {
          // Never evict active owner budgets and accidentally reset their limits.
          if (!value && owners.size >= 5000) return result('capacity', 10)
          value = { window: time, requests: 0 }; owners.set(ownerId, value)
        }
        if (++value.requests > viewerPerMinute) return result('minute', Math.max(1, Math.ceil((value.window + 60000 - time) / 1000)))
      }
      if (busy < inFlight && (lane === 'viewer' || anonymousBusy < anonymousInFlight)) return result('admitted', undefined, reserve(lane))
      // Two slots remain available to viewers during anonymous bursts. A small
      // bounded viewer queue absorbs overlap without expanding process memory.
      if (lane === 'anonymous' || queue.length >= maxQueue) return result('capacity', 10)
      return new Promise(resolve => {
        let done = false, timer
        const finish = reason => {
          if (done) return
          done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1)
          resolve(reason === 'admitted' ? result(reason, undefined, reserve(lane)) : result(reason, reason === 'capacity' ? 10 : undefined))
        }
        const abort = () => finish('cancelled')
        const entry = { admit: () => finish(signal?.aborted ? 'cancelled' : 'admitted') }
        queue.push(entry)
        timer = setTimeout(() => finish('capacity'), waitMs)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }
}
