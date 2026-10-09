import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { matchNetworkText, TEXT_MATCH_LIMIT } from '../src/utils/private-import/network-text-search.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'

const owner = { ownerId: 'synthetic-text-owner', userId: 'synthetic-text-user' }
const id = value => createHash('sha256').update(String(value)).digest('hex')
const row = (n, fields) => ({ id: id(n), ownerId: owner.ownerId, importId: id('import'), sourceId: id('source'), rowId: `Connections.csv#record=${n}`, category: 'connections', fields })
const people = [
  row(1, { 'first name': 'Jake', 'last name': 'North', company: 'Tesla', position: 'Robotics Software' }),
  row(2, { 'first name': 'Ada', 'last name': 'Lovelace', company: 'Analytical Engines', position: 'Engineer' }),
  row(3, { 'first name': 'Zoë', 'last name': 'Tesla-Smith', company: 'Rivian', position: 'Battery engineer' }),
  row(4, { 'first name': 'Bob', 'last name': 'Builder', company: 'Example', position: 'Sales lead at Tesla Energy' }),
  row(5, { 'first name': 'Carol', 'last name': 'Atlas', company: 'Atesla Labs', position: 'Founder' }),
]
const network = (rows, complete) => createAccountNetwork({ owner, complete,
  getBackend: async () => ({ listImportIds: async () => [], readLegacyObservations: async () => ({ assertions: rows }) }) })

test('literal word-prefix match covers name, company and title, accent- and case-insensitively', () => {
  const tesla = matchNetworkText(people, 'tesla')
  assert.deepEqual(tesla.matches.map(m => m.row.fields['first name']), ['Bob', 'Jake', 'Zoë'])
  assert.deepEqual(tesla.matches.map(m => m.matchedIn), [['position'], ['company'], ['name']])
  assert.equal(tesla.total, 3)
  assert.equal(tesla.truncated, false)
  assert.deepEqual(matchNetworkText(people, 'zoe engineer').matches.map(m => m.row.fields['first name']), ['Zoë'])
  assert.deepEqual(matchNetworkText(people, 'Engineer').matches.map(m => m.row.fields['first name']), ['Ada', 'Zoë'])
  assert.equal(matchNetworkText(people, 'someone to advise on hiring').total, 0)
  assert.equal(matchNetworkText(people, '!!!'), null)
})

test('search_network answers literal queries from text without calling the model', async () => {
  let calls = 0
  const result = await network(people, async () => { calls++; return { matches: [] } }).searchNetwork({ query: 'Tesla' })
  assert.equal(calls, 0)
  assert.equal(result.mode, 'text_match')
  assert.equal(result.scope, 'owner_network')
  assert.equal(result.considered, people.length)
  assert.equal(result.total, 3)
  assert.deepEqual(result.matches.map(m => m.fields['last name']), ['Builder', 'North', 'Tesla-Smith'])
  assert.equal(result.matches[1].reason, 'Text match in company')
  assert.equal(result.matches[1].assertionId, people[0].id)
})

test('text matches are all returned up to the cap, with an explicit truncation flag', async () => {
  const many = Array.from({ length: TEXT_MATCH_LIMIT + 7 }, (_, n) => row(100 + n, { 'first name': `Person${String(n).padStart(4, '0')}`, company: 'Tesla' }))
  const result = await network(many).searchNetwork({ query: 'tesla' })
  assert.equal(result.total, TEXT_MATCH_LIMIT + 7)
  assert.equal(result.matches.length, TEXT_MATCH_LIMIT)
  assert.equal(result.truncated, true)
  assert.equal(result.matches[0].fields['first name'], 'Person0000')
})

test('a query with no literal match is AI-ranked; the AI fallback stops at its time budget', async () => {
  let calls = 0
  const ranked = await network(people, async ({ candidateIds }) => { calls++; return { matches: [{ id: candidateIds[0], reason: 'Hiring experience' }] } })
    .searchNetwork({ query: 'someone to advise on hiring' })
  assert.equal(ranked.mode, 'query_time_ai')
  assert.equal(calls, 1)
  const hanging = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  // AbortSignal.timeout timers do not hold the event loop open (a live server does).
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const started = Date.now()
    await assert.rejects(network(people, hanging).searchNetwork({ query: 'someone to advise on hiring', aiBudgetMs: 50 }), error => error.name === 'TimeoutError')
    assert.ok(Date.now() - started < 5000)
  } finally { clearInterval(keepAlive) }
  await assert.rejects(network(people).searchNetwork({ query: 'someone to advise on hiring' }), /private_search_configuration_required/)
})

test('the deadline covers the network read too, not just AI ranking', async () => {
  const slowRead = createAccountNetwork({ owner, complete: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    getBackend: async () => ({ listImportIds: async () => [], readLegacyObservations: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return { assertions: people } } }) })
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const started = Date.now()
    await assert.rejects(slowRead.searchNetwork({ query: 'someone to advise on hiring', aiBudgetMs: 200 }), error => error.name === 'TimeoutError')
    // A ranking-only budget would end at read (150 ms) + budget (200 ms).
    assert.ok(Date.now() - started < 300)
  } finally { clearInterval(keepAlive) }
})

test('the deadline holds even when a backend read ignores the abort signal', async () => {
  const stuck = createAccountNetwork({ owner, complete: async () => ({ matches: [] }),
    getBackend: async () => ({ listImportIds: async () => [], readLegacyObservations: async () => { await new Promise(resolve => setTimeout(resolve, 1000)); return { assertions: people } } }) })
  const started = Date.now()
  await assert.rejects(stuck.searchNetwork({ query: 'someone to advise on hiring', aiBudgetMs: 100 }), error => error.name === 'TimeoutError')
  assert.ok(Date.now() - started < 500)
})
