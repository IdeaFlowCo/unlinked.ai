import test from 'node:test'
import assert from 'node:assert/strict'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError } from '../src/utils/public-people/reader.mjs'
import { errorClass, errorLocation } from '../src/utils/public-people/error-report.mjs'
import { EventEmitter } from 'node:events'
import { activePublicIndexHost, createPublicIndexHost, installPublicIndexHost, PublicIndexHostError } from '../src/utils/public-people/index-host.mjs'

// Failure reasons for the public People index (lookup_contact outage, 2026-11-10).
const base = { schema: 1, event: 'agent_request', request_id: '7f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b', tool: 'unlinked_lookup_contact', error_class: 'upstream_unavailable' }

test('diagnostics keep lookup_contact, its failure step and a fixed index reason; anything else is dropped', () => {
  const kept = safeDiagnosticRecord({ ...base, failure_stage: 'index_published_lookup', index_failure: 'build_timeout' })
  assert.equal(kept.tool, 'unlinked_lookup_contact'); assert.equal(kept.failure_stage, 'index_published_lookup'); assert.equal(kept.index_failure, 'build_timeout')
  const dropped = safeDiagnosticRecord({ ...base, failure_stage: 'Error: secret', index_failure: 'TypeError: x of undefined' })
  assert.equal(dropped.failure_stage, undefined); assert.equal(dropped.index_failure, undefined)
})

test('a snapshot build that outlives its deadline fails as build_timeout', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: () => new Promise(() => {}), timeoutMs: 20 })
  await assert.rejects(reader.lookup({ ids: [], signal: new AbortController().signal }), error => error instanceof PublicPeopleReaderError && error.reason === 'build_timeout')
})

test('a caller abort is reported as aborted, not as a timeout', async () => {
  const controller = new AbortController()
  const reader = createPublicPeopleReader({ readPublishedSnapshot: () => new Promise(() => {}), timeoutMs: 5000 })
  const pending = reader.lookup({ ids: [], signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.reason === 'aborted')
})

test('worker error reports carry only a class name and a source location', () => {
  const error = new TypeError('Cannot read properties of undefined (reading private-name)')
  error.stack = 'TypeError: Cannot read properties of undefined\n    at lookup (file:///srv/x/src/utils/public-people/reader.mjs:531:44)'
  assert.equal(errorClass(error), 'TypeError'); assert.equal(errorLocation(error), 'reader.mjs:531')
  assert.equal(errorClass({ name: 'Weird name with data' }), 'other'); assert.equal(errorLocation({}), 'unknown')
})

test('malformed snapshots preserve snapshot_invalid through the real worker and reader', async t => {
  const source = async () => ({ state: 'published', complete: true, revision: 'invalid-worker-v1', profiles: [{ id: 'ada', name: null, positions: [], education: [], skills: [] }], connections: [] })
  source.revisionIdentifiesContent = true
  const previous = activePublicIndexHost()
  installPublicIndexHost(null)
  const reason = error => error instanceof PublicPeopleReaderError && error.status === 503 && error.code === 'public_people_unavailable' && error.reason === 'snapshot_invalid'
  const host = createPublicIndexHost()
  t.after(async () => { installPublicIndexHost(previous); await host.close() })
  await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: source }).lookup({ ids: ['ada'] }), reason)
  installPublicIndexHost(host)
  await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: source }).lookup({ ids: ['ada'] }), reason)
  assert.equal(host.stats().spawned, 1)
  assert.equal(host.stats().installs, 0)
})

test('the host accepts fixed worker reasons and drops free-form messages and reasons', async t => {
  let failure
  const host = createPublicIndexHost({ createWorker: () => {
    const worker = new EventEmitter()
    worker.ref = worker.unref = () => {}
    worker.terminate = async () => {}
    worker.postMessage = message => queueMicrotask(() => worker.emit('message', { id: message.id, error: failure }))
    return worker
  } })
  t.after(() => host.close())
  for (const [sent, expected] of [
    ['snapshot_invalid', 'snapshot_invalid'], ['build_timeout', 'build_timeout'], ['aborted', 'aborted'],
    ['reader_exception', 'reader_exception'], ['exception', 'exception'], ['private-name@example.invalid', 'worker_refused'],
    [undefined, 'worker_refused'],
  ]) {
    failure = { status: 503, code: 'public_people_unavailable', reason: sent, message: 'confidential message', stack: 'confidential stack' }
    await assert.rejects(host.call('source', 'cache', { pageSize: 50, limits: {} }, 'lookup', {}), error => {
      assert.ok(error instanceof PublicIndexHostError)
      assert.equal(error.reason, expected)
      assert.equal(error.message, 'public_people_unavailable')
      assert.equal(JSON.stringify(error).includes('confidential'), false)
      return true
    })
  }
  failure = { status: 503, code: 'public_people_unavailable', stale: true, reason: 'private message' }
  await assert.rejects(host.call('source', 'cache', { pageSize: 50, limits: {} }, 'lookup', {}), { reason: 'stale', stale: true })
})

test('a source cannot inject a free-form reader failure reason', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => { throw Object.assign(new Error('private source text'), { reason: 'private-name@example.invalid' }) } })
  await assert.rejects(reader.lookup({ ids: [] }), error => {
    assert.equal(error.reason, 'reader_exception')
    assert.equal(error.message, 'public_people_unavailable')
    assert.equal(JSON.stringify(error).includes('private'), false)
    return true
  })
})
