import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnrichmentSpendLedger, createMemoryEnrichmentSpendStore, createNeo4jEnrichmentSpendStore, normalizeSpendConfig, SPEND_CYPHER, SPEND_CONSTRAINTS, PROVISIONAL_MONTHLY_CAP_CENTS, ENRICHMENT_BUDGET_NOTICE_KIND, MICROS_PER_CENT } from '../mcp-server/enrichment-spend.mjs'
import { createEnrichmentPlan } from '../mcp-server/enrichment-providers.mjs'
import { autoEnrichmentEligibility, autoEnrichmentSubjects, isValidatedImport } from '../mcp-server/auto-enrichment-eligibility.mjs'
import { evaluateContribution, identityHash } from '../mcp-server/contribution-eligibility.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const cents = value => value * MICROS_PER_CENT
const person = n => `https://www.linkedin.com/in/person-${n}`
const tick = () => new Promise(resolve => setImmediate(resolve))
const clockAt = start => { const clock = { at: start, now: () => clock.at }; return clock }

// A FAKE Neo4j driver: it does not execute Cypher. It recognises the store's
// constant statements (SPEND_CYPHER) by identity and applies them to maps, and
// it models the write lock a transaction's first statement takes on the month
// node as one mutex per write transaction (with rollback on error). Every
// statement yields to the event loop, so concurrent transactions interleave
// whenever the mutex is off. It proves the store's protocol and record mapping,
// not real Neo4j locking.
function fakeNeo4j({ serialize = true } = {}) {
  const db = { months: new Map(), entries: new Map(), notices: new Map() }, seen = []
  const int = value => value === null || value === undefined ? value : { toNumber: () => value }
  const INTS = new Set(['estimateMicros', 'holdMicros', 'settledMicros', 'reportedMicros', 'reservedAt', 'settledAt', 'refusedAt', 'attempt', 'threshold', 'capMicros', 'spentMicros', 'reservedMicros', 'refused', 'attempts', 'createdAt', 'updatedAt', 'claimedAt', 'sentAt', 'lockedAt'])
  const out = node => Object.fromEntries(Object.entries(node).map(([key, value]) => [key, INTS.has(key) ? int(value) : value]))
  const rows = list => ({ records: list.map(node => ({ get: () => out(node) })) })
  const apply = (node, text, ints, extra = {}) => { for (const [key, value] of Object.entries({ ...text, ...ints, ...extra })) { if (value === null) delete node[key]; else node[key] = value } return node }
  const handlers = {
    lockMonth: ({ month, at }) => { if (!db.months.has(month)) db.months.set(month, { month, createdAt: at, suspended: [] }); db.months.get(month).lockedAt = at; return rows([db.months.get(month)]) },
    setSuspended: ({ month, suspended }) => { db.months.get(month).suspended = suspended; return rows([]) },
    getEntry: ({ id }) => rows(db.entries.has(id) ? [db.entries.get(id)] : []),
    putEntry: ({ text, ints, flags }) => { db.entries.set(text.id, apply(db.entries.get(text.id) ?? {}, text, ints, { flags })); return rows([]) },
    totals: ({ month, ownerId }) => {
      let spent = 0, reserved = 0, refused = 0
      for (const e of db.entries.values()) if (e.month === month && (ownerId === null || e.ownerId === ownerId)) { if (e.state === 'settled') spent += e.settledMicros; else if (e.state === 'reserved') reserved += e.holdMicros; else if (e.state === 'refused') refused++ }
      const values = { spent: int(spent), reserved: int(reserved), refused: int(refused) }
      return { records: [{ get: name => values[name] }] }
    },
    lockNotice: ({ id, at }) => { const notice = db.notices.get(id); if (notice) notice.lockedAt = at; return rows(notice ? [notice] : []) },
    putNotice: ({ text, ints }) => { db.notices.set(text.id, apply(db.notices.get(text.id) ?? {}, text, ints)); return rows([]) },
    monthEntries: ({ month }) => rows([...db.entries.values()].filter(e => e.month === month)),
    staleEntries: ({ before, limit }) => rows([...db.entries.values()].filter(e => e.state === 'reserved' && e.reservedAt < before).sort((a, b) => a.reservedAt - b.reservedAt).slice(0, limit)),
    notices: ({ states, limit }) => rows([...db.notices.values()].filter(n => states.includes(n.state)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit)),
    monthNotices: ({ month }) => rows([...db.notices.values()].filter(n => n.month === month)),
  }
  const byStatement = new Map(Object.entries(SPEND_CYPHER).map(([name, query]) => [query, handlers[name]]))
  let lock = Promise.resolve()
  const tx = log => ({ run: async (query, params = {}) => {
    seen.push([query, params]); log.push(query); await tick()
    if (SPEND_CONSTRAINTS.includes(query)) return rows([])
    const handler = byStatement.get(query)
    if (!handler) throw new Error('fake: unknown statement')
    return handler(structuredClone(params))
  } })
  const write = async fn => {
    let release; const mine = new Promise(resolve => { release = resolve })
    const previous = lock; if (serialize) { lock = previous.then(() => mine); await previous }
    const snapshot = structuredClone(db), log = []
    try { const result = await fn(tx(log)); if (serialize && log[0] !== SPEND_CYPHER.lockMonth && log[0] !== SPEND_CYPHER.lockNotice && !SPEND_CONSTRAINTS.includes(log[0])) throw new Error('fake: write transaction did not lock first'); return result }
    catch (error) { Object.assign(db, snapshot); throw error } finally { release() }
  }
  const driver = { session: () => ({ executeWrite: write, executeRead: fn => fn(tx([])), close: async () => {} }) }
  return { driver, db, seen }
}

