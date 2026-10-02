import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createPrivateSearch, responsesRequest, parseResponsesResult } from '../src/utils/private-import/ai-search.mjs'

const id = 'a'.repeat(64), rowId = 'b'.repeat(64)
const publication = { consent: COMBINED_UPLOAD_CONSENT, importId: id, assertions: [{ id: rowId, sourceId: 'c'.repeat(64), rowId: 'Connections.csv#record=2', category: 'connections', subject: 'https://www.linkedin.com/in/synthetic-ada', fields: { 'first name': 'Ada', position: 'Engineer', 'email address': 'private@example.invalid', phone: 'private-phone' } }] }
test('private AI search limits provider context and returns persisted provenance', async () => {
  let calls = 0
  const search = createPrivateSearch({ readImport: async requested => { assert.equal(requested, id); return publication }, complete: async ({ input, candidateIds }) => {
    calls++; assert.deepEqual(candidateIds, [rowId]); assert.equal(input.includes('private@example.invalid'), false); assert.equal(input.includes('private-phone'), false)
    return { matches: [{ id: rowId, reason: 'Engineer observation' }] }
  } })
  const result = await search({ importId: id, query: 'engineer' })
  assert.equal(calls, 1); assert.equal(result.indexed, 0); assert.equal(result.matches[0].sourceId, 'c'.repeat(64)); assert.equal(result.matches[0].fields['email address'], undefined); assert.equal(result.matches[0].fields.phone, undefined); assert.equal(result.matches[0].fields.position, 'Engineer')
  await assert.rejects(search({ importId: id, query: 'x'.repeat(1025) }), /query_limit/)
  assert.equal(calls, 1)
})
test('foreign model IDs fail closed, repeated IDs dedupe to the first reason, deleted/changed publications fail closed', async () => {
  await assert.rejects(createPrivateSearch({ readImport: async () => publication, complete: async () => ({ matches: [{ id: 'd'.repeat(64), reason: 'wrong owner' }] }) })({ importId: id, query: 'engineer' }), /invalid_result/)
  // The provider schema cannot enforce uniqueness; a repeated id keeps its first reason.
  const deduped = await createPrivateSearch({ readImport: async () => publication, complete: async () => ({ matches: [{ id: rowId, reason: 'one' }, { id: rowId, reason: 'two' }] }) })({ importId: id, query: 'engineer' })
  assert.equal(deduped.matches.length, 1)
  assert.equal(deduped.matches[0].reason, 'one')
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

test('all 1001 connection IDs participate in bounded ranking; cancellation stops the next chunk', async () => {
  const assertions = Array.from({ length: 1001 }, (_, i) => ({ ...publication.assertions[0], id: i.toString(16).padStart(64, '0') }))
  const indexed = { ...publication, indexed: 1001, assertions }, considered = new Set(), controller = new AbortController()
  const complete = async ({ candidateIds }) => {
    assert.ok(candidateIds.length <= 200); candidateIds.forEach(id => considered.add(id))
    return { matches: candidateIds.includes(assertions.at(-1).id) ? [{ id: assertions.at(-1).id, reason: 'Last contact' }] : [] }
  }
  const result = await createPrivateSearch({ readImport: async () => indexed, complete })({ importId: id, query: 'last contact' })
  assert.equal(considered.size, 1001); assert.equal(result.indexed, 1001); assert.equal(result.matches[0].assertionId, assertions.at(-1).id)
  let calls = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => indexed, complete: async () => { calls++; controller.abort(); return { matches: [] } } })({ importId: id, query: 'last contact', signal: controller.signal }))
  assert.equal(calls, 1)
  if (process.env.PRIVATE_SEARCH_EVIDENCE) await writeFile(process.env.PRIVATE_SEARCH_EVIDENCE, JSON.stringify({
    boundary: 'Executable query-time search over 1001 synthetic observations; deterministic provider completion, no network/model or Noos persistence proof.',
    consideredConnections: considered.size, result, cancelledProviderCalls: calls,
  }, null, 2))
})


