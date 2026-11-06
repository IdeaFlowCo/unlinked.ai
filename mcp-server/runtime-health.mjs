import { monitorEventLoopDelay, PerformanceObserver, constants as perfConstants } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

// One fixed-schema row per interval describing the runtime process itself:
// heap pressure, garbage-collection pauses, event-loop delay and CPU. Every
// signed-in click waits on this one Node process, so a long major GC or a
// synchronous rebuild stalls every request at once; these rows make that
// visible next to request and browser timings. Numbers only: no request,
// owner, route or error content can enter a row.
const MB = 1024 * 1024
const mb = value => Number.isFinite(value) && value >= 0 ? Math.round(value / MB) : undefined
const ms = value => Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 3_600_000) : undefined

export const RUNTIME_HEALTH_FIELDS = Object.freeze(['uptime_s', 'interval_ms', 'rss_mb', 'heap_used_mb', 'heap_total_mb', 'heap_limit_mb', 'external_mb', 'array_buffers_mb', 'gc_major_count', 'gc_major_ms', 'gc_major_max_ms', 'gc_minor_count', 'gc_minor_ms', 'gc_incremental_count', 'gc_incremental_ms', 'loop_delay_p50_ms', 'loop_delay_p99_ms', 'loop_delay_max_ms', 'cpu_user_ms', 'cpu_system_ms'])

export function startRuntimeHealth({ emit, intervalMs = 60000, now = () => new Date(), memoryUsage = () => process.memoryUsage(), heapStatistics = getHeapStatistics, cpuUsage = previous => process.cpuUsage(previous), uptime = () => process.uptime(), observeGc = true, loopDelay = monitorEventLoopDelay({ resolution: 20 }) } = {}) {
  if (typeof emit !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('runtime_health_configuration_invalid')
  const gc = { major: 0, majorMs: 0, majorMax: 0, minor: 0, minorMs: 0, incremental: 0, incrementalMs: 0 }
  let observer = null
  if (observeGc) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const kind = entry.detail?.kind ?? entry.kind
        if (kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR) { gc.major++; gc.majorMs += entry.duration; gc.majorMax = Math.max(gc.majorMax, entry.duration) }
        else if (kind === perfConstants.NODE_PERFORMANCE_GC_MINOR) { gc.minor++; gc.minorMs += entry.duration }
        else if (kind === perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL) { gc.incremental++; gc.incrementalMs += entry.duration }
      }
    })
    observer.observe({ entryTypes: ['gc'] })
  }
  loopDelay?.enable?.()
  let cpu = cpuUsage(), last = performance.now()
  const sample = () => {
    const tick = performance.now(), memory = memoryUsage(), heap = heapStatistics(), used = cpuUsage(cpu)
    cpu = cpuUsage()
    // monitorEventLoopDelay reports nanoseconds.
    const delay = loopDelay && loopDelay.count !== 0 ? { p50: loopDelay.percentile(50) / 1e6, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 } : null
    const row = {
      schema: 1, event: 'runtime_health', at: now().toISOString(),
      uptime_s: Math.round(uptime()), interval_ms: ms(tick - last),
      rss_mb: mb(memory.rss), heap_used_mb: mb(memory.heapUsed), heap_total_mb: mb(memory.heapTotal), heap_limit_mb: mb(heap.heap_size_limit), external_mb: mb(memory.external), array_buffers_mb: mb(memory.arrayBuffers),
      gc_major_count: gc.major, gc_major_ms: ms(gc.majorMs), gc_major_max_ms: ms(gc.majorMax), gc_minor_count: gc.minor, gc_minor_ms: ms(gc.minorMs), gc_incremental_count: gc.incremental, gc_incremental_ms: ms(gc.incrementalMs),
      ...(delay ? { loop_delay_p50_ms: ms(delay.p50), loop_delay_p99_ms: ms(delay.p99), loop_delay_max_ms: ms(delay.max) } : {}),
      cpu_user_ms: ms(used.user / 1000), cpu_system_ms: ms(used.system / 1000),
    }
    last = tick
    Object.assign(gc, { major: 0, majorMs: 0, majorMax: 0, minor: 0, minorMs: 0, incremental: 0, incrementalMs: 0 })
    loopDelay?.reset?.()
    try { emit(row) } catch { /* Collection never affects serving. */ }
    return row
  }
  const timer = setInterval(sample, intervalMs)
  timer.unref?.()
  return {
    sample,
    stop() { clearInterval(timer); observer?.disconnect(); loopDelay?.disable?.() },
  }
}