const stores = {
  memory: () => ({ store: createMemoryEnrichmentSpendStore() }),
  'neo4j (fake driver)': () => { const fake = fakeNeo4j(); return { store: createNeo4jEnrichmentSpendStore(fake.driver), fake } },
}
const ledgerWith = (make, config, clock = clockAt(Date.UTC(2026, 10, 16, 12)), notifier = null) => { const { store, fake } = make(); return { ledger: createEnrichmentSpendLedger({ store, config, now: clock.now, notifier }), clock, fake } }
const reserveFor = (ledger, n, extra = {}) => ledger.reserve({ ownerId: 'owner-a', provider: 'paid-a', subject: person(n), estimateCents: 7, ...extra })

test('cap 0 is the default and runs nothing; the decided $100 is a documented figure, not a default; per_user is not an enforced scope', async () => {
  assert.equal(normalizeSpendConfig().capCents, 0); assert.equal(PROVISIONAL_MONTHLY_CAP_CENTS, 10000); assert.equal(normalizeSpendConfig().scope, 'shared')
  assert.throws(() => normalizeSpendConfig({ scope: 'per_user' }), { code: 'config_invalid' }); assert.throws(() => normalizeSpendConfig({ capCents: 1.5 }), { code: 'config_invalid' }); assert.throws(() => normalizeSpendConfig({ capCents: -1 }), { code: 'config_invalid' })
  const { ledger } = ledgerWith(stores.memory, {})
  assert.deepEqual(await reserveFor(ledger, 1), { outcome: 'refused', reason: 'no_budget' })
  const summary = await ledger.summary(); assert.equal(summary.capMicros, 0); assert.deepEqual(summary.notices, [], 'an unconfigured cap does not notify'); assert.equal(summary.refused, 0)
  const calls = []
  const paid = { id: 'paid-a', paid: true, estimateCents: 5, lookup: async () => { calls.push(1); return { outcome: 'found', fields: { headline: 'x' } } } }
  const plan = createEnrichmentPlan({ providers: [paid], budgets: { 'paid-a': { perDay: 100, activated: true } }, spend: ledger })
  assert.equal(plan.describe()[0].state, 'no_spend_cap')
  assert.deepEqual((await plan.enrich(person(1), { ownerId: 'owner-a' })).attempts, [{ provider: 'paid-a', result: 'no_spend_cap' }]); assert.equal(calls.length, 0)
  assert.equal(createEnrichmentPlan({ providers: [paid], budgets: { 'paid-a': { perDay: 100, activated: true } } }).describe()[0].state, 'no_spend_ledger', 'no paid provider runs without the USD ledger')
  assert.equal(createEnrichmentPlan({ providers: [{ ...paid, estimateCents: undefined }], budgets: { 'paid-a': { perDay: 100, activated: true } }, spend: createEnrichmentSpendLedger({ config: { capCents: 100 } }) }).describe()[0].state, 'no_estimate')
  assert.throws(() => createEnrichmentPlan({ providers: [{ ...paid, estimateCents: 0.5 }] }), /enrichment_providers_invalid/)
})

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: concurrent reservations never exceed the shared cap`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 100, tolerancePercent: 0 })
    const results = await Promise.all(Array.from({ length: 40 }, (_, n) => reserveFor(ledger, n, { ownerId: `owner-${n % 3}` })))
    assert.equal(results.filter(r => r.outcome === 'reserved').length, 14, '14 x 7 cents fit under 100 cents'); assert.equal(results.filter(r => r.reason === 'cap_reached').length, 26)
    const summary = await ledger.summary(); assert.ok(summary.spentMicros + summary.reservedMicros <= summary.capMicros); assert.equal(summary.reservedMicros, cents(98)); assert.equal(summary.refused, 26)
    assert.equal(Object.values(summary.perOwner).reduce((sum, owner) => sum + owner.requests, 0), 14, 'per-owner spend is recorded for reporting')
  })

  test(`${name}: a repeat is idempotent, a release reopens once, and retries are accounted once`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 1000, tolerancePercent: 0 })
    const first = await reserveFor(ledger, 1); assert.equal(first.outcome, 'reserved'); assert.equal(first.reservation.attempt, 1)
    assert.equal((await reserveFor(ledger, 1, { ownerId: 'owner-b' })).outcome, 'existing', 'the same person + provider + month is one reservation, whoever asks')
    assert.equal((await ledger.reserve({ ownerId: 'owner-a', provider: 'paid-a', subject: 'https://linkedin.com/in/Person-1/', estimateCents: 7 })).outcome, 'existing', 'the canonical address is the key')
    assert.equal((await ledger.release(first.reservation, { reason: 'transient' })).outcome, 'released')
    assert.equal((await ledger.reconcile(first.reservation, { outcome: 'found', costCents: 7 })).outcome, 'existing', 'a released reservation cannot be charged')
    const retry = await reserveFor(ledger, 1); assert.equal(retry.outcome, 'reserved'); assert.equal(retry.reservation.attempt, 2)
    assert.equal((await ledger.reconcile(first.reservation, { outcome: 'found', costCents: 7 })).outcome, 'unknown_reservation', 'a stale handle cannot settle the retry')
    assert.equal((await ledger.reconcile(retry.reservation, { outcome: 'found', costCents: 6 })).outcome, 'settled')
    assert.equal((await ledger.reconcile(retry.reservation, { outcome: 'found', costCents: 6 })).outcome, 'existing')
    assert.equal((await reserveFor(ledger, 1)).reservation.state, 'settled')
    const byRequest = await reserveFor(ledger, 2, { requestId: 'req-42' }); assert.equal((await ledger.reserve({ ownerId: 'owner-a', provider: 'paid-a', requestId: 'req-42', estimateCents: 7 })).reservation.id, byRequest.reservation.id)
    await assert.rejects(ledger.reserve({ ownerId: 'owner-a', provider: 'paid-a', subject: 'Ada Example', estimateCents: 7 }), { code: 'key_invalid' }, 'a name is never a key')
    await assert.rejects(ledger.release(byRequest.reservation, { reason: 'uncertain' }), { code: 'release_reason_invalid' })
    const summary = await ledger.summary(); assert.equal(summary.spentMicros, cents(6)); assert.equal(summary.reservedMicros, cents(7)); assert.equal(summary.perProvider['paid-a'].requests, 2)
  })

  test(`${name}: reconcile settles lower or higher truthfully; above the tolerance pauses the provider and notifies; uncertain settles at the estimate`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 1000, tolerancePercent: 20 })
    const lower = await reserveFor(ledger, 1, { estimateCents: 10 }); assert.equal(lower.reservation.holdMicros, cents(12), 'the worst case (estimate + 20%) is held against the cap')
    assert.deepEqual((await ledger.reconcile(lower.reservation, { outcome: 'found', costCents: 6 })).reservation.settledMicros, cents(6))
    const higher = await reserveFor(ledger, 2, { estimateCents: 10 }); const settledHigher = (await ledger.reconcile(higher.reservation, { outcome: 'found', costCents: 11 })).reservation
    assert.equal(settledHigher.settledMicros, cents(11)); assert.deepEqual(settledHigher.flags, ['above_estimate'])
    const uncertain = await reserveFor(ledger, 3, { estimateCents: 10 }); const settledUncertain = (await ledger.reconcile(uncertain.reservation, { outcome: 'uncertain', costCents: 1 })).reservation
    assert.equal(settledUncertain.settledMicros, cents(10)); assert.ok(settledUncertain.flags.includes('uncertain'))
    const unreported = await reserveFor(ledger, 4, { estimateCents: 10 }); assert.equal((await ledger.reconcile(unreported.reservation, { outcome: 'found' })).reservation.settledMicros, cents(10))
    const wild = await reserveFor(ledger, 5, { estimateCents: 10 }); const settledWild = (await ledger.reconcile(wild.reservation, { outcome: 'found', costCents: 30 })).reservation
    assert.equal(settledWild.settledMicros, cents(30)); assert.ok(settledWild.flags.includes('above_tolerance'))
    assert.deepEqual(await reserveFor(ledger, 6, { estimateCents: 10 }), { outcome: 'refused', reason: 'provider_suspended' })
    assert.equal((await ledger.reserve({ ownerId: 'owner-a', provider: 'paid-b', subject: person(6), estimateCents: 10 })).outcome, 'reserved', 'only the mispriced provider pauses')
    const summary = await ledger.summary(); assert.equal(summary.spentMicros, cents(6 + 11 + 10 + 10 + 30)); assert.deepEqual(summary.notices.map(n => n.id), ['2026-11:provider:paid-a'])
  })

  test(`${name}: an actual above the tolerance is recorded even past the cap, flagged, and nothing further runs`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 20, tolerancePercent: 20 })
    const only = await reserveFor(ledger, 1, { estimateCents: 10 }); assert.equal(only.outcome, 'reserved')
    assert.deepEqual(await reserveFor(ledger, 2, { estimateCents: 10 }), { outcome: 'refused', reason: 'cap_reached' }, '12 + 12 cents worst case would cross 20')
    const settled = (await ledger.reconcile(only.reservation, { outcome: 'found', costCents: 25 })).reservation
    assert.ok(settled.flags.includes('over_cap')); assert.ok(settled.flags.includes('above_tolerance'))
    const summary = await ledger.summary(); assert.equal(summary.spentMicros, cents(25)); assert.equal(summary.overCapMicros, cents(5)); assert.equal(summary.remainingMicros, 0); assert.equal(summary.flagged, 1)
    assert.equal((await ledger.reserve({ ownerId: 'owner-a', provider: 'paid-b', subject: person(3), estimateCents: 1 })).reason, 'cap_reached')
  })

  test(`${name}: months roll over in UTC and stay separate`, async () => {
    const clock = clockAt(Date.UTC(2026, 10, 30, 23, 59)), { ledger } = ledgerWith(make, { capCents: 14, tolerancePercent: 0 }, clock)
    await reserveFor(ledger, 1); await reserveFor(ledger, 2); assert.equal((await reserveFor(ledger, 3)).reason, 'cap_reached')
    clock.at = Date.UTC(2026, 11, 1, 0, 0)
    const december = await reserveFor(ledger, 1); assert.equal(december.outcome, 'reserved', 'the same person can be looked up again in a new month'); assert.equal(december.reservation.month, '2026-12')
    assert.equal((await ledger.summary('2026-11')).reservedMicros, cents(14)); assert.equal((await ledger.summary()).reservedMicros, cents(7))
  })

  test(`${name}: the cap is one shared total across owners, with per-owner reporting`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 14, tolerancePercent: 0 })
    await reserveFor(ledger, 1, { ownerId: 'owner-a' }); await reserveFor(ledger, 2, { ownerId: 'owner-a' })
    assert.equal((await reserveFor(ledger, 3, { ownerId: 'owner-b' })).reason, 'cap_reached', 'owner-b has spent nothing but the shared total is used')
    const summary = await ledger.summary(); assert.equal(summary.scope, 'shared')
    assert.deepEqual(summary.perOwner, { 'owner-a': { requests: 2, spentMicros: 0, reservedMicros: cents(14), refused: 0 }, 'owner-b': { requests: 0, spentMicros: 0, reservedMicros: 0, refused: 1 } })
  })

  test(`${name}: crossing thresholds or refusing at the cap writes exactly one labelled outbox entry each`, async () => {
    const { ledger } = ledgerWith(make, { capCents: 100, tolerancePercent: 0 })
    const est = (n, c) => reserveFor(ledger, n, { estimateCents: c })
    await est(1, 40); assert.deepEqual((await ledger.summary()).notices, [])
    await est(2, 40); assert.deepEqual((await ledger.summary()).notices.map(n => n.id), ['2026-11:threshold:80'])
    assert.equal((await est(3, 40)).reason, 'cap_reached'); assert.equal((await est(4, 40)).reason, 'cap_reached'); assert.equal((await est(4, 40)).reason, 'cap_reached')
    await est(5, 20)
    const summary = await ledger.summary()
    assert.deepEqual(summary.notices.map(n => n.id), ['2026-11:cap_reached', '2026-11:threshold:100', '2026-11:threshold:80']); assert.equal(summary.refused, 2, 'a repeated refusal of the same request counts once')
    assert.equal((await est(6, 1)).reason, 'cap_reached'); assert.equal((await ledger.summary()).notices.length, 3, 'no new entry for the same month and threshold')
  })

  test(`${name}: flush delivers through the injected notifier, retries failures with an attempt count and never resends`, async () => {
    const delivered = []; let failNext = 1
    const notifier = { deliver: async entry => { await tick(); if (failNext-- > 0) throw Object.assign(new Error('down'), { code: 'transport_down' }); delivered.push(entry) } }
    const { ledger } = ledgerWith(make, { capCents: 10, tolerancePercent: 0, thresholds: [100] }, undefined, notifier)
    assert.equal((await reserveFor(ledger, 1, { estimateCents: 10 })).outcome, 'reserved'); assert.equal((await reserveFor(ledger, 2, { estimateCents: 10 })).reason, 'cap_reached')
    assert.deepEqual(await ledger.flushNotifications(), { sent: 1, failed: 1, skipped: 0 })
    const both = await Promise.all([ledger.flushNotifications(), ledger.flushNotifications()])
    assert.deepEqual({ sent: both[0].sent + both[1].sent, failed: both[0].failed + both[1].failed }, { sent: 1, failed: 0 }, 'two flushes deliver the retry once')
    assert.deepEqual(await ledger.flushNotifications(), { sent: 0, failed: 0, skipped: 0 })
    assert.deepEqual(delivered.map(entry => entry.id).sort(), ['2026-11:cap_reached', '2026-11:threshold:100'])
    for (const entry of delivered) { assert.equal(entry.kind, ENRICHMENT_BUDGET_NOTICE_KIND); assert.equal(entry.month, '2026-11'); assert.equal(entry.capMicros, cents(10)); assert.equal(entry.reservedMicros, cents(10)); assert.equal(entry.refused, 1); assert.match(entry.proposal, /Nothing increases automatically/) }
    assert.deepEqual((await ledger.summary()).notices.map(n => [n.state, n.attempts]).sort(), [['sent', 1], ['sent', 2]])
    const quiet = ledgerWith(make, { capCents: 10, thresholds: [100], tolerancePercent: 0 }).ledger; await reserveFor(quiet, 1, { estimateCents: 10 })
    assert.deepEqual(await quiet.flushNotifications(), { sent: 0, failed: 0, skipped: 1, reason: 'no_notifier' })
    const broken = ledgerWith(make, { capCents: 10, thresholds: [100], tolerancePercent: 0, maxNoticeAttempts: 2 }, undefined, { deliver: async () => { throw new Error('x') } }).ledger; await reserveFor(broken, 1, { estimateCents: 10 })
    await broken.flushNotifications(); await broken.flushNotifications(); assert.deepEqual(await broken.flushNotifications(), { sent: 0, failed: 0, skipped: 1 }, 'retries stop at the attempt limit')
  })

  test(`${name}: the stale sweep settles a crashed worker's reservation at the estimate and never releases it`, async () => {
    const { ledger, clock } = ledgerWith(make, { capCents: 100, tolerancePercent: 0 })
    const crashed = await reserveFor(ledger, 1, { estimateCents: 10 }); const live = await (clock.at += 10 * 60 * 1000, reserveFor(ledger, 2, { estimateCents: 10 }))
    clock.at += 6 * 60 * 1000
    assert.deepEqual(await ledger.sweepStale(), { settled: 1 }); assert.deepEqual(await ledger.sweepStale(), { settled: 0 })
    const after = await reserveFor(ledger, 1); assert.equal(after.reservation.state, 'settled'); assert.equal(after.reservation.settledMicros, cents(10)); assert.ok(after.reservation.flags.includes('stale'))
    assert.equal((await ledger.release(crashed.reservation, { reason: 'transient' })).outcome, 'existing', 'a swept reservation is never released')
    assert.equal((await ledger.reconcile(crashed.reservation, { outcome: 'found', costCents: 4 })).reservation.settledMicros, cents(4), 'a late truthful report corrects it once')
    assert.equal((await ledger.reconcile(crashed.reservation, { outcome: 'found', costCents: 2 })).outcome, 'existing')
    assert.equal((await ledger.summary()).reservedMicros, cents(10), 'the live reservation is untouched'); assert.equal(live.outcome, 'reserved')
  })
}

