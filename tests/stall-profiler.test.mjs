import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startStallProfiler, summarizeStalls } from '../mcp-server/stall-profiler.mjs'

function busyMainThreadFor(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x }

test('a stall is written as code locations and milliseconds, attributed to the blocking function', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stall-')); await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const profiler = await startStallProfiler({ directory, stallMs: 300, windowMs: 3600000 })
  await new Promise(resolve => setTimeout(resolve, 60))
  busyMainThreadFor(700)
  await new Promise(resolve => setTimeout(resolve, 60))
  await profiler.rotate()
  await profiler.stop()
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  assert.match(files[0], /^stall-\d{8}T\d{6}Z\.json$/)
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600)
  const row = JSON.parse(await readFile(join(directory, files[0]), 'utf8'))
  assert.equal(row.event, 'stall_profile')
  assert.equal(row.stalls, 1)
  assert.ok(row.stall_ms[0] >= 600)
  assert.ok(row.sampled_ms >= 300, `sampled ${row.sampled_ms} ms`)
  assert.ok(row.inclusive.some(([frame, ms]) => frame.startsWith('busyMainThreadFor ') && ms >= 300), JSON.stringify(row.inclusive.slice(0, 5)))
  assert.ok(row.stacks[0].stack.some(frame => frame.startsWith('busyMainThreadFor ')))
  // Only code locations and numbers.
  for (const [frame, ms] of [...row.self, ...row.inclusive]) { assert.equal(typeof frame, 'string'); assert.ok(Number.isSafeInteger(ms)) }
})

test('no stall writes nothing; a non-private directory is refused', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stall-')); await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const profiler = await startStallProfiler({ directory, stallMs: 2000, windowMs: 3600000 })
  await new Promise(resolve => setTimeout(resolve, 50))
  await profiler.rotate(); await profiler.stop()
  assert.deepEqual(await readdir(directory), [])
  await chmod(directory, 0o755)
  await assert.rejects(startStallProfiler({ directory }), /stall_profiler_directory_not_private/)
  await assert.rejects(startStallProfiler({ directory: 'relative' }), /stall_profiler_configuration_invalid/)
})

test('summaries count only samples inside the stall windows', () => {
  const node = (id, functionName, children = [], url = 'file:///srv/x/runtime/unlinked/mcp-server/a.mjs') => ({ id, callFrame: { functionName, url, lineNumber: id }, children })
  const profile = { startTime: 0, nodes: [node(1, '(root)', [2, 3], ''), node(2, 'inStall'), node(3, 'outside')], samples: [2, 2, 3, 3], timeDeltas: [1000, 1000, 1000, 1000] }
  // perfAtStart 100 ms: samples at 101, 102, 103, 104 ms; window covers the first two.
  const summary = summarizeStalls(profile, [[100.5, 102.5]], 100)
  assert.equal(summary.sampled_ms, 2)
  assert.deepEqual(summary.self, [['inStall mcp-server/a.mjs:3', 2]])
  assert.deepEqual(summary.app, [['inStall mcp-server/a.mjs:3', 2]], 'our own frames are ranked separately')
})

test('a quiet window does not stop the profile; rotation time is never reported as a stall', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stall-')); await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  let stops = 0
  const { Session } = await import('node:inspector/promises')
  const session = new Session(), post = session.post.bind(session)
  session.post = (method, params) => { if (method === 'Profiler.stop') stops++; return post(method, params) }
  const profiler = await startStallProfiler({ directory, stallMs: 300, windowMs: 1000, maxProfileMs: 60000, session })
  await new Promise(resolve => setTimeout(resolve, 2300))
  assert.equal(stops, 0, 'no stall, young profile: no stop')
  await profiler.stop()
  assert.deepEqual(await readdir(directory), [])
})

test('the process heap flag is detected wherever it is set', async () => {
  const { processHeapFlag } = await import('../src/utils/public-people/index-host.mjs')
  assert.equal(processHeapFlag([], '--max-old-space-size=768'), true)
  assert.equal(processHeapFlag(['--max-old-space-size', '1024'], ''), true)
  assert.equal(processHeapFlag(['--inspect=0'], '--enable-source-maps'), false)
  assert.equal(processHeapFlag([], '--max_old_space_size=896'), true, 'V8 also accepts the underscore form')
  assert.equal(processHeapFlag([], '--max-old-space-size=0'), false, '0 means the default, so resourceLimits applies')
})

test('a failed profile stop still closes the rotation, so later stalls are reported', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stall-')); await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Session } = await import('node:inspector/promises')
  const session = new Session(), post = session.post.bind(session)
  let failStop = true
  session.post = (method, params) => { if (method === 'Profiler.stop' && failStop) { failStop = false; return Promise.reject(Error('stop failed')) } return post(method, params) }
  const profiler = await startStallProfiler({ directory, stallMs: 300, windowMs: 3600000, session })
  await profiler.rotate().catch(() => {})          // stop fails: the profile is gone, rotation must close
  await profiler.rotate()                           // restarts sampling
  await new Promise(resolve => setTimeout(resolve, 60))
  busyMainThreadFor(700)
  await new Promise(resolve => setTimeout(resolve, 60))
  await profiler.rotate(); await profiler.stop()
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  const row = JSON.parse(await readFile(join(directory, files[0]), 'utf8'))
  assert.equal(row.stalls, 1, 'the real stall is a stall, not a self stall')
  assert.ok(row.sampled_ms >= 300)
})
