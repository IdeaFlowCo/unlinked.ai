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
  const deduped = await createPrivateSearch({ readImport: async () => publication, complete: async () => ({ matches: [{ id: rowId, reason: 'one' }, { id: rowId, reason: 'two' }] }) })({ importId: id, query: 'contact' })
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

// The stub deliberately proposes unsupported investment claims in reverse
// order. Observable results must be safe even with these bad model reasons.
const { searchPeople } = await import('./fixtures/private-search-people.mjs')
const evidencePublication = { ...publication, indexed: searchPeople.length, assertions: searchPeople }
const badReasons = async ({ candidateIds }) => ({ matches: candidateIds.slice(-10).reverse().map(id => ({ id, reason: 'Likely investing in gaming; possibly covering climate.' })) })

test('role evidence beats domain-only: gaming founders and CEOs are omitted, reasons cite records without hedging, shape stays unchanged', async () => {
  const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: badReasons })({ importId: id, query: 'Find investors in my network who invest in gaming companies' })
  assert.deepEqual(result.matches.map(match => match.fields['first name']), ['Gaming Investor', 'Investment Principal', 'Investment Partner', 'General Investor'])
  assert.equal(result.matches[0].reason, 'Title: "Investor, gaming and esports". Company: "Example Seed". Gaming is mentioned in these fields; sector focus is not independently verified.')
  assert.equal(result.matches.at(-1).reason, 'Title: "Investor". Company: "Example Capital". Gaming sector focus is not evidenced in the supplied fields.')
  for (const match of result.matches) {
    assert.doesNotMatch(match.reason, /likely|possibly|potential/i)
    assert.deepEqual(Object.keys(match).sort(), ['assertionId', 'fields', 'reason', 'rowId', 'sourceId', 'subject'])
  }
  assert.deepEqual(Object.keys(result).sort(), ['considered', 'importId', 'indexed', 'matches', 'mode'])
  assert.equal(result.considered, searchPeople.length)
  assert.equal(result.mode, 'query_time_ai')
})

for (const [query, names] of [
  ['Find engineers in gaming', ['Game Engineer']],
  ['Find recruiters in climate', ['Climate Recruiter']],
  ['Who is an investor in gaming?', ['Gaming Investor', 'Investment Principal', 'Investment Partner', 'General Investor']],
  ['Find people who invest in gaming', ['Gaming Investor', 'Investment Principal', 'Investment Partner', 'General Investor']],
]) test(`title evidence for ${query}`, async () => {
  const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: badReasons })({ importId: id, query })
  assert.deepEqual(result.matches.map(match => match.fields['first name']), names)
})

test('compound and exclusion queries keep semantic ranking rather than requiring every mentioned role', async () => {
  for (const query of ['investors or founders in gaming', 'gaming founders, not investors', 'recruiters for engineers', 'Find people hiring engineers', 'Find people without investor experience', 'Find non-engineers in gaming', 'Find people other than investors']) {
    const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'A supplied founder title' }] }) })({ importId: id, query })
    assert.equal(result.matches[0].fields['first name'], 'Studio Founder')
  }
})

test('3153 connections are evaluated locally before provider selection; no additional calls, and the final consistency fence stays active', async () => {
  const assertions = Array.from({ length: 3153 }, (_, i) => ({ ...searchPeople[i === 3152 ? 3 : 0], id: i.toString(16).padStart(64, '0') }))
  const large = { ...publication, indexed: 3153, assertions }
  let calls = 0, reads = 0
  const result = await createPrivateSearch({ readImport: async () => { reads++; return large }, complete: async ({ candidateIds }) => {
    calls++; assert.deepEqual(candidateIds, [assertions.at(-1).id])
    return badReasons({ candidateIds })
  } })({ importId: id, query: 'investors in gaming' })
  assert.equal(result.considered, 3153)
  assert.equal(result.matches[0].assertionId, assertions.at(-1).id)
  assert.equal(calls, 1)
  assert.equal(reads, 2)
  reads = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => ++reads === 1 ? large : { ...large, assertions: [] }, complete: badReasons })({ importId: id, query: 'investors in gaming' }), /private_import_not_found/)

  // Zero role evidence still performs the second read, without calling a model.
  reads = 0
  await assert.rejects(createPrivateSearch({ readImport: async () => ++reads === 1 ? { ...large, assertions: assertions.slice(0, -1) } : large, complete: async () => { assert.fail('No role-supported candidates') } })({ importId: id, query: 'investors in gaming' }), /private_import_not_found/)
})

