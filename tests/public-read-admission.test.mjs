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
