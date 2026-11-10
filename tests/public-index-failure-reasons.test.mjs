import test from 'node:test'
import assert from 'node:assert/strict'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError } from '../src/utils/public-people/reader.mjs'
import { errorClass, errorLocation } from '../src/utils/public-people/error-report.mjs'

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
