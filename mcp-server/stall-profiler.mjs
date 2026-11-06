import { Session } from 'node:inspector/promises'
import { constants } from 'node:fs'
import { lstat, open, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// Opt-in main-thread stall profiler (docs/request-diagnostics.md § Stall profiles).
// An in-process V8 sampling profiler (node:inspector Session.connect(): no
// port, no remote attach) runs in windows; a 20 ms ticker notes every gap of
// at least `stallMs`. At the end of a window with stalls, only the samples
// inside those gaps are summarized and written to one private JSON file:
// code locations (function, file, line) and milliseconds. No request, owner,
// argument or value data can appear in a row.

const FILE = /^stall-\d{8}T\d{6}Z\.json$/
const frameOf = node => {
  const { functionName, url, lineNumber } = node.callFrame
  const path = url.replace(/^file:\/\//, '')
  const short = path.includes('/unlinked/') ? path.slice(path.lastIndexOf('/unlinked/') + 10) : path.startsWith('node:') ? path : path.split('/').slice(-2).join('/')
  return `${functionName || '(anonymous)'} ${short || '(native)'}${url ? `:${lineNumber + 1}` : ''}`
}

// Summarize samples of `profile` whose times fall inside `windows` ([startMs, endMs] on performance.now()).
export function summarizeStalls(profile, windows, perfAtStart, { top = 25, stacks = 6, depth = 14 } = {}) {
  const byId = new Map(profile.nodes.map(node => [node.id, node])), parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map(), inclusive = new Map(), stackMs = new Map(), app = new Map()
  // Our own code (mcp-server/, src/), so runtime internals such as
  // runMicrotasks never crowd out the frame that actually did the work.
  const ours = frame => / (?:mcp-server|src)\//.test(frame)
  let sampled = 0, t = profile.startTime
  const inside = ms => windows.some(([a, b]) => ms >= a && ms <= b)
  for (let i = 0; i < profile.samples.length; i++) {
    const delta = profile.timeDeltas[i] ?? 0
    t += delta
    const ms = perfAtStart + (t - profile.startTime) / 1000
    if (!inside(ms)) continue
    const weight = delta / 1000
    sampled += weight
    const frames = []
    for (let id = profile.samples[i]; id !== undefined && frames.length < depth; id = parent.get(id)) {
      const node = byId.get(id)
      if (!node || node.callFrame.functionName === '(root)') break
      frames.push(frameOf(node))
    }
    if (!frames.length) continue
    self.set(frames[0], (self.get(frames[0]) ?? 0) + weight)
    for (const frame of new Set(frames)) { inclusive.set(frame, (inclusive.get(frame) ?? 0) + weight); if (ours(frame)) app.set(frame, (app.get(frame) ?? 0) + weight) }
    const key = frames.join(' < ')
    stackMs.set(key, (stackMs.get(key) ?? 0) + weight)
  }
  const rank = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([frame, value]) => [frame, Math.round(value)])
  return { sampled_ms: Math.round(sampled), app: rank(app, top), self: rank(self, top), inclusive: rank(inclusive, top), stacks: rank(stackMs, stacks).map(([stack, value]) => ({ ms: value, stack: stack.split(' < ') })) }
}

// 10 ms sampling still gives ~50 samples per 500 ms stall; stopping a profile
// costs time proportional to its samples and nodes, all on the main thread.
export async function startStallProfiler({ directory, stallMs = 500, windowMs = 60000, samplingUs = 10000, maxProfileMs = Math.max(300000, windowMs), keep = 240, now = () => new Date(), session = new Session() } = {}) {
  if (!isAbsolute(directory ?? '') || !Number.isSafeInteger(stallMs) || stallMs < 50 || !Number.isSafeInteger(windowMs) || windowMs < 1000 || !Number.isSafeInteger(samplingUs) || samplingUs < 100 || !Number.isSafeInteger(maxProfileMs) || maxProfileMs < windowMs || !Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw new Error('stall_profiler_configuration_invalid')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw new Error('stall_profiler_directory_not_private')
  session.connect()
  let windows = [], perfAtStart = 0, stopped = false, running = false, warned = false, last = performance.now()
  // The profiler's own stop/restart blocks the loop briefly; that gap is
  // reported as rotation time, never as a stall.
  let rotation = [-Infinity, -Infinity], rotationMs = 0, selfStalls = 0
  const begin = async () => { await session.post('Profiler.start'); running = true; perfAtStart = performance.now() }
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: samplingUs })
    await begin()
  } catch (error) { try { session.disconnect() } catch {} throw error }
  const ticker = setInterval(() => {
    const at = performance.now(), excess = at - last - 20
    if (excess >= stallMs) {
      // Only the part of the gap the rotation itself explains is the profiler's own.
      const overlap = Math.max(0, Math.min(at, rotation[1]) - Math.max(last, rotation[0]))
      if (excess - overlap < stallMs) selfStalls++; else windows.push([last, at])
    }
    last = at
  }, 20)
  ticker.unref()
  const prune = async () => {
    const names = (await readdir(directory)).filter(name => FILE.test(name)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(directory, name)).catch(() => {})
  }
  // Rotates (stops, summarizes, restarts) only after a window with stalls, or
  // when the running profile reaches `maxProfileMs`, so a quiet process pays
  // for a stop at most every few minutes.
  const rotate = async ({ force = false } = {}) => {
    if (stopped) return
    // A failed restart is retried on the next window instead of stopping profiling for good.
    if (!running) {
      await begin()
      // Gaps noted while nothing was sampling have no samples to explain them.
      windows = []; rotation = [-Infinity, -Infinity]
      return
    }
    if (!force && !windows.length && performance.now() - perfAtStart < maxProfileMs) return
    const seen = windows; windows = []
    const startedAt = perfAtStart
    running = false
    const began = performance.now()
    rotation = [began, Infinity]
    let profile
    try {
      profile = (await session.post('Profiler.stop')).profile
      try { await begin() } catch { if (!warned) { warned = true; process.stderr.write('unlinked_stall_profiler_restart_failed\n') } }
    } finally {
      rotationMs = Math.round(performance.now() - began)
      rotation = [began, performance.now()]
    }
    if (!seen.length) return
    const summary = summarizeStalls(profile, seen, startedAt)
    const at = now()
    const row = { schema: 1, event: 'stall_profile', at: at.toISOString(), window_ms: windowMs, sampling_us: samplingUs, stall_threshold_ms: stallMs, rotation_ms: rotationMs, self_stalls: selfStalls, stalls: seen.length, stall_ms: seen.map(([a, b]) => Math.round(b - a)).sort((a, b) => b - a).slice(0, 20), ...summary }
    const name = `stall-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`
    const file = await open(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(JSON.stringify(row)) } finally { await file.close() }
    selfStalls = 0
    await prune()
  }
  let chain = Promise.resolve()
  const timer = setInterval(() => { chain = chain.then(rotate).catch(() => {}) }, windowMs)
  timer.unref()
  return {
    rotate: () => { const run = chain.then(() => rotate({ force: true })); chain = run.catch(() => {}); return run },
    async stop() { stopped = true; clearInterval(timer); clearInterval(ticker); await chain.catch(() => {}); if (running) await session.post('Profiler.stop').catch(() => {}); running = false; session.disconnect() },
  }
}
