#!/usr/bin/env node
// Private operator report over runtime_health rows in the request diagnostics
// directory: restarts, heap headroom, GC pause totals and event-loop stalls.
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null
const max = values => values.length ? values.reduce((a, b) => Math.max(a, b), 0) : null

export function summarizeRuntimeHealth(records, { stallMs = 1000 } = {}) {
  const rows = records.map(safeDiagnosticRecord).filter(row => row?.event === 'runtime_health').sort((a, b) => a.at.localeCompare(b.at))
  // A restart: uptime grew less than wall-clock time between consecutive rows
  // (with slack), so a process that lived only a minute or two is still caught.
  const restarts = []
  for (let i = 1; i < rows.length; i++) if ((rows[i].uptime_s ?? 0) < (rows[i - 1].uptime_s ?? 0) + (Date.parse(rows[i].at) - Date.parse(rows[i - 1].at)) / 1000 - 30) restarts.push({ last_seen_at: rows[i - 1].at, last_heap_used_mb: rows[i - 1].heap_used_mb ?? null, last_uptime_s: rows[i - 1].uptime_s ?? null, next_at: rows[i].at })
  const hours = new Map()
  for (const row of rows) {
    const key = row.at.slice(0, 13) + ':00Z', hour = hours.get(key) ?? { hour: key, samples: 0, heap: [], headroom: [], gcMajorMs: 0, gcMajorMax: 0, gcMajorCount: 0, loopP99: [], loopMax: [], stalls: 0, cpuMs: 0, intervalMs: 0 }
    hour.samples++
    if (row.heap_used_mb !== undefined) hour.heap.push(row.heap_used_mb)
    if (row.heap_used_mb !== undefined && row.heap_limit_mb) hour.headroom.push(row.heap_limit_mb - row.heap_used_mb)
    hour.gcMajorMs += row.gc_major_ms ?? 0; hour.gcMajorCount += row.gc_major_count ?? 0; hour.gcMajorMax = Math.max(hour.gcMajorMax, row.gc_major_max_ms ?? 0)
    if (row.loop_delay_p99_ms !== undefined) hour.loopP99.push(row.loop_delay_p99_ms)
    if (row.loop_delay_max_ms !== undefined) { hour.loopMax.push(row.loop_delay_max_ms); if (row.loop_delay_max_ms >= stallMs) hour.stalls++ }
    hour.cpuMs += (row.cpu_user_ms ?? 0) + (row.cpu_system_ms ?? 0); hour.intervalMs += row.interval_ms ?? 0
    hours.set(key, hour)
  }
  return {
    samples: rows.length, first_at: rows[0]?.at ?? null, last_at: rows.at(-1)?.at ?? null, restarts,
    hours: [...hours.values()].map(h => ({ hour: h.hour, samples: h.samples, heap_used_max_mb: max(h.heap), heap_headroom_min_mb: h.headroom.length ? Math.min(...h.headroom) : null, gc_major_count: h.gcMajorCount, gc_major_ms: h.gcMajorMs, gc_major_max_ms: h.gcMajorMax, loop_delay_p99_p50_ms: percentile(h.loopP99, 0.5), loop_delay_max_ms: max(h.loopMax), minutes_with_stall: h.stalls, cpu_percent: h.intervalMs ? Math.round(100 * h.cpuMs / h.intervalMs) : null })),
  }
}

export async function readRuntimeHealth({ directory, since }) {
  if (!isAbsolute(directory ?? '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(since ?? '') || !Number.isFinite(Date.parse(since))) throw Error('health_directory_and_since_required')
  const state = await lstat(directory)
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) throw Error('health_directory_not_private')
  const files = await readdir(directory), records = []
  if (files.length > 64) throw Error('health_inventory_limit')
  const days = files.filter(x => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()
  if (days.length > 7) throw Error('health_retention_limit')
  for (const name of days) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) throw Error('health_file_not_private')
      for (const line of (await file.readFile('utf8')).split('\n')) {
        if (!line || Buffer.byteLength(line) > 4096) continue
        try { const row = JSON.parse(line); if (row.event === 'runtime_health' && Date.parse(row.at) >= Date.parse(since)) records.push(row) } catch {}
      }
    } finally { await file.close() }
  }
  return { since, ...summarizeRuntimeHealth(records), coverage: 'One row per minute while request diagnostics are on. A process that aborts loses its final partial minute; restarts are inferred from uptime resets.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = { '--directory': 'directory', '--since': 'since' }, options = {}
    for (let i = 2; i < process.argv.length; i += 2) { const key = flags[process.argv[i]]; if (!key || options[key] || !process.argv[i + 1]) throw Error('invalid_arguments'); options[key] = process.argv[i + 1] }
    console.log(JSON.stringify(await readRuntimeHealth(options), null, 2))
  } catch { console.error('Runtime health report unavailable: supply the owned private request-diagnostics --directory and UTC --since.'); process.exitCode = 1 }
}
