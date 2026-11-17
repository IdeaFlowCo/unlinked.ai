import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnrichmentPlan, mergeEnrichment, createMemoryEnrichmentLedger } from '../mcp-server/enrichment-providers.mjs'
import { createEnrichmentSpendLedger } from '../mcp-server/enrichment-spend.mjs'

const url = 'https://www.linkedin.com/in/ada-example'
const provider = (id, paid, answer) => { const calls = []; return { id, paid, ...(paid ? { estimateCents: 5 } : {}), calls, lookup: async address => { calls.push(address); const value = typeof answer === 'function' ? answer(calls.length) : answer; if (value instanceof Error) throw value; return value } } }
const found = fields => ({ outcome: 'found', fields, observedAt: 1000 })
// Paid providers now also need the monthly USD ledger (enrichment-spend.test.mjs covers it in depth).
const spendLedger = () => createEnrichmentSpendLedger({ config: { capCents: 10000 }, now: () => Date.UTC(2026, 10, 16) })
const owner = { ownerId: 'owner-1' }

test('nothing runs unconfigured: paid providers need explicit activation and every provider needs a budget', async () => {
  const free = provider('exa-existing', false, found({ headline: 'Founder' })), paid = provider('paid-fallback', true, found({ headline: 'Paid' }))
  const idle = createEnrichmentPlan({ providers: [free, paid], now: () => 7000 })
  assert.deepEqual(idle.describe().map(entry => entry.state), ['no_budget', 'not_activated'])
  assert.deepEqual(await idle.enrich(url), { outcome: 'not_attempted', observedAt: 7000, cached: false, attempts: [{ provider: 'exa-existing', result: 'no_budget' }, { provider: 'paid-fallback', result: 'not_activated' }] })
  const budgetOnly = createEnrichmentPlan({ providers: [paid], budgets: { 'paid-fallback': { perDay: 100 } } })
  assert.equal((await budgetOnly.enrich(url)).outcome, 'not_attempted'); assert.equal(paid.calls.length + free.calls.length, 0, 'a budget without activation never calls a paid provider')
  assert.equal((await idle.enrich('https://example.com/in/ada')).outcome, 'invalid_reference'); assert.equal((await idle.enrich('Ada Example')).outcome, 'invalid_reference', 'a name is never a lookup key')
  assert.throws(() => createEnrichmentPlan({ providers: [free, free] })); assert.throws(() => createEnrichmentPlan({ providers: [{ id: 'x', lookup: async () => {} }] }))
})

test('providers run in order, fail over only on a definite miss, and a hit is cached with its source and time', async () => {
  const first = provider('exa-existing', false, { outcome: 'not_found' }), second = provider('paid-fallback', true, found({ headline: ' Investor ', invented: 'ignored', about: '' }))
  const spend = spendLedger()
  const plan = createEnrichmentPlan({ providers: [first, second], budgets: { 'exa-existing': { perDay: 5 }, 'paid-fallback': { perDay: 5, activated: true } }, spend, now: () => 5000 })
  const result = await plan.enrich(url, owner)
  assert.deepEqual(result, { outcome: 'found', fields: { headline: 'Investor' }, provider: 'paid-fallback', observedAt: 1000, cached: false, attempts: [{ provider: 'exa-existing', result: 'not_found' }, { provider: 'paid-fallback', result: 'found' }] })
  assert.equal((await spend.summary()).spentMicros, 50000, 'the paid hit is settled at its estimate when no cost is reported')
  const again = await plan.enrich('https://www.linkedin.com/in/Ada-Example/', owner); assert.equal(again.cached, true); assert.equal(again.provider, 'paid-fallback'); assert.equal(first.calls.length + second.calls.length, 2, 'the same person is not looked up or charged twice')
})

test('a transient failure does not fail over, and an uncertain outcome is charged once and never retried on another paid provider', async () => {
  const flaky = provider('exa-existing', false, { outcome: 'transient', retryAfter: 60 }), paid = provider('paid-fallback', true, found({ headline: 'Paid' }))
  const budgets = { 'exa-existing': { perDay: 5 }, 'paid-fallback': { perDay: 5, activated: true }, 'paid-second': { perDay: 5, activated: true } }
  assert.deepEqual(await createEnrichmentPlan({ providers: [flaky, paid], budgets, spend: spendLedger() }).enrich(url, owner), { outcome: 'retry_later', provider: 'exa-existing', retryAfter: 60, attempts: [{ provider: 'exa-existing', result: 'transient' }] }); assert.equal(paid.calls.length, 0)
  const lost = provider('paid-fallback', true, new Error('socket closed after send')), other = provider('paid-second', true, found({ headline: 'Other' })), ledger = createMemoryEnrichmentLedger()
  const spend = spendLedger()
  const plan = createEnrichmentPlan({ providers: [lost, other], budgets, ledger, spend, now: () => 86400000 * 10 })
  assert.equal((await plan.enrich(url, owner)).outcome, 'held_uncertain'); assert.equal((await plan.enrich(url, owner)).outcome, 'held_uncertain')
  assert.equal(lost.calls.length, 1); assert.equal(other.calls.length, 0); assert.equal(await ledger.used('paid-fallback', 10), 1, 'the uncertain call is counted against the budget')
  const summary = await spend.summary(); assert.equal(summary.spentMicros, 50000, 'and settled at its full estimate in the USD ledger'); assert.equal(summary.perProvider['paid-second'], undefined)
})

test('a daily budget stops calls, and only a miss from every provider that ran is remembered', async () => {
  const miss = provider('exa-existing', false, { outcome: 'not_found' }), ledger = createMemoryEnrichmentLedger()
  const plan = createEnrichmentPlan({ providers: [miss], budgets: { 'exa-existing': { perDay: 2 } }, ledger, now: () => 0 })
  assert.equal((await plan.enrich('https://www.linkedin.com/in/a-one')).outcome, 'not_found'); assert.equal((await plan.enrich('https://www.linkedin.com/in/a-two')).outcome, 'not_found')
  const third = await plan.enrich('https://www.linkedin.com/in/a-three'); assert.deepEqual(third.attempts, [{ provider: 'exa-existing', result: 'budget_exhausted' }]); assert.equal(third.outcome, 'not_attempted'); assert.equal(miss.calls.length, 2)
  assert.equal(await ledger.cached('a-three'), null, 'an unattempted person is not recorded as missing'); assert.equal((await plan.enrich('https://www.linkedin.com/in/a-one')).cached, true)
})

test('merging fills gaps only, keeps provenance per field and invents nothing', () => {
  const { profile, provenance } = mergeEnrichment({ name: 'Ada Example', headline: 'My own headline', location: '' }, [
    { provider: 'exa-existing', observedAt: 10, fields: { headline: 'Provider headline', location: 'Denver', skills: ['made up'], about: 42 } },
    { provider: 'paid-fallback', observedAt: 20, fields: { location: 'Boulder', company: 'Example' } }])
  assert.deepEqual(profile, { name: 'Ada Example', headline: 'My own headline', location: 'Denver', company: 'Example' })
  assert.deepEqual(provenance, { location: { provider: 'exa-existing', observedAt: 10 }, company: { provider: 'paid-fallback', observedAt: 20 } })
})
