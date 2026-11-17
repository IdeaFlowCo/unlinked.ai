import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'

// Exact LinkedIn address only, canonicalized the same way as connection rows
// (mcp-server/connection-identity.mjs). A name is never an identity.
const slugOf = value => { if (typeof value !== 'string') return null; try { return linkedinSlug(value) ?? linkedinSlug(canonicalLinkedinUrl(value)) } catch { return null } }

// Provider order, budgets and failure handling for profile enrichment
// (unlinked-flav, docs/enrichment-providers.md). An interface and a planner
// only: no provider is implemented or called here, nothing in the runtime uses
// this yet, and a paid provider cannot run until it is explicitly activated
// with a budget. Existing published enrichment (docs/imported-profile-enrichment.md)
// is unchanged and remains the only live path.
//
// A provider is { id, paid, estimateCents?, lookup(linkedinUrl, { signal }) } and answers
//   { outcome: 'found', fields, observedAt, costCents? | costMicros? }   real observed values only
//   { outcome: 'not_found', costCents? | costMicros? }                   definite: the next provider may try
//   { outcome: 'transient', retryAfter? }      not charged: try this one again later
// A thrown error or anything else is UNCERTAIN: it may have been charged, so it
// is counted against the budget and no other paid provider is tried for it.
//
// A paid provider additionally needs the monthly USD ledger (`spend`, from
// mcp-server/enrichment-spend.mjs) and a per-request `estimateCents`: every
// paid request is reserve -> call -> reconcile (or release when transient), so
// paid lookups pause before the shared monthly cap. Free providers bypass the
// USD ledger and keep only their daily count budget.

export const ENRICHMENT_FIELDS = Object.freeze(['headline', 'location', 'company', 'industry', 'about', 'website'])
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
const LIMITS = { headline: 500, location: 300, company: 300, industry: 200, about: 20000, website: 2048 }

// Gaps only: a value the person or their own upload already supplied is never
// replaced, and every added value keeps who observed it and when.
export function mergeEnrichment(existing = {}, observations = []) {
  const profile = { ...existing }, provenance = {}
  for (const observation of observations) for (const key of ENRICHMENT_FIELDS) {
    const value = text(observation.fields?.[key], LIMITS[key])
    if (value === undefined || text(profile[key], LIMITS[key]) !== undefined) continue
    profile[key] = value; provenance[key] = { provider: observation.provider, observedAt: observation.observedAt }
  }
  return { profile, provenance }
}

export function createMemoryEnrichmentLedger() {
  const cache = new Map(), spent = new Map(), holds = new Map()
  return {
    async cached(slug) { return cache.get(slug) ?? null },
    async remember(slug, entry) { cache.set(slug, entry) },
    async used(provider, day) { return spent.get(`${provider}:${day}`) ?? 0 },
    async charge(provider, day) { spent.set(`${provider}:${day}`, (spent.get(`${provider}:${day}`) ?? 0) + 1) },
    async held(slug) { return holds.get(slug) ?? null },
    async hold(slug, entry) { holds.set(slug, entry) },
  }
}