test('the concurrency test would catch a missing lock (fake driver with the mutex off)', async () => {
  const fake = fakeNeo4j({ serialize: false })
  const ledger = createEnrichmentSpendLedger({ store: createNeo4jEnrichmentSpendStore(fake.driver), config: { capCents: 100, tolerancePercent: 0 }, now: () => Date.UTC(2026, 10, 16) })
  await Promise.all(Array.from({ length: 40 }, (_, n) => reserveFor(ledger, n)))
  assert.ok((await ledger.summary()).reservedMicros > cents(100))
})

test('the graph store uses constant parameterized statements, integer writes and recovery-domain labels', async () => {
  const fake = fakeNeo4j(), store = createNeo4jEnrichmentSpendStore(fake.driver)
  await store.initialize(); assert.deepEqual(fake.seen.map(([query]) => query), [...SPEND_CONSTRAINTS])
  const ledger = createEnrichmentSpendLedger({ store, config: { capCents: 100 }, now: () => Date.UTC(2026, 10, 16) })
  const hostile = `x'}) DETACH DELETE n //`
  const reserved = await ledger.reserve({ ownerId: hostile, provider: 'paid-a', subject: person(1), estimateCents: 7 })
  await ledger.reconcile(reserved.reservation, { outcome: 'found', costCents: 5 })
  assert.ok(fake.seen.every(([query]) => !query.includes(hostile) && !query.includes('person-1')), 'values never enter statement text')
  assert.ok(fake.seen.every(([query]) => SPEND_CONSTRAINTS.includes(query) || Object.values(SPEND_CYPHER).includes(query)))
  assert.match(SPEND_CYPHER.putEntry, /e\.settledMicros = toInteger\(\$ints\.settledMicros\)/)
  const stored = [...fake.db.entries.values()][0]; assert.equal(stored.subjectHash.length, 64); assert.ok(!JSON.stringify(stored).includes('person-1'), 'the ledger stores a hash, not the LinkedIn address')
  assert.equal((await ledger.summary()).perOwner[hostile].spentMicros, cents(5))
  for (const label of ['UnlinkedEnrichmentSpendMonth', 'UnlinkedEnrichmentSpend', 'UnlinkedEnrichmentNotice']) { assert.ok(LABELS.includes(label)); assert.ok(SPEND_CONSTRAINTS.some(statement => statement.includes(`:${label})`))) }
})

