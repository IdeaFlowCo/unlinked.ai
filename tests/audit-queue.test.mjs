import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuditQueue } from '../mcp-server/audit-queue.mjs'

test('audit timeouts and overflow emit bounded aggregate loss reports', async () => {
  let release
  const blocker = new Promise(resolve => { release = resolve })
  const logs = [], written = []
  const audit = createAuditQueue(async event => { written.push(event); await blocker },
    { limit: 2, timeoutMs: 25, reportIntervalMs: 60, log: line => logs.push(JSON.parse(line)) })
  const first = audit('first'), second = audit('second')
  await assert.rejects(audit('third'), /private_audit_queue_full/)
  const failures = await Promise.allSettled([first, second])
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.message === 'private_audit_timeout'))
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.deepEqual(logs, [{ event: 'private_audit_dropped', timedOut: 0, dropped: 1 },
    { event: 'private_audit_dropped', timedOut: 2, dropped: 1 }])
  release()
  await new Promise(resolve => setImmediate(resolve))
  await audit('fourth')
  assert.deepEqual(written, ['first', 'fourth'])
})
