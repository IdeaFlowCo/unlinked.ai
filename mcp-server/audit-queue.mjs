export function createAuditQueue(writeAudit, { limit = 64, timeoutMs = 5000, reportIntervalMs = 60000, log = console.error } = {}) {
  let tail = Promise.resolve(), pending = 0, timedOut = 0, dropped = 0, lastReport = -Infinity, reportTimer
  const report = () => {
    reportTimer = undefined
    if (!timedOut && !dropped) return
    log(JSON.stringify({ event: 'private_audit_dropped', timedOut, dropped }))
    timedOut = 0; dropped = 0; lastReport = Date.now()
  }
  const recordLoss = (timeout, drop) => {
    timedOut += Number(timeout); dropped += Number(drop)
    const remaining = reportIntervalMs - (Date.now() - lastReport)
    if (remaining <= 0) report()
    else if (!reportTimer) { reportTimer = setTimeout(report, remaining); reportTimer.unref?.() }
  }
  return event => {
    if (pending >= limit) {
      recordLoss(false, true)
      return Promise.reject(new Error('private_audit_queue_full'))
    }
    pending++
    let expired = false, started = false, timer
    const write = tail.then(() => {
      if (expired) return
      started = true
      return writeAudit(event)
    })
    tail = write.catch(() => {}).finally(() => { pending-- })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        recordLoss(true, !started)
        reject(new Error('private_audit_timeout'))
      }, timeoutMs)
    })
    return Promise.race([write, timeout]).finally(() => clearTimeout(timer))
  }
}
