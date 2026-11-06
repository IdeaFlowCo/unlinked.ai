import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAccountNetwork, withSearchDeadline } from '../src/utils/private-import/account-network.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'

// unlinked_ai_search used AbortSignal.any([signal, AbortSignal.timeout(ms)])
// without racing it, so a slow network read (one that ignores the signal)
// kept a direct-MCP call open for 117 s despite timeoutMs: 20000, until the
// client gave up. These pin the hard deadline and the partial-result stop.
const owner = { ownerId: 'synthetic-ask-owner', userId: 'synthetic-ask-user' }
const id = value => createHash('sha256').update(String(value)).digest('hex')
const row = (n, fields) => ({ id: id(n), ownerId: owner.ownerId, importId: id('import'), sourceId: id('source'), rowId: `Connections.csv#record=${n}`, category: 'connections', fields })
const people = Array.from({ length: 5 }, (_, n) => row(n, { 'first name': `P${n}`, company: 'Example', position: 'Investor' }))
const slowBackend = ms => async () => ({ listImportIds: async () => [], readLegacyObservations: async () => { await new Promise(resolve => setTimeout(resolve, ms)); return { assertions: people } } })
const hanging = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
const grant = { ownerId: owner.ownerId, userId: owner.userId, grantId: 'g'.repeat(64), scope: 'owner_network', version: 2, tools: ['unlinked_ai_search'] }

test('askNetwork deadline holds even when the network read ignores the abort signal', async () => {
  const net = createAccountNetwork({ owner, complete: async () => ({ matches: [] }), getBackend: slowBackend(2000) })
  const started = Date.now()
  await assert.rejects(net.askNetwork({ query: 'investors in consumer', budgetMs: 150 }), error => error.name === 'TimeoutError')
  assert.ok(Date.now() - started < 600, `took ${Date.now() - started} ms`)
})

test('askNetwork always AI-ranks (no text-first) and returns partial results at the soft stop', async () => {
  const many = Array.from({ length: 450 }, (_, n) => row(1000 + n, { 'first name': `Q${n}`, company: 'Example', position: 'Investor' }))
  const fast = many[0].id
  let calls = 0
  const complete = ({ candidateIds, signal }) => { calls++; return candidateIds.includes(fast)
    ? Promise.resolve({ matches: [{ id: fast, reason: 'Consumer investor' }] })
    : hanging({ signal }) }
  const net = createAccountNetwork({ owner, complete, getBackend: async () => ({ listImportIds: async () => [], readLegacyObservations: async () => ({ assertions: many }) }) })
  const started = Date.now()
  // "Investor" is a literal title word here; ai_search must still rank.
  const result = await net.askNetwork({ query: 'Investor', budgetMs: 300 })
  assert.ok(Date.now() - started < 300)
  assert.ok(calls > 0)
  assert.equal(result.mode, 'query_time_ai')
  assert.equal(result.partial, true)
  assert.deepEqual(result.matches.map(m => m.assertionId), [fast])
})

test('unlinked_ai_search scope mine returns a typed failure within timeoutMs on a stuck read', async () => {
  const service = createAccountToolService({ getBackend: slowBackend(5000), complete: async () => ({ matches: [] }) })
  const started = Date.now()
  await assert.rejects(service.call({ grant, name: 'unlinked_ai_search', input: { query: 'Show me three investors in the consumer space', scope: 'mine', timeoutMs: 1000 } }),
    error => error instanceof AccountToolError && error.code === 'upstream_unavailable')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 900 && elapsed < 1600, `took ${elapsed} ms`)
})

test('unlinked_ai_search scope mine surfaces partial: true', async () => {
  const many = Array.from({ length: 450 }, (_, n) => row(3000 + n, { 'first name': `R${n}`, company: 'Example', position: 'Consumer investor' }))
  const fast = many[0].id
  const complete = ({ candidateIds, signal }) => candidateIds.includes(fast) ? Promise.resolve({ matches: [{ id: fast, reason: 'Consumer fund partner' }] }) : hanging({ signal })
  const service = createAccountToolService({ getBackend: async () => ({ listImportIds: async () => [], readLegacyObservations: async () => ({ assertions: many }) }), complete })
  const { result } = await service.call({ grant, name: 'unlinked_ai_search', input: { query: 'consumer investors', scope: 'mine', timeoutMs: 1000 } })
  assert.equal(result.partial, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].name, 'R0')
})

test('unlinked_ai_search scope everyone is bounded even when the snapshot read ignores the signal', async () => {
  const service = createAccountToolService({ getBackend: slowBackend(0), complete: async () => ({ matches: [] }),
    readPublishedSnapshot: () => new Promise(resolve => setTimeout(resolve, 5000, null)) })
  const started = Date.now()
  await assert.rejects(service.call({ grant: { ...grant, scope: 'owner_network_and_public' }, name: 'unlinked_ai_search', input: { query: 'consumer investors', scope: 'everyone', timeoutMs: 1000 } }),
    error => error instanceof AccountToolError && error.code === 'upstream_unavailable')
  assert.ok(Date.now() - started < 1600)
})

test('withSearchDeadline rejects immediately for an already-aborted caller signal', async () => {
  const controller = new AbortController(); controller.abort(new Error('client_closed'))
  await assert.rejects(withSearchDeadline({ signal: controller.signal, budgetMs: 1000 }, () => new Promise(() => {})), /client_closed/)
})
