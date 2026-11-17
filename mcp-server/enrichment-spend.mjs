import { createHash } from 'node:crypto'
import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'

// Monthly USD ledger for paid profile enrichment (unlinked-flav,
// docs/enrichment-providers.md). Not imported by the runtime; nothing here
// calls a provider or sends a notification.
//
// Decided by Jacob (November 16): one monthly cap SHARED by all users, about
// $100 (PROVISIONAL_MONTHLY_CAP_CENTS). Paid lookups pause BEFORE the cap would
// be crossed and the owner is notified; there is no overrun path and no
// automatic cap increase. The code default stays 0: with no configuration
// nothing is reserved and nothing runs.
//
// Money is integer micro-dollars (1 cent = 10,000 micros); never a float.
// Months are UTC calendar months ('YYYY-MM'). The ledger counts incremental
// per-request spend only, not provider subscription fees.
//
// Every reservation is held against the cap at its WORST CASE (estimate plus
// the reconcile tolerance), so an actual cost inside the tolerance can never
// take the month over the cap. An actual above the tolerance is recorded
// truthfully, flagged, pauses that provider for the rest of the month and
// notifies the owner.

export const MICROS_PER_CENT = 10000
export const PROVISIONAL_MONTHLY_CAP_CENTS = 10000 // Jacob's decided figure; deliberately NOT the default
export const ENRICHMENT_BUDGET_NOTICE_KIND = 'enrichment_budget'
export const SPEND_DEFAULTS = Object.freeze({ capCents: 0, thresholds: Object.freeze([80, 100]), tolerancePercent: 20, maxEstimateCents: 500, staleAfterMs: 15 * 60 * 1000, maxNoticeAttempts: 5 })
const MAX_CAP_CENTS = 10_000_000
const NOTICE_CLAIM_MS = 10 * 60 * 1000