for (const count of [181, 4001]) test(`${count} long-field connections with an escaped query fit exact JSON bounds in every ranking round`, async () => {
  const query = '\\'.repeat(1024)
  const fields = Object.fromEntries(['first name', 'last name', 'company', 'position', 'connected on'].map(key => [key, 'x'.repeat(256)]))
  const assertions = Array.from({ length: count }, (_, i) => ({ ...publication.assertions[0], id: i.toString(16).padStart(64, '0'), fields }))
  const indexed = { ...publication, indexed: count, assertions }, calls = []
  const result = await createPrivateSearch({ readImport: async () => indexed, complete: async ({ input, candidateIds }) => {
    assert.ok(Buffer.byteLength(input) <= 256 * 1024)
    assert.ok(candidateIds.length > 0 && candidateIds.length <= 200)
    const parsed = JSON.parse(input)
    assert.equal(parsed.query, query)
    assert.deepEqual(parsed.observations.map(row => row.id), candidateIds)
    const matches = candidateIds.slice(-10).map(id => ({ id, reason: '\\'.repeat(512) }))
    calls.push({ observations: parsed.observations, matches })
    return { matches }
  } })({ importId: id, query })
  let expected = assertions.map(row => row.id), offset = 0, rounds = 0
  while (offset < calls.length) {
    const considered = [], winners = []
    while (considered.length < expected.length) {
      const call = calls[offset++]
      assert.ok(call)
      assert.ok(call.observations.every(row => rounds === 0 ? !Object.hasOwn(row, 'priorReason') : row.priorReason === '\\'.repeat(512)))
      considered.push(...call.observations.map(row => row.id))
      winners.push(...call.matches.map(match => match.id))
    }
    assert.deepEqual(considered, expected)
    expected = winners; rounds++
  }
  assert.ok(rounds >= 2)
  assert.deepEqual(result.matches.map(match => match.assertionId), expected)
  assert.ok(result.matches.some(match => match.assertionId === assertions.at(-1).id))
  assert.equal(result.indexed, count)
})

test('a round ranks groups concurrently (bounded), retries one transient provider failure, and does not retry hard errors', async () => {
  const assertions = Array.from({ length: 801 }, (_, i) => ({ ...publication.assertions[0], id: i.toString(16).padStart(64, '0') }))
  const indexed = { ...publication, indexed: 801, assertions }
  // Hold every provider call open until three are in flight: a serial
  // implementation would deadlock here, so completion proves concurrency.
  let inFlight = 0, maxInFlight = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const complete = async ({ candidateIds }) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    if (inFlight >= 3) release()
    await gate
    inFlight--
    return { matches: candidateIds.includes(assertions.at(-1).id) ? [{ id: assertions.at(-1).id, reason: 'Last contact' }] : [] }
  }
  const result = await createPrivateSearch({ readImport: async () => indexed, complete })({ importId: id, query: 'last contact' })
  assert.ok(maxInFlight >= 3)
  assert.ok(maxInFlight <= 4)
  assert.equal(result.matches[0].assertionId, assertions.at(-1).id)

  // One transient provider failure (timeout/429/5xx) is retried once in place.
  let failed = false, ranks = 0
  const flaky = async () => {
    ranks++
    if (!failed) { failed = true; throw new Error('private_search_provider_http_429') }
    return { matches: [] }
  }
  const retried = await createPrivateSearch({ readImport: async () => indexed, complete: flaky })({ importId: id, query: 'retry once' })
  assert.deepEqual(retried.matches, [])
  assert.equal(ranks, 6) // five groups of ≤200 plus exactly one retry

  // Hard provider failures are not retried and fail the search fast.
  let hard = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => indexed, complete: async () => { hard++; throw new Error('private_search_provider_refused') } })({ importId: id, query: 'hard' }), /provider_refused/)
  assert.ok(hard >= 1 && hard <= 4)
})
