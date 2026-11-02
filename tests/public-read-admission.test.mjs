import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicReadAdmission } from '../mcp-server/public-read-admission.mjs'
import { createPublicAdmissionDiagnostics, safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'

test('anonymous saturation leaves viewer capacity and owner quotas independent', async () => {
  let time = 100000
  const gate = createPublicReadAdmission({ now: () => time, anonymousPerMinute: 6, viewerPerMinute: 2 })
  const anonymous = await Promise.all(Array.from({ length: 6 }, () => gate.acquire({ route: 'profile' })))
  assert.ok(anonymous.every(x => x.release))
  assert.equal((await gate.acquire({})).reason, 'minute')
  const a = await gate.acquire({ ownerId: 'a' }), b = await gate.acquire({ ownerId: 'b' })
  assert.ok(a.release && b.release)
  anonymous.forEach(x => x.release()); a.release(); b.release()
  const second = await gate.acquire({ ownerId: 'a' }); second.release()
  assert.equal((await gate.acquire({ ownerId: 'a' })).reason, 'minute')
  const other = await gate.acquire({ ownerId: 'b' }); assert.ok(other.release); other.release()
  time += 60000
  const reset = await gate.acquire({ ownerId: 'a' }); assert.ok(reset.release); reset.release()
})

test('viewer waiting is bounded, released slots wake waiters, and cancellation does not consume capacity', async () => {
  const gate = createPublicReadAdmission({ inFlight: 2, anonymousInFlight: 1, waitMs: 20, maxQueue: 1 })
  const anon = await gate.acquire({}), viewer = await gate.acquire({ ownerId: 'a' })
  assert.equal((await gate.acquire({})).reason, 'capacity')
  const waiting = gate.acquire({ ownerId: 'b' })
  assert.equal((await gate.acquire({ ownerId: 'c' })).reason, 'capacity')
  anon.release()
  const admitted = await waiting; assert.ok(admitted.release)
  const controller = new AbortController(), cancelled = gate.acquire({ ownerId: 'd', signal: controller.signal })
  controller.abort(); assert.equal((await cancelled).reason, 'cancelled')
  assert.equal((await gate.acquire({ ownerId: 'e' })).reason, 'capacity')
  admitted.release(); admitted.release(); viewer.release()
  const recovered = await gate.acquire({ ownerId: 'f' }); assert.ok(recovered.release); recovered.release()
})

test('private diagnostics aggregate fixed lane, route and reason fields and discard private input', () => {
  const rows = []; let date = new Date('2026-10-24T00:00:00Z')
  const record = createPublicAdmissionDiagnostics({ emit: row => rows.push(row), now: () => date })
  for (let i = 0; i < 10; i++) record({ lane: 'anonymous', route: 'profile', reason: 'minute', ownerId: 'secret', query: 'private' })
  record({ lane: 'viewer', route: '/people/private-name', reason: 'admitted' })
  date = new Date('2026-10-24T00:01:00Z')
  record({ lane: 'viewer', route: 'profile', reason: 'admitted' })
  assert.deepEqual(rows, [{ schema: 1, event: 'public_admission', at: '2026-10-24T00:00:00.000Z', lane: 'anonymous', route: 'profile', reason: 'minute', count: 10 }])
  assert.deepEqual(safeDiagnosticRecord({ ...rows[0], query: 'private', token: 'secret' }), rows[0])
})

test('a saturated shared fuse never turns away a light visitor or a card scan', async () => {
  let time = 100000
  const gate = createPublicReadAdmission({ now: () => time, anonymousPerMinute: 4, visitorFree: 2, visitorPerMinute: 6 })
  const take = async options => { const x = await gate.acquire({ route: 'profile', ...options }); x.release?.(); return x.reason }
  // A crawler spends its free arrivals, then drains the shared pool.
  for (let i = 0; i < 2; i++) assert.equal(await take({ visitor: 'crawler' }), 'admitted')
  for (let i = 0; i < 4; i++) assert.equal(await take({ visitor: 'crawler' }), 'admitted')
  assert.equal(await take({ visitor: 'crawler' }), 'minute')
  assert.equal(await take({}), 'minute', 'keyless traffic still meets the shared fuse')
  // A person who just scanned a card is a different visitor: admitted.
  assert.equal(await take({ visitor: 'person' }), 'admitted')
  assert.equal(await take({ visitor: 'person' }), 'admitted')
  assert.equal(await take({ visitor: 'person' }), 'minute', 'past the free arrivals they share the drained pool')
  // An explicit card scan is always an arrival, up to the visitor ceiling.
  assert.equal(await take({ visitor: 'person', priority: true }), 'admitted')
  const busy = createPublicReadAdmission({ now: () => time, visitorPerMinute: 2 })
  assert.equal((await busy.acquire({ visitor: 'v', priority: true })).reason, 'admitted')
  assert.equal((await busy.acquire({ visitor: 'v', priority: true })).reason, 'admitted')
  assert.equal((await busy.acquire({ visitor: 'v', priority: true })).reason, 'minute', 'priority never lifts the per-visitor ceiling')
  time += 60000
  assert.equal(await take({ visitor: 'crawler' }), 'admitted', 'budgets reset each minute')
})

test('arrivals use the slots and queue that anonymous bursts cannot fill', async () => {
  const gate = createPublicReadAdmission({ inFlight: 3, anonymousInFlight: 2, waitMs: 20, maxQueue: 1, visitorFree: 0 })
  const crawler = [await gate.acquire({ visitor: 'c' }), await gate.acquire({ visitor: 'c' })]
  assert.ok(crawler.every(x => x.release))
  assert.equal((await gate.acquire({ visitor: 'c' })).reason, 'capacity')
  const scan = await gate.acquire({ visitor: 'p', priority: true }); assert.ok(scan.release, 'reserved slot')
  const waiting = gate.acquire({ visitor: 'q', priority: true })
  crawler[0].release()
  assert.ok((await waiting).release, 'queued arrival admitted when a slot frees')
})

test('admission diagnostics accept the arrival lane only as a fixed value', () => {
  assert.equal(safeDiagnosticRecord({ schema: 1, event: 'public_admission', at: '2026-11-02T00:00:00.000Z', lane: 'arrival', route: 'profile', reason: 'admitted', count: 3 }).lane, 'arrival')
  assert.equal(safeDiagnosticRecord({ schema: 1, event: 'public_admission', at: '2026-11-02T00:00:00.000Z', lane: '203.0.113.9', route: 'profile', reason: 'admitted', count: 3 }), null)
})