const fail = code => Object.assign(new Error(`enrichment_spend_${code}`), { code })
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const sha256 = value => createHash('sha256').update(value).digest('hex')
const slugOf = value => { if (typeof value !== 'string') return null; try { return linkedinSlug(value) ?? linkedinSlug(canonicalLinkedinUrl(value)) } catch { return null } }
// Stored instead of the LinkedIn address: the ledger never says who was looked up.
export const spendSubjectHash = slug => sha256('enrichment-spend-subject\u0000' + slug)
export const monthOf = at => new Date(at).toISOString().slice(0, 7)
const dollars = micros => { const cents = Math.floor(micros / MICROS_PER_CENT); return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` }
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b)

export function normalizeSpendConfig(config = {}) {
  const merged = { ...SPEND_DEFAULTS, ...config }
  const { capCents, thresholds, tolerancePercent, maxEstimateCents, staleAfterMs, maxNoticeAttempts } = merged
  // 'per_user' was considered and not chosen: the cap is one shared total. An
  // explicit other scope is refused rather than silently ignored.
  if (config.scope !== undefined && config.scope !== 'shared') throw fail('config_invalid')
  if (!integer(capCents, 0, MAX_CAP_CENTS) || !Array.isArray(thresholds) || thresholds.some(t => !integer(t, 1, 100)) || !integer(tolerancePercent, 0, 100)
    || !integer(maxEstimateCents, 1, 100000) || !integer(staleAfterMs, 1000, 7 * 24 * 60 * 60 * 1000) || !integer(maxNoticeAttempts, 1, 100)) throw fail('config_invalid')
  return Object.freeze({ scope: 'shared', capCents, capMicros: capCents * MICROS_PER_CENT, thresholds: Object.freeze([...new Set(thresholds)].sort((a, b) => a - b)), tolerancePercent, maxEstimateMicros: maxEstimateCents * MICROS_PER_CENT, staleAfterMs, maxNoticeAttempts })
}

// ---- Stores ---------------------------------------------------------------
// Both stores expose the same small transaction interface. transaction(fn)
// runs fn(tx) so that work on one month is serialized: the memory store with a
// queue, Neo4j with the write lock the first statement (lockMonth/lockNotice)
// takes on the month or notice node and holds until commit.

const clone = value => value ? structuredClone(value) : null

export function createMemoryEnrichmentSpendStore() {
  const months = new Map(), entries = new Map(), notices = new Map()
  let queue = Promise.resolve()
  const totals = (month, ownerId) => {
    let spentMicros = 0, reservedMicros = 0, refused = 0
    for (const entry of entries.values()) if (entry.month === month && (ownerId == null || entry.ownerId === ownerId)) {
      if (entry.state === 'settled') spentMicros += entry.settledMicros; else if (entry.state === 'reserved') reservedMicros += entry.holdMicros; else if (entry.state === 'refused') refused++
    }
    return { spentMicros, reservedMicros, refused }
  }
  const tx = {
    async lockMonth(month, at) { if (!months.has(month)) months.set(month, { month, createdAt: at, suspended: [] }); return clone(months.get(month)) },
    async setSuspended(month, suspended) { months.get(month).suspended = [...suspended] },
    async getEntry(id) { return clone(entries.get(id)) },
    async putEntry(entry) { entries.set(entry.id, clone(entry)) },
    async totals(month, ownerId = null) { return totals(month, ownerId) },
    async lockNotice(id) { return clone(notices.get(id)) },
    async putNotice(notice) { notices.set(notice.id, clone(notice)) },
  }
  return {
    async initialize() {},
    transaction(fn) { const run = queue.then(() => fn(tx)); queue = run.catch(() => {}); return run },
    async monthEntries(month) { return [...entries.values()].filter(entry => entry.month === month).map(clone) },
    async staleEntries(before, limit) { return [...entries.values()].filter(entry => entry.state === 'reserved' && entry.reservedAt < before).sort((a, b) => a.reservedAt - b.reservedAt).slice(0, limit).map(clone) },
    async notices(states, limit) { return [...notices.values()].filter(notice => states.includes(notice.state)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map(clone) },
    async monthNotices(month) { return [...notices.values()].filter(notice => notice.month === month).map(clone) },
  }
}

const ENTRY_TEXT = ['id', 'month', 'key', 'provider', 'ownerId', 'subjectHash', 'requestId', 'state', 'outcome', 'reason']
const ENTRY_INT = ['estimateMicros', 'holdMicros', 'settledMicros', 'reportedMicros', 'reservedAt', 'settledAt', 'refusedAt', 'attempt']
const NOTICE_TEXT = ['id', 'kind', 'reason', 'month', 'provider', 'scope', 'proposal', 'state', 'lastError']
const NOTICE_INT = ['threshold', 'capMicros', 'spentMicros', 'reservedMicros', 'refused', 'attempts', 'createdAt', 'updatedAt', 'claimedAt', 'sentAt']
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const fromGraph = (value, text, ints, lists = []) => value ? Object.fromEntries([...text, ...ints, ...lists].filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, lists.includes(key) ? [...value[key]] : number(value[key])])) : null
const pick = (record, keys) => Object.fromEntries(keys.map(key => [key, record[key] ?? null]))

// Every statement is a constant; all values are parameters. Integer fields
// are written through toInteger() so the graph never stores money as a float.
export const SPEND_CYPHER = Object.freeze({
  lockMonth: `MERGE (m:UnlinkedEnrichmentSpendMonth {month: $month}) ON CREATE SET m.createdAt = toInteger($at), m.suspended = []
    SET m.lockedAt = toInteger($at) RETURN properties(m) AS value`,
  setSuspended: 'MATCH (m:UnlinkedEnrichmentSpendMonth {month: $month}) SET m.suspended = $suspended',
  getEntry: 'MATCH (e:UnlinkedEnrichmentSpend {id: $id}) RETURN properties(e) AS value',
  putEntry: `MERGE (e:UnlinkedEnrichmentSpend {id: $text.id}) SET e += $text, e.flags = $flags,
    e.estimateMicros = toInteger($ints.estimateMicros), e.holdMicros = toInteger($ints.holdMicros), e.settledMicros = toInteger($ints.settledMicros),
    e.reportedMicros = toInteger($ints.reportedMicros), e.reservedAt = toInteger($ints.reservedAt), e.settledAt = toInteger($ints.settledAt),
    e.refusedAt = toInteger($ints.refusedAt), e.attempt = toInteger($ints.attempt)`,
  totals: `MATCH (e:UnlinkedEnrichmentSpend {month: $month}) WHERE $ownerId IS NULL OR e.ownerId = $ownerId
    RETURN sum(CASE WHEN e.state = 'settled' THEN e.settledMicros ELSE 0 END) AS spent, sum(CASE WHEN e.state = 'reserved' THEN e.holdMicros ELSE 0 END) AS reserved,
    sum(CASE WHEN e.state = 'refused' THEN 1 ELSE 0 END) AS refused`,
  lockNotice: `MATCH (n:UnlinkedEnrichmentNotice {id: $id}) SET n.lockedAt = toInteger($at) RETURN properties(n) AS value`,
  putNotice: `MERGE (n:UnlinkedEnrichmentNotice {id: $text.id}) SET n += $text,
    n.threshold = toInteger($ints.threshold), n.capMicros = toInteger($ints.capMicros), n.spentMicros = toInteger($ints.spentMicros),
    n.reservedMicros = toInteger($ints.reservedMicros), n.refused = toInteger($ints.refused), n.attempts = toInteger($ints.attempts),
    n.createdAt = toInteger($ints.createdAt), n.updatedAt = toInteger($ints.updatedAt), n.claimedAt = toInteger($ints.claimedAt), n.sentAt = toInteger($ints.sentAt)`,
  monthEntries: 'MATCH (e:UnlinkedEnrichmentSpend {month: $month}) RETURN properties(e) AS value',
  staleEntries: `MATCH (e:UnlinkedEnrichmentSpend) WHERE e.state = 'reserved' AND e.reservedAt < $before RETURN properties(e) AS value ORDER BY e.reservedAt LIMIT toInteger($limit)`,
  notices: 'MATCH (n:UnlinkedEnrichmentNotice) WHERE n.state IN $states RETURN properties(n) AS value ORDER BY n.createdAt LIMIT toInteger($limit)',
  monthNotices: 'MATCH (n:UnlinkedEnrichmentNotice {month: $month}) RETURN properties(n) AS value',
})
export const SPEND_CONSTRAINTS = Object.freeze([
  'CREATE CONSTRAINT unlinked_enrichment_spend_month IF NOT EXISTS FOR (m:UnlinkedEnrichmentSpendMonth) REQUIRE m.month IS UNIQUE',
  'CREATE CONSTRAINT unlinked_enrichment_spend_id IF NOT EXISTS FOR (e:UnlinkedEnrichmentSpend) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT unlinked_enrichment_notice_id IF NOT EXISTS FOR (n:UnlinkedEnrichmentNotice) REQUIRE n.id IS UNIQUE',
])

// Graph labels UnlinkedEnrichmentSpendMonth / UnlinkedEnrichmentSpend /
// UnlinkedEnrichmentNotice (in the recovery domain: deploy/private-pilot/graph-migration.mjs).
export function createNeo4jEnrichmentSpendStore(driver, database = 'neo4j') {
  const read = async (query, params) => {
    const session = driver.session({ database, defaultAccessMode: 'READ' })
    try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() }
  }
  const values = (result, text, ints, lists) => result.records.map(record => fromGraph(record.get('value'), text, ints, lists))
  const entries = result => values(result, ENTRY_TEXT, ENTRY_INT, ['flags'])
  const notices = result => values(result, NOTICE_TEXT, NOTICE_INT)
  const wrap = tx => ({
    async lockMonth(month, at) { const value = (await tx.run(SPEND_CYPHER.lockMonth, { month, at })).records[0].get('value'); return { month, createdAt: number(value.createdAt), suspended: [...(value.suspended ?? [])] } },
    async setSuspended(month, suspended) { await tx.run(SPEND_CYPHER.setSuspended, { month, suspended: [...suspended] }) },
    async getEntry(id) { return entries(await tx.run(SPEND_CYPHER.getEntry, { id }))[0] ?? null },
    async putEntry(entry) { await tx.run(SPEND_CYPHER.putEntry, { text: pick(entry, ENTRY_TEXT), ints: pick(entry, ENTRY_INT), flags: [...(entry.flags ?? [])] }) },
    async totals(month, ownerId = null) { const row = (await tx.run(SPEND_CYPHER.totals, { month, ownerId })).records[0]; return { spentMicros: number(row?.get('spent')) ?? 0, reservedMicros: number(row?.get('reserved')) ?? 0, refused: number(row?.get('refused')) ?? 0 } },
    async lockNotice(id, at = 0) { return notices(await tx.run(SPEND_CYPHER.lockNotice, { id, at }))[0] ?? null },
    async putNotice(notice) { await tx.run(SPEND_CYPHER.putNotice, { text: pick(notice, NOTICE_TEXT), ints: pick(notice, NOTICE_INT) }) },
  })
  return {
    async initialize() { for (const statement of SPEND_CONSTRAINTS) { const session = driver.session({ database, defaultAccessMode: 'WRITE' }); try { await session.executeWrite(tx => tx.run(statement)) } finally { await session.close() } } },
    async transaction(fn) {
      // Two first writes of a new month can race on MERGE; the loser hits the
      // uniqueness constraint and simply runs again against the committed node.
      for (let attempt = 0; ; attempt++) {
        const session = driver.session({ database, defaultAccessMode: 'WRITE' })
        try { return await session.executeWrite(tx => fn(wrap(tx))) }
        catch (error) { if (error?.code !== 'Neo.ClientError.Schema.ConstraintValidationFailed' || attempt >= 2) throw error }
        finally { await session.close() }
      }
    },
    async monthEntries(month) { return entries(await read(SPEND_CYPHER.monthEntries, { month })) },
    async staleEntries(before, limit) { return entries(await read(SPEND_CYPHER.staleEntries, { before, limit })) },
    async notices(states, limit) { return notices(await read(SPEND_CYPHER.notices, { states: [...states], limit })) },
    async monthNotices(month) { return notices(await read(SPEND_CYPHER.monthNotices, { month })) },
  }
}

// ---- Ledger ---------------------------------------------------------------

const view = entry => entry && Object.freeze({ id: entry.id, month: entry.month, provider: entry.provider, ownerId: entry.ownerId, state: entry.state, attempt: entry.attempt, estimateMicros: entry.estimateMicros, holdMicros: entry.holdMicros,
  ...(entry.state === 'settled' || entry.state === 'released' ? { settledMicros: entry.settledMicros } : {}), ...(entry.outcome ? { outcome: entry.outcome } : {}), ...(entry.reason ? { reason: entry.reason } : {}), flags: Object.freeze([...(entry.flags ?? [])]) })

// notifier: { deliver(entry) } supplied by the caller; none is built here.
export function createEnrichmentSpendLedger({ store = createMemoryEnrichmentSpendStore(), config = {}, notifier = null, now = Date.now } = {}) {
  const settings = normalizeSpendConfig(config)
  const toleranceOf = estimate => ceilDiv(estimate * (100 + settings.tolerancePercent), 100)

  const proposal = (month, totals, reason, provider) => {
    const cap = settings.capMicros, used = totals.spentMicros + totals.reservedMicros
    const lead = reason === 'provider_over_tolerance'
      ? `Provider ${provider} reported a cost above its estimate plus ${settings.tolerancePercent}% in ${month}; it is paused for the rest of the month.`
      : `Paid enrichment for ${month} has used ${dollars(totals.spentMicros)} with ${dollars(totals.reservedMicros)} in flight, ${Math.floor(used * 100 / cap)}% of the ${dollars(cap)} shared monthly cap; ${totals.refused} request(s) are paused.`
    const extended = ceilDiv(settings.capCents * 3, 200) * 100
    return `${lead} Nothing increases automatically. To continue this month, an operator may raise the cap (for example to ${dollars(extended * MICROS_PER_CENT)}); otherwise paused requests wait for next month.`
  }
  // One durable outbox entry per id. A pending entry's figures are refreshed; a sent one is never recreated.
  const ensureNotice = async (tx, month, id, reason, extra = {}) => {
    const totals = await tx.totals(month, null), at = now()
    const existing = await tx.lockNotice(id, at)
    const figures = { capMicros: settings.capMicros, spentMicros: totals.spentMicros, reservedMicros: totals.reservedMicros, refused: totals.refused, proposal: proposal(month, totals, reason, extra.provider), updatedAt: at }
    if (existing) { if (existing.state === 'pending') await tx.putNotice({ ...existing, ...figures }); return }
    await tx.putNotice({ id, kind: ENRICHMENT_BUDGET_NOTICE_KIND, reason, month, scope: settings.scope, threshold: extra.threshold ?? null, provider: extra.provider ?? null, ...figures, state: 'pending', attempts: 0, createdAt: at })
  }
  const checkThresholds = async (tx, month) => {
    if (!settings.capMicros) return
    const totals = await tx.totals(month, null), used = totals.spentMicros + totals.reservedMicros
    for (const threshold of settings.thresholds) if (used * 100 >= settings.capMicros * threshold) await ensureNotice(tx, month, `${month}:threshold:${threshold}`, 'threshold', { threshold })
  }
  const keyOf = ({ subject, requestId }) => {
    if (requestId !== undefined) return typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(requestId) ? { key: `req:${requestId}`, requestId } : null
    const slug = slugOf(subject)
    return slug ? { key: `subject:${spendSubjectHash(slug)}`, subjectHash: spendSubjectHash(slug) } : null
  }
  const settle = async (tx, entry, settledMicros, outcome, flags, reportedMicros = null) => {
    const at = now(), allFlags = new Set([...(entry.flags ?? []), ...flags])
    const next = { ...entry, state: 'settled', outcome, settledMicros, reportedMicros, settledAt: at }
    if (settledMicros > entry.estimateMicros) allFlags.add('above_estimate')
    if (settledMicros > entry.holdMicros) {
      allFlags.add('above_tolerance')
      const month = await tx.lockMonth(entry.month, at)
      if (!month.suspended.includes(entry.provider)) await tx.setSuspended(entry.month, [...month.suspended, entry.provider])
    }
    next.flags = [...allFlags]
    await tx.putEntry(next)
    const totals = await tx.totals(entry.month, null)
    if (totals.spentMicros > settings.capMicros && !next.flags.includes('over_cap')) { next.flags.push('over_cap'); await tx.putEntry(next) }
    if (next.flags.includes('above_tolerance')) await ensureNotice(tx, entry.month, `${entry.month}:provider:${entry.provider}`, 'provider_over_tolerance', { provider: entry.provider })
    await checkThresholds(tx, entry.month)
    return next
  }

  return {
    config: settings,
    // Reserve the worst case BEFORE any provider request. Outcomes:
    //   reserved  -> the caller may make exactly one request, then reconcile or release
    //   existing  -> this key is already in flight or charged: make no request
    //   refused   -> no_budget (cap 0), cap_reached or provider_suspended: make no request
    async reserve({ ownerId, provider, subject, requestId, estimateCents, estimateMicros } = {}) {
      if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 200 || typeof provider !== 'string' || !/^[a-z0-9-]{1,40}$/.test(provider)) throw fail('input_invalid')
      const estimate = estimateMicros ?? (Number.isSafeInteger(estimateCents) ? estimateCents * MICROS_PER_CENT : NaN)
      if (!integer(estimate, 1, settings.maxEstimateMicros)) throw fail('estimate_invalid')
      const key = keyOf({ subject, requestId })
      if (!key) throw fail('key_invalid')
      const at = now(), month = monthOf(at), id = `${month}|${key.key}|${provider}`
      if (!settings.capMicros) return { outcome: 'refused', reason: 'no_budget' }
      return store.transaction(async tx => {
        const monthState = await tx.lockMonth(month, at)
        const existing = await tx.getEntry(id)
        if (existing && ['reserved', 'settled'].includes(existing.state)) return { outcome: 'existing', reservation: view(existing) }
        const hold = toleranceOf(estimate)
        const base = { id, month, key: key.key, provider, ownerId: existing?.ownerId ?? ownerId, subjectHash: key.subjectHash ?? null, requestId: key.requestId ?? null, estimateMicros: estimate, holdMicros: hold, attempt: (existing?.attempt ?? 0) + 1, flags: [] }
        const refuse = async reason => {
          if (existing?.state !== 'refused') await tx.putEntry({ ...base, state: 'refused', reason, refusedAt: at, attempt: existing?.attempt ?? 0 })
          if (reason === 'cap_reached') await ensureNotice(tx, month, `${month}:cap_reached`, 'cap_reached')
          return { outcome: 'refused', reason }
        }
        if (monthState.suspended.includes(provider)) return refuse('provider_suspended')
        const totals = await tx.totals(month, null)
        // Stop before crossing: spent + in flight + this worst case must fit.
        if (totals.spentMicros + totals.reservedMicros + hold > settings.capMicros) return refuse('cap_reached')
        const entry = { ...base, state: 'reserved', reservedAt: at, reason: null }
        await tx.putEntry(entry)
        await checkThresholds(tx, month)
        return { outcome: 'reserved', reservation: view(entry) }
      })
    },
    // outcome 'found' | 'not_found' settle at the reported cost (estimate when
    // none or an invalid one is reported); 'uncertain' always settles at the
    // estimate. A repeat returns the settled record and changes nothing. A
    // late report after a stale sweep corrects the amount once.
    async reconcile(reservation, { outcome = 'uncertain', costMicros, costCents } = {}) {
      if (typeof reservation?.id !== 'string' || typeof reservation.month !== 'string') throw fail('reservation_invalid')
      return store.transaction(async tx => {
        await tx.lockMonth(reservation.month, now())
        const entry = await tx.getEntry(reservation.id)
        if (!entry || entry.attempt !== reservation.attempt) return { outcome: 'unknown_reservation' }
        const late = entry.state === 'settled' && entry.flags?.includes('stale') && !entry.flags.includes('late_reconciled')
        if (entry.state !== 'reserved' && !late) return { outcome: 'existing', reservation: view(entry) }
        const reported = costMicros ?? (Number.isSafeInteger(costCents) ? costCents * MICROS_PER_CENT : undefined)
        const known = outcome !== 'uncertain' && integer(reported, 0, 1000 * settings.maxEstimateMicros)
        const settled = known ? reported : entry.estimateMicros
        const flags = [...(known ? [] : ['settled_at_estimate']), ...(late ? ['late_reconciled'] : []), ...(outcome === 'uncertain' ? ['uncertain'] : [])]
        const next = await settle(tx, entry, settled, ['found', 'not_found'].includes(outcome) ? outcome : 'uncertain', flags, known ? reported : null)
        return { outcome: 'settled', reservation: view(next) }
      })
    },
    // Only for outcomes that provably cost nothing: the request was never sent,
    // or the provider answered transient (its contract: not charged).
    async release(reservation, { reason } = {}) {
      if (!['transient', 'not_sent'].includes(reason)) throw fail('release_reason_invalid')
      if (typeof reservation?.id !== 'string' || typeof reservation.month !== 'string') throw fail('reservation_invalid')
      return store.transaction(async tx => {
        await tx.lockMonth(reservation.month, now())
        const entry = await tx.getEntry(reservation.id)
        if (!entry || entry.attempt !== reservation.attempt) return { outcome: 'unknown_reservation' }
        if (entry.state !== 'reserved') return { outcome: 'existing', reservation: view(entry) }
        const next = { ...entry, state: 'released', reason, settledMicros: 0, settledAt: now() }
        await tx.putEntry(next)
        return { outcome: 'released', reservation: view(next) }
      })
    },
    // A worker that crashed leaves a reservation open. An operator sweep settles
    // it at the estimate (it may have been charged); it is never released.
    async sweepStale({ limit = 100 } = {}) {
      const before = now() - settings.staleAfterMs
      let settled = 0
      for (const candidate of await store.staleEntries(before, limit)) {
        const done = await store.transaction(async tx => {
          await tx.lockMonth(candidate.month, now())
          const entry = await tx.getEntry(candidate.id)
          if (entry?.state !== 'reserved' || entry.attempt !== candidate.attempt || entry.reservedAt >= before) return false
          await settle(tx, entry, entry.estimateMicros, 'uncertain', ['stale', 'settled_at_estimate'])
          return true
        })
        if (done) settled++
      }
      return { settled }
    },
    async summary(month = monthOf(now())) {
      const entries = await store.monthEntries(month), notices = await store.monthNotices(month)
      const perProvider = {}, perOwner = {}
      let spentMicros = 0, reservedMicros = 0, refused = 0, flagged = 0
      for (const entry of entries) {
        const provider = perProvider[entry.provider] ??= { requests: 0, spentMicros: 0, reservedMicros: 0, refused: 0 }
        const owner = perOwner[entry.ownerId] ??= { requests: 0, spentMicros: 0, reservedMicros: 0, refused: 0 }
        for (const bucket of [provider, owner]) {
          if (entry.state === 'settled') { bucket.requests++; bucket.spentMicros += entry.settledMicros } else if (entry.state === 'reserved') { bucket.requests++; bucket.reservedMicros += entry.holdMicros } else if (entry.state === 'refused') bucket.refused++
        }
        if (entry.state === 'settled') spentMicros += entry.settledMicros; else if (entry.state === 'reserved') reservedMicros += entry.holdMicros; else if (entry.state === 'refused') refused++
        if (entry.flags?.some(flag => ['above_estimate', 'above_tolerance', 'over_cap', 'stale', 'late_reconciled'].includes(flag))) flagged++
      }
      return { month, scope: settings.scope, capMicros: settings.capMicros, spentMicros, reservedMicros, remainingMicros: Math.max(0, settings.capMicros - spentMicros - reservedMicros), overCapMicros: Math.max(0, spentMicros - settings.capMicros),
        perProvider, perOwner, refused, flagged, notices: notices.map(notice => ({ id: notice.id, reason: notice.reason, state: notice.state, attempts: notice.attempts })).sort((a, b) => a.id.localeCompare(b.id)) }
    },
    // Delivers pending (and retryable failed) outbox entries through the
    // injected notifier. Nothing calls this automatically. Each delivery is
    // claimed first, so two flushes never deliver the same entry at once; the
    // entry id is stable and is the transport's dedupe key.
    async flushNotifications({ limit = 20 } = {}) {
      const due = await store.notices(['pending', 'failed', 'sending'], limit)
      if (typeof notifier?.deliver !== 'function') return { sent: 0, failed: 0, skipped: due.length, reason: 'no_notifier' }
      const result = { sent: 0, failed: 0, skipped: 0 }
      for (const candidate of due) {
        const claimed = await store.transaction(async tx => {
          const at = now(), notice = await tx.lockNotice(candidate.id, at)
          const reclaim = notice?.state === 'sending' && at - (notice.claimedAt ?? 0) > NOTICE_CLAIM_MS
          if (!notice || !(['pending', 'failed'].includes(notice.state) || reclaim) || notice.attempts >= settings.maxNoticeAttempts) return null
          // Figures are refreshed at delivery, so the owner sees the current month.
          const totals = await tx.totals(notice.month, null)
          const next = { ...notice, spentMicros: totals.spentMicros, reservedMicros: totals.reservedMicros, refused: totals.refused, proposal: proposal(notice.month, totals, notice.reason, notice.provider), state: 'sending', attempts: notice.attempts + 1, claimedAt: at }
          await tx.putNotice(next)
          return next
        })
        if (!claimed) { result.skipped++; continue }
        let error = null
        try { await notifier.deliver(Object.freeze({ id: claimed.id, kind: claimed.kind, reason: claimed.reason, month: claimed.month, scope: claimed.scope, threshold: claimed.threshold ?? null, provider: claimed.provider ?? null,
          capMicros: claimed.capMicros, spentMicros: claimed.spentMicros, reservedMicros: claimed.reservedMicros, refused: claimed.refused, proposal: claimed.proposal, attempt: claimed.attempts })) } catch (caught) { error = caught }
        await store.transaction(async tx => {
          const notice = await tx.lockNotice(claimed.id, now())
          if (notice?.state !== 'sending' || notice.attempts !== claimed.attempts) return
          await tx.putNotice({ ...notice, state: error ? 'failed' : 'sent', lastError: error ? String(error?.code ?? 'delivery_failed').slice(0, 100) : null, ...(error ? {} : { sentAt: now() }) })
        })
        if (error) result.failed++; else result.sent++
      }
      return result
    },
  }
}