test('planner: paid lookups reserve, call and reconcile; a fallback provider is accounted once; free providers bypass USD', async () => {
  const spend = createEnrichmentSpendLedger({ config: { capCents: 100, tolerancePercent: 0 }, now: () => Date.UTC(2026, 10, 16) })
  const calls = { free: 0, a: 0, b: 0, c: 0 }
  const free = { id: 'exa-existing', paid: false, lookup: async () => { calls.free++; return { outcome: 'not_found' } } }
  const a = { id: 'paid-a', paid: true, estimateCents: 5, lookup: async () => { calls.a++; return { outcome: 'not_found', costCents: 3 } } }
  const b = { id: 'paid-b', paid: true, estimateCents: 8, lookup: async () => { calls.b++; return { outcome: 'found', fields: { headline: 'Investor' }, costCents: 8 } } }
  const budgets = { 'exa-existing': { perDay: 10 }, 'paid-a': { perDay: 10, activated: true }, 'paid-b': { perDay: 10, activated: true } }
  const plan = () => createEnrichmentPlan({ providers: [free, a, b], budgets, spend, now: () => 1000 })
  assert.equal((await plan().enrich(person(1), { ownerId: 'owner-a' })).outcome, 'found')
  // A fresh planner (no cache) replaying the same person: nothing is called or charged again.
  const replay = await plan().enrich(person(1), { ownerId: 'owner-a' })
  assert.deepEqual(replay.attempts, [{ provider: 'exa-existing', result: 'not_found' }, { provider: 'paid-a', result: 'not_found', charged: false }, { provider: 'paid-b', result: 'already_charged' }])
  assert.deepEqual(calls, { free: 2, a: 1, b: 1, c: 0 })
  let summary = await spend.summary(); assert.equal(summary.spentMicros, cents(11)); assert.equal(summary.perProvider['paid-a'].requests, 1); assert.equal(summary.perProvider['paid-b'].requests, 1); assert.equal(summary.perProvider['exa-existing'], undefined)
  // Transient: released, so a retry is not double counted; uncertain: settled at the estimate.
  const flaky = { id: 'paid-c', paid: true, estimateCents: 9, lookup: async () => { calls.c++; if (calls.c === 1) return { outcome: 'transient' }; throw new Error('socket closed') } }
  const flakyPlan = createEnrichmentPlan({ providers: [flaky], budgets: { 'paid-c': { perDay: 10, activated: true } }, spend, now: () => 1000 })
  assert.equal((await flakyPlan.enrich(person(2), { ownerId: 'owner-a' })).outcome, 'retry_later'); assert.equal((await spend.summary()).spentMicros, cents(11))
  assert.equal((await flakyPlan.enrich(person(2), { ownerId: 'owner-a' })).outcome, 'held_uncertain'); summary = await spend.summary(); assert.equal(summary.spentMicros, cents(20)); assert.equal(summary.perProvider['paid-c'].requests, 1)
  assert.deepEqual((await flakyPlan.enrich(person(3))).attempts, [{ provider: 'paid-c', result: 'no_owner' }], 'every paid charge is attributed to an account')
  // The cap stops paid providers before the call.
  const capped = { id: 'paid-d', paid: true, estimateCents: 90, lookup: async () => { throw new Error('must not be called') } }
  const cappedResult = await createEnrichmentPlan({ providers: [capped], budgets: { 'paid-d': { perDay: 10, activated: true } }, spend }).enrich(person(4), { ownerId: 'owner-a' })
  assert.deepEqual(cappedResult.attempts, [{ provider: 'paid-d', result: 'spend_refused', reason: 'cap_reached' }])
})

