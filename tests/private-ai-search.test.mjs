import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateSearch, responsesRequest, parseResponsesResult } from '../src/utils/private-import/ai-search.mjs'

const id = 'a'.repeat(64), rowId = 'b'.repeat(64)
const publication = { importId: id, assertions: [{ id: rowId, sourceId: 'c'.repeat(64), rowId: 'Connections.csv#record=2', category: 'connections', subject: 'https://www.linkedin.com/in/synthetic-ada', fields: { 'first name': 'Ada', position: 'Engineer', 'email address': 'private@example.invalid' } }] }
test('private AI search limits provider context and returns persisted provenance', async () => {
  let calls = 0
  const search = createPrivateSearch({ readImport: async requested => { assert.equal(requested, id); return publication }, complete: async ({ input, candidateIds }) => {
    calls++; assert.deepEqual(candidateIds, [rowId]); assert.equal(input.includes('private@example.invalid'), false)
    return { matches: [{ id: rowId, reason: 'Engineer observation' }] }
  } })
  const result = await search({ importId: id, query: 'engineer' })
  assert.equal(calls, 1); assert.equal(result.indexed, 0); assert.equal(result.matches[0].sourceId, 'c'.repeat(64))
  await assert.rejects(search({ importId: id, query: 'x'.repeat(1025) }), /query_limit/)
  assert.equal(calls, 1)
})
test('foreign/duplicate model IDs, deleted publication and changed publication fail closed', async () => {
  for (const matches of [[{ id: 'd'.repeat(64), reason: 'wrong owner' }], [{ id: rowId, reason: 'one' }, { id: rowId, reason: 'two' }]]) {
    await assert.rejects(createPrivateSearch({ readImport: async () => publication, complete: async () => ({ matches }) })({ importId: id, query: 'engineer' }), /invalid_result/)
  }
  let reads = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => { if (++reads === 2) throw new Error('private_import_not_found'); return publication }, complete: async () => ({ matches: [{ id: rowId, reason: 'engineer' }] }) })({ importId: id, query: 'engineer' }), /private_import_not_found/)
  reads = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => ++reads === 1 ? publication : { ...publication, status: 'changed' }, complete: async () => ({ matches: [] }) })({ importId: id, query: 'engineer' }), /private_import_not_found/)
})
test('Responses request is bounded, strict and not stored; incomplete/refused output is rejected', () => {
  const request = responsesRequest({ input: '{}', candidateIds: [rowId] })
  assert.equal(request.store, false); assert.equal(request.text.format.strict, true); assert.equal(request.max_output_tokens, 1500)
  assert.deepEqual(parseResponsesResult({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"matches":[]}' }] }] }), { matches: [] })
  assert.throws(() => parseResponsesResult({ status: 'incomplete' }), /incomplete/)
  assert.throws(() => parseResponsesResult({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), /refused/)
})
