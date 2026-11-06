// Only a verified browser session selects the viewer lane. Anonymous callers
// are told apart by an in-memory visitor key (see client-address.mjs; never
// stored or logged). Each visitor's first `visitorFree` reads a minute are
// "arrivals": a person who just scanned a card or followed a link. Arrivals
// skip the shared anonymous fuse and may use the viewer slots and queue, so
// heavy crawlers only exhaust the shared pool among themselves. Reads marked
// as a card scan (`priority`) are always arrivals. Every visitor also has a
// hard per-minute ceiling, and the shared fuse still bounds keyless traffic.
export function createPublicReadAdmission({ now = Date.now, inFlight = 8, anonymousInFlight = 6, anonymousPerMinute = 120, viewerPerMinute = 240, visitorFree = 10, visitorPerMinute = 60, maxVisitors = 20000, waitMs = 1500, maxQueue = 16, record = () => {} } = {}) {
  const owners = new Map(), visitors = new Map(), queue = []
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
  // Returns the visitor's count this minute, or null when no budget can be
  // tracked (no key, or the table is full of active visitors).
  function visit(key, time) {
    if (!key) return null
    let value = visitors.get(key)
    if (!value || time - value.window >= 60000) {
      if (!value && visitors.size >= maxVisitors) {
        for (const [id, entry] of visitors) if (time - entry.window >= 60000) visitors.delete(id)
        if (visitors.size >= maxVisitors) return null
      }
      value = { window: time, requests: 0 }; visitors.set(key, value)
    }
    return ++value.requests
  }
  return {
    async acquire({ ownerId, visitor, priority = false, route, signal } = {}) {
      const time = now()
      let lane = ownerId ? 'viewer' : 'anonymous'
      const result = (reason, retryAfter, release) => {
        try { record({ lane, route, reason }) } catch { /* Diagnostics never gate reads. */ }
        return { reason, retryAfter, release }
      }
      if (signal?.aborted) return result('cancelled')
      if (lane === 'anonymous') {
        const visits = visit(visitor, time)
        if (visits !== null && visits > visitorPerMinute) return result('minute', Math.max(1, Math.ceil((visitors.get(visitor).window + 60000 - time) / 1000)))
        if (priority === true || (visits !== null && visits <= visitorFree)) lane = 'arrival'
        else {
          if (time - window >= 60000) { window = time; requests = 0 }
          if (++requests > anonymousPerMinute) return result('minute', Math.max(1, Math.ceil((window + 60000 - time) / 1000)))
        }
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
      if (busy < inFlight && (lane !== 'anonymous' || anonymousBusy < anonymousInFlight)) return result('admitted', undefined, reserve(lane))
      // Two slots remain available to viewers and arrivals during anonymous
      // bursts. A small bounded queue absorbs overlap without expanding memory.
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