// ---- Eligibility -----------------------------------------------------------

const owner = { ownerId: 'owner-a', userId: 'user-a' }
const rows = Array.from({ length: 60 }, (_, n) => ({ linkedinUrl: `https://www.linkedin.com/in/contact-${n}`, connectedOn: `2024-01-${String(n % 28 + 1).padStart(2, '0')}` }))
const receiptFor = (extra = {}) => evaluateContribution({ owner, archiveSha256: 'a'.repeat(64), rows, now: () => 1, ...extra })

test('auto-enrichment eligibility: one validated import, no approval, independent of Pro and of every tier, and grants nothing', () => {
  const none = autoEnrichmentEligibility({ owner, receipts: [] }); assert.equal(none.eligible, false); assert.equal(none.reason, 'no_validated_import'); assert.deepEqual(none.targets, [])
  // Already-shared people: not eligible for contribution credit, still a validated upload.
  const shared = receiptFor({ knownShared: new Set(rows.map((_, n) => identityHash(`contact-${n}`))) })
  assert.equal(shared.eligible, false, 'earns no contribution credit')
  const results = ['standard', 'approved', 'verified'].map(currentTier => autoEnrichmentEligibility({ owner: { ...owner, pro: true, tier: currentTier }, receipts: [receiptFor({ currentTier })] }))
  for (const result of results) { assert.deepEqual(result, results[0]); assert.ok(Object.keys(result).every(key => !/tier|proposal|award|grant|pro/i.test(key)), 'no tier, Pro or award is implied') }
  assert.deepEqual(results[0], { eligible: true, reason: 'validated_import', validatedArchives: ['a'.repeat(64)], targets: ['uploaded_contacts'] })
  assert.equal(isValidatedImport(shared, owner), true, 'but is still a validated upload')
  assert.equal(autoEnrichmentEligibility({ owner, receipts: [shared] }).eligible, true)
  assert.equal(isValidatedImport(receiptFor({ creditedArchives: new Set(['a'.repeat(64)]) }), owner), true, 'a replayed archive is still a valid import, it just earns no new credit')
  assert.equal(isValidatedImport(receiptFor(), { ownerId: 'owner-b', userId: 'user-b' }), false, 'another account’s receipt does not count')
  assert.equal(isValidatedImport(evaluateContribution({ owner, archiveSha256: 'b'.repeat(64), rows: rows.map(() => ({ linkedinUrl: 'Ada Example' })) }), owner), false, 'names only is not a validated import')
  assert.equal(isValidatedImport({ ...receiptFor(), kind: 'forged' }, owner), false)
  assert.equal(autoEnrichmentEligibility({ owner: {} }).reason, 'owner_required'); assert.throws(() => autoEnrichmentEligibility({ owner, targets: ['everyone'] }))
})

