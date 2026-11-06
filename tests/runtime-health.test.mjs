import test from 'node:test'
import assert from 'node:assert/strict'
import { constants as perfConstants } from 'node:perf_hooks'
import { startRuntimeHealth, RUNTIME_HEALTH_FIELDS } from '../mcp-server/runtime-health.mjs'
import { createRequestDiagnostics, safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
import { summarizeRuntimeHealth } from '../scripts/read-runtime-health.mjs'

const MB = 1024 * 1024
const fakeLoop = () => ({ count: 3, enabled: false, enable() { this.enabled = true }, disable() { this.enabled = false }, percentile: p => (p === 50 ? 22 : 1520) * 1e6, max: 4220 * 1e6, reset() { this.count = 0 } })

test('a runtime health sample reports heap, loop delay and CPU as whole numbers only', () => {
  const rows = [], loop = fakeLoop()
  let cpuCalls = 0
  const health = startRuntimeHealth({ emit: row => rows.push(row), intervalMs: 3600000, observeGc: false, loopDelay: loop, now: () => new Date('2026-11-06T10:00:00.000Z'), uptime: () => 61.4,
    memoryUsage: () => ({ rss: 1500 * MB, heapUsed: 1310.6 * MB, heapTotal: 1400 * MB, external: 40 * MB, arrayBuffers: 12 * MB }),
    heapStatistics: () => ({ heap_size_limit: 1584 * MB }),
    cpuUsage: previous => (cpuCalls++, previous ? { user: 45_000_000, system: 5_000_000 } : { user: 0, system: 0 }) })
  assert.equal(loop.enabled, true)
  const row = health.sample()
  health.stop()
  assert.equal(loop.enabled, false)
  assert.deepEqual(rows, [row])
  assert.equal(row.event, 'runtime_health')
  assert.equal(row.heap_used_mb, 1311)
  assert.equal(row.heap_limit_mb, 1584)
  assert.equal(row.loop_delay_p99_ms, 1500)
  assert.equal(row.loop_delay_max_ms, 4200)
  assert.equal(row.cpu_user_ms, 45000)
  assert.equal(row.uptime_s, 61)
  for (const [key, value] of Object.entries(row)) if (!['schema', 'event', 'at'].includes(key)) { assert.ok(RUNTIME_HEALTH_FIELDS.includes(key), key); assert.ok(Number.isSafeInteger(value), key) }
  // Loop delay was reset for the next interval.
  assert.equal(loop.count, 0)
})

test('GC pauses are counted by kind and reset each interval', async () => {
  const rows = []
  const health = startRuntimeHealth({ emit: row => rows.push(row), intervalMs: 3600000, loopDelay: null })
  // Force a real major GC when exposed; otherwise allocate enough to trigger minors.
  if (globalThis.gc) globalThis.gc(); else { let keep = []; for (let i = 0; i < 2e6; i++) keep.push({ i }); keep = null }
  await new Promise(resolve => setTimeout(resolve, 50))
  const first = health.sample(), second = health.sample()
  health.stop()
  assert.ok(first.gc_major_count + first.gc_minor_count + first.gc_incremental_count >= 1)
  assert.equal(second.gc_major_count + second.gc_minor_count, 0)
  assert.equal(typeof perfConstants.NODE_PERFORMANCE_GC_MAJOR, 'number')
})

test('runtime_health records pass the diagnostics allowlist and drop extra fields', () => {
  const safe = safeDiagnosticRecord({ schema: 1, event: 'runtime_health', at: '2026-11-06T10:00:00.000Z', heap_used_mb: 1200, loop_delay_max_ms: 900, owner: 'x', route: '/people/someone', message: 'leak' })
  assert.deepEqual(safe, { schema: 1, event: 'runtime_health', at: '2026-11-06T10:00:00.000Z', heap_used_mb: 1200, loop_delay_max_ms: 900 })
  assert.equal(safeDiagnosticRecord({ schema: 1, event: 'runtime_health', at: 'yesterday', heap_used_mb: 1 }), null)
})

test('request diagnostics start health rows on the same private sink', () => {
  const rows = []
  const diagnostics = createRequestDiagnostics({ emit: row => rows.push(row) })
  const health = diagnostics.startRuntimeHealth({ intervalMs: 3600000, observeGc: false, loopDelay: null })
  health.sample(); health.stop()
  assert.equal(rows.length, 1)
  assert.ok(safeDiagnosticRecord(rows[0]))
})

test('the operator summary infers restarts and per-hour stalls', () => {
  const row = (at, uptime, heap, loopMax, gcMs) => ({ schema: 1, event: 'runtime_health', at, uptime_s: uptime, interval_ms: 60000, heap_used_mb: heap, heap_limit_mb: 1584, gc_major_count: 1, gc_major_ms: gcMs, gc_major_max_ms: gcMs, loop_delay_p99_ms: loopMax, loop_delay_max_ms: loopMax, cpu_user_ms: 30000, cpu_system_ms: 0 })
  const report = summarizeRuntimeHealth([row('2026-11-06T10:01:00.000Z', 60, 1400, 300, 200), row('2026-11-06T10:02:00.000Z', 120, 1560, 6000, 2500), row('2026-11-06T10:03:00.000Z', 30, 700, 200, 100), { event: 'agent_request' }])
  assert.equal(report.samples, 3)
  assert.deepEqual(report.restarts, [{ last_seen_at: '2026-11-06T10:02:00.000Z', last_heap_used_mb: 1560, last_uptime_s: 120, next_at: '2026-11-06T10:03:00.000Z' }])
  // A process that lived only ~1 minute: uptime does not drop, but grew far less than the wall clock.
  const loop = summarizeRuntimeHealth([row('2026-11-06T11:00:00.000Z', 62, 1500, 0, 0), row('2026-11-06T11:02:30.000Z', 64, 600, 0, 0)])
  assert.equal(loop.restarts.length, 1)
  const [hour] = report.hours
  assert.equal(hour.minutes_with_stall, 1)
  assert.equal(hour.heap_headroom_min_mb, 24)
  assert.equal(hour.gc_major_max_ms, 2500)
  assert.equal(hour.cpu_percent, 50)
})

test('expired owner-network reads are dropped; fresh and in-flight ones stay', async () => {
  const { dropExpiredNetworks } = await import('../mcp-server/private-browser.mjs')
  const pending = Promise.resolve()
  const cache = new Map([['old', { pending: null, value: { rows: 12000 }, at: 1000 }], ['fresh', { pending: null, value: {}, at: 15000 }], ['loading', { pending, value: null, at: 0 }]])
  dropExpiredNetworks(cache, 15000, 20000)
  assert.deepEqual([...cache.keys()], ['fresh', 'loading'])
})