test('quoted evidence respects the 512-character reason bound even with escaped fields', async () => {
  const fields = { position: 'Investor ' + '"'.repeat(247), company: 'Gaming ' + '\n'.repeat(249) }
  const long = { ...publication, assertions: [{ ...publication.assertions[0], fields }] }
  const result = await createPrivateSearch({ readImport: async () => long, complete: badReasons })({ importId: id, query: 'investors in gaming' })
  assert.ok(result.matches[0].reason.length <= 512)
  assert.match(result.matches[0].reason, /Title: "Investor/)
})

test('investment-company employees need an investment title; founders with explicit angel-investor evidence remain eligible', async () => {
  const entries = [
    ['Principal Engineer', 'Example Capital'],
    ['Associate Software Engineer', 'Example Ventures'],
    ['Founder & Angel Investor', 'Example Gaming'],
    ['Investor Relations', 'Example Capital'],
  ].map(([position, company], i) => ({ ...searchPeople[0], id: (i + 20).toString(16).padStart(64, '0'), fields: { position, company } }))
  const result = await createPrivateSearch({ readImport: async () => ({ ...publication, assertions: entries }), complete: badReasons })({ importId: id, query: 'investors in gaming' })
  assert.deepEqual(result.matches.map(match => match.fields.position), ['Founder & Angel Investor'])
})

test('engineering leadership is role evidence; a gaming CEO without an engineering title is omitted', async () => {
  const entries = ['Software Engineering Manager', 'Head of Engineering', 'VP of Engineering', 'Founder & CEO'].map((position, i) => ({ ...searchPeople[0], id: (i + 30).toString(16).padStart(64, '0'), fields: { position, company: 'Example Gaming' } }))
  const result = await createPrivateSearch({ readImport: async () => ({ ...publication, assertions: entries }), complete: badReasons })({ importId: id, query: 'Find engineers in gaming' })
  assert.deepEqual(result.matches.map(match => match.fields.position), ['VP of Engineering', 'Head of Engineering', 'Software Engineering Manager'])
})

test('guarded provider requests allow natural reasons and preserve the conversational model output', async () => {
  const reason = 'Investor at Example Seed — their title mentions gaming and esports.'
  let requests = 0
  const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: async input => {
    assert.equal(Object.hasOwn(input, 'evidenceOnly'), false)
    const request = responsesRequest(input)
    assert.deepEqual(request.text.format.schema.properties.matches.items.properties.reason, { type: 'string', maxLength: 512 })
    requests++
    return { matches: [{ id: input.candidateIds[0], reason }] }
  } })({ importId: id, query: 'investors in gaming' })
  assert.equal(requests, 1)
  assert.equal(result.matches[0].reason, reason)
})

test('company names and investor-relations requests are not misread as founder/investor constraints', async () => {
  const entries = [
    ['Investor', 'Example Founders Fund'],
    ['Investor Relations Manager', 'Example Capital'],
  ].map(([position, company], i) => ({ ...searchPeople[0], id: (i + 40).toString(16).padStart(64, '0'), fields: { position, company } }))
  for (const [query, index] of [['Find contacts at Example Founders Fund', 0], ['Find investor relations managers', 1]]) {
    let calls = 0
    const result = await createPrivateSearch({ readImport: async () => ({ ...publication, assertions: entries }), complete: async ({ candidateIds }) => {
      calls++; assert.deepEqual(candidateIds, entries.map(row => row.id))
      return { matches: [{ id: entries[index].id, reason: `Supplied title: ${entries[index].fields.position}` }] }
    } })({ importId: id, query })
    assert.equal(calls, 1)
    assert.equal(result.matches[0].fields.position, entries[index].fields.position)
  }
})

test('natural reasons survive sector ordering and never displace the role guard', async () => {
  const reasons = new Map([
    ['Gaming Investor', 'Investor at Example Seed — their title mentions gaming and esports.'],
    ['General Investor', "Investor at Example Capital — gaming focus isn't shown in their title, worth asking."],
    ['Investment Partner', "General partner at Example Ventures — gaming focus isn't shown in the record, worth asking."],
    ['Investment Principal', "Principal at Example Ventures — gaming focus isn't shown in the record, worth asking."],
  ])
  let calls = 0
  const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: async ({ candidateIds }) => {
    calls++
    return { matches: candidateIds.slice().reverse().map(id => {
      const person = searchPeople.find(row => row.id === id)
      assert.ok(reasons.has(person.fields['first name']), 'Domain-only people never reach model selection')
      return { id, reason: reasons.get(person.fields['first name']) }
    }) }
  } })({ importId: id, query: 'Find investors in my network who invest in gaming companies' })
  assert.deepEqual(result.matches.map(match => match.fields['first name']), ['Gaming Investor', 'Investment Principal', 'Investment Partner', 'General Investor'])
  for (const match of result.matches) {
    assert.equal(match.reason, reasons.get(match.fields['first name']))
    assert.ok(match.reason.length <= 140)
  }
  assert.equal(calls, 1)
})

for (const reason of ['', ' \t\n ', 'LIKELY invests in gaming.', 'Possibly a gaming investor.', 'Probably invests in gaming.', 'Perhaps invests in gaming.', 'Maybe invests in gaming.', 'Potentially a gaming investor.', 'Potential gaming investment focus.']) {
  test(`empty/hedged reason falls back to supplied evidence: ${JSON.stringify(reason)}`, async () => {
    let calls = 0
    const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: async ({ candidateIds }) => {
      calls++
      assert.ok(candidateIds.includes(searchPeople[3].id))
      return { matches: [{ id: searchPeople[3].id, reason }] }
    } })({ importId: id, query: 'investors in gaming' })
    assert.equal(result.matches[0].reason, 'Title: "Investor". Company: "Example Capital". Gaming sector focus is not evidenced in the supplied fields.')
    assert.equal(calls, 1, 'The local post-check never retries the model')
  })
}

test('empty model reason in a semantic query also falls back without adding role constraints', async () => {
  const result = await createPrivateSearch({ readImport: async () => evidencePublication, complete: async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: ' ' }] }) })({ importId: id, query: 'investors or founders in gaming' })
  assert.equal(result.matches[0].fields['first name'], 'Studio Founder')
  assert.match(result.matches[0].reason, /^Title: "Founder"\. Company: "#define PIXEL GAMES"\./)
})