test('auto-enrichment subjects: uploaded contacts by exact address only; a replayed archive adds no entitlement and no charge', async () => {
  const eligibility = autoEnrichmentEligibility({ owner, receipts: [receiptFor(), receiptFor({ now: () => 2 })] })
  assert.deepEqual(eligibility.validatedArchives, ['a'.repeat(64)], 'the same archive twice is one import')
  const input = { ownProfileUrl: 'https://www.linkedin.com/in/owner-self', uploadedContactUrls: ['https://www.linkedin.com/in/contact-1', 'https://linkedin.com/in/Contact-1/', 'Ada Example', 'https://example.com/in/x', 'https://www.linkedin.com/in/contact-2'] }
  const subjects = autoEnrichmentSubjects(eligibility, input)
  assert.deepEqual(subjects.map(s => [s.slug, s.target, s.visibility]), [['contact-1', 'uploaded_contacts', 'inherit'], ['contact-2', 'uploaded_contacts', 'inherit']], 'own profile is opt-in; names and other sites are never keys')
  assert.deepEqual(autoEnrichmentSubjects(autoEnrichmentEligibility({ owner, receipts: [receiptFor()], targets: ['uploaded_contacts', 'own_profile'] }), input).map(s => s.target), ['own_profile', 'uploaded_contacts', 'uploaded_contacts'])
  assert.deepEqual(autoEnrichmentSubjects(autoEnrichmentEligibility({ owner, receipts: [] }), input), [])
  const spend = createEnrichmentSpendLedger({ config: { capCents: 100 }, now: () => Date.UTC(2026, 10, 16) })
  for (let pass = 0; pass < 2; pass++) for (const subject of autoEnrichmentSubjects(eligibility, input)) await spend.reserve({ ownerId: owner.ownerId, provider: 'paid-a', subject: `https://www.linkedin.com/in/${subject.slug}`, estimateCents: 5 })
  assert.equal((await spend.summary()).perProvider['paid-a'].requests, 2, 'replaying the upload reserves nothing new')
})