// providers: ordered [{ id, paid, lookup }]. budgets: { [id]: { perDay, activated } }.
// A paid provider needs activated === true AND a positive perDay; a free one
// needs only a positive perDay. Defaults are zero, so nothing runs unconfigured.
export function createEnrichmentPlan({ providers = [], budgets = {}, ledger = createMemoryEnrichmentLedger(), spend = null, now = Date.now, cacheMs = 30 * 24 * 60 * 60 * 1000, uncertainHoldMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!Array.isArray(providers) || providers.some(provider => typeof provider?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(provider.id) || typeof provider.paid !== 'boolean' || typeof provider.lookup !== 'function' || provider.estimateCents !== undefined && !(Number.isSafeInteger(provider.estimateCents) && provider.estimateCents > 0)) || new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('enrichment_providers_invalid')
  // Why a provider cannot run, or null when it can (spend cap checked per request).
  const blocked = provider => {
    const budget = budgets[provider.id]
    if (provider.paid && budget?.activated !== true) return 'not_activated'
    if (!(Number.isSafeInteger(budget?.perDay) && budget.perDay > 0)) return 'no_budget'
    if (!provider.paid) return null
    if (typeof spend?.reserve !== 'function') return 'no_spend_ledger'
    if (!provider.estimateCents) return 'no_estimate'
    if (!(spend.config?.capMicros > 0)) return 'no_spend_cap'
    return null
  }
  const allowance = provider => blocked(provider) ? 0 : budgets[provider.id].perDay
  return {
    // What would run, without running anything.
    describe: () => providers.map(provider => ({ id: provider.id, paid: provider.paid, perDay: allowance(provider), state: blocked(provider) ?? 'ready' })),
    // ownerId: the account the lookup is done for (recorded on every paid
    // charge). requestId: optional caller idempotency key; by default a paid
    // charge is keyed by person + provider + month.
    async enrich(linkedinUrl, { signal, ownerId, requestId } = {}) {
      const slug = slugOf(linkedinUrl)
      if (!slug) return { outcome: 'invalid_reference', attempts: [] }
      const at = now(), day = Math.floor(at / 86400000), attempts = []
      const hit = await ledger.cached(slug)
      if (hit && at - hit.observedAt < cacheMs) return { outcome: hit.outcome, ...(hit.fields ? { fields: hit.fields, provider: hit.provider } : {}), observedAt: hit.observedAt, cached: true, attempts }
      const held = await ledger.held(slug)
      if (held && at - held.at < uncertainHoldMs) return { outcome: 'held_uncertain', provider: held.provider, attempts }
      let definiteMisses = 0
      for (const provider of providers) {
        const perDay = allowance(provider)
        if (!perDay) { attempts.push({ provider: provider.id, result: blocked(provider) }); continue }
        if (await ledger.used(provider.id, day) >= perDay) { attempts.push({ provider: provider.id, result: 'budget_exhausted' }); continue }
        let reservation = null
        if (provider.paid) {
          if (typeof ownerId !== 'string' || !ownerId) { attempts.push({ provider: provider.id, result: 'no_owner' }); continue }
          // Reserved before the call, against the shared monthly cap.
          const reserved = await spend.reserve({ ownerId, provider: provider.id, subject: `https://www.linkedin.com/in/${slug}`, ...(requestId !== undefined ? { requestId } : {}), estimateCents: provider.estimateCents })
          if (reserved.outcome === 'refused') { attempts.push({ provider: provider.id, result: 'spend_refused', reason: reserved.reason }); continue }
          if (reserved.outcome === 'existing') {
            const previous = reserved.reservation
            // Already charged this month for this person: never charged again.
            if (previous.state === 'settled' && previous.outcome === 'not_found') { attempts.push({ provider: provider.id, result: 'not_found', charged: false }); definiteMisses++; continue }
            const result = previous.state === 'reserved' ? 'in_progress' : 'already_charged'
            attempts.push({ provider: provider.id, result })
            return { outcome: result, provider: provider.id, attempts }
          }
          reservation = reserved.reservation
        }
        // Charged before the call: an answer we never see still counts.
        await ledger.charge(provider.id, day)
        let answer
        try { answer = await provider.lookup(`https://www.linkedin.com/in/${slug}`, { signal }) } catch { answer = null }
        // A ledger write that fails leaves the reservation open; the stale sweep settles it at the estimate.
        const settle = async outcome => { if (!reservation) return; try { await spend.reconcile(reservation, { outcome, ...(Number.isSafeInteger(answer?.costMicros) ? { costMicros: answer.costMicros } : Number.isSafeInteger(answer?.costCents) ? { costCents: answer.costCents } : {}) }) } catch { attempts.at(-1).spend = 'unsettled' } }
        if (answer?.outcome === 'found') {
          const fields = Object.fromEntries(ENRICHMENT_FIELDS.map(key => [key, text(answer.fields?.[key], LIMITS[key])]).filter(([, value]) => value !== undefined))
          if (!Object.keys(fields).length) { attempts.push({ provider: provider.id, result: 'not_found' }); await settle('not_found'); definiteMisses++; continue }
          const observedAt = Number.isFinite(answer.observedAt) ? answer.observedAt : at
          await ledger.remember(slug, { outcome: 'found', fields, provider: provider.id, observedAt })
          attempts.push({ provider: provider.id, result: 'found' }); await settle('found')
          return { outcome: 'found', fields, provider: provider.id, observedAt, cached: false, attempts }
        }
        if (answer?.outcome === 'not_found') { attempts.push({ provider: provider.id, result: 'not_found' }); await settle('not_found'); definiteMisses++; continue }
        if (answer?.outcome === 'transient') {
          attempts.push({ provider: provider.id, result: 'transient' })
          if (reservation) try { await spend.release(reservation, { reason: 'transient' }) } catch { attempts.at(-1).spend = 'unsettled' }
          return { outcome: 'retry_later', provider: provider.id, ...(Number.isSafeInteger(answer.retryAfter) ? { retryAfter: answer.retryAfter } : {}), attempts }
        }
        // Uncertain: stop here so a second provider is not charged for the same person.
        await ledger.hold(slug, { provider: provider.id, at })
        attempts.push({ provider: provider.id, result: 'uncertain' }); await settle('uncertain')
        return { outcome: 'held_uncertain', provider: provider.id, attempts }
      }
      // Only a definite miss from every provider that actually ran is remembered.
      if (definiteMisses && attempts.every(attempt => attempt.result === 'not_found')) await ledger.remember(slug, { outcome: 'not_found', observedAt: at })
      return { outcome: definiteMisses ? 'not_found' : 'not_attempted', observedAt: at, cached: false, attempts }
    },
  }
}
