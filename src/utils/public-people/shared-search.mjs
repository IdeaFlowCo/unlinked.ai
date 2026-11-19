import { createHash } from 'node:crypto'
import { PUBLIC_INDEX_MAX_PROFILES } from './limits.mjs'
import { setTimeout as pause } from 'node:timers/promises'
import { withSearchDeadline } from '../private-import/account-network.mjs'
import { createQueryMatcher, rankMatchesCooperatively, words } from './text-match.mjs'
// Leaves time for authentication and framing before the gateway's 25 s deadline.
export const PUBLIC_AGENT_AI_BUDGET_MS = 22000
const PROVIDER_ATTEMPT_MS = 15000
const MODEL_INPUT_BYTES = 256 * 1024
const TRANSIENT_PROVIDER_FAILURE = /^private_search_provider_http_(?:408|429|5\d\d)$/
const SAFE_FAILURE = /^(?:private|known|account|legacy|shared|public)_[a-z0-9_]{1,70}$/
export const searchFailureCause = error => SAFE_FAILURE.test(error?.message ?? '') ? error.message : 'internal_error'

async function completeWithRetry(complete, input, signal) {
  try {
    return await withSearchDeadline({ signal, budgetMs: PROVIDER_ATTEMPT_MS, label: 'public_search_provider', reserveMs: 0 }, ({ deadline }) => complete({ ...input, signal: deadline }))
  } catch (error) {
    signal.throwIfAborted()
    if (!(error?.name === 'TimeoutError' || TRANSIENT_PROVIDER_FAILURE.test(error?.message ?? '') || error?.message === 'private_search_provider_network')) throw error
    // Back off with jitter. A timed-out attempt already consumed its full slice.
    const delay = Math.max(300 + Math.random() * 400, error.retryAfterMs ?? 0)
    if (delay > PROVIDER_ATTEMPT_MS) throw error
    await pause(delay, undefined, { signal })
    return withSearchDeadline({ signal, budgetMs: PROVIDER_ATTEMPT_MS, label: 'public_search_provider', reserveMs: 0 }, ({ deadline }) => complete({ ...input, signal: deadline }))
  }
}

const hash = value => createHash('sha256').update(value).digest('hex')

// Retrieval evaluates every public profile; model ranking receives the bounded
// best lexical candidates, not private import rows or an arbitrary first page.
// The caller must authenticate its member/grant before invoking this service.
import { listedFor, unlistedProfiles } from './unlisted.mjs'

export function createSharedPeopleSearch({ readPublishedSnapshot, complete }) {
  if (typeof readPublishedSnapshot !== 'function' || typeof complete !== 'function') throw new Error('shared_search_configuration_required')
  // `unlistedGroups`: the viewer's own unlisted groups (docs/unlisted-profiles.md).
  const search = async ({ query, signal, unlistedGroups }) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 1024) throw new Error('shared_search_query_invalid')
    signal?.throwIfAborted()
    const data = await readPublishedSnapshot({ signal })
    if (!data || data.state !== 'published' || data.complete !== true || typeof data.revision !== 'string' || !Array.isArray(data.profiles) || data.profiles.length > PUBLIC_INDEX_MAX_PROFILES) throw new Error('shared_people_unavailable')
    const matcher = createQueryMatcher(query, 'best')
    // Word forms count (“investors” reaches “investor”). Profiles with every word lead the
    // shortlist; the rest follow with rarer words first, so each part of the query is represented.
    const professional = profile => [profile.name, profile.headline, profile.company, profile.about, ...(profile.positions ?? []).flatMap(value => [value.title, value.company, value.description]), ...(profile.education ?? []).flatMap(value => [value.institution, value.degree]), ...(profile.skills ?? [])].filter(value => typeof value === 'string')
    const listed = listedFor(unlistedProfiles(data), unlistedGroups instanceof Set ? unlistedGroups : null)
    const ranked = matcher ? await rankMatchesCooperatively(data.profiles.filter(profile => listed(profile.id)), matcher, profile => ({ text: words(professional(profile).join(' ')), name: words(profile.name) }), { signal, tie: (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }) : { rows: [], matched: 0 }
    const ids = new Map(), observations = []
    let bytes = Buffer.byteLength(JSON.stringify({ query: query.trim(), observations }))
    for (const profile of ranked.rows.slice(0, 200)) {
      const id = hash(`unlinked-public-profile:${profile.id}`)
      const fields = { name: profile.name.slice(0, 256), headline: (profile.headline ?? '').slice(0, 256), company: (profile.company ?? '').slice(0, 256), roles: (profile.positions ?? []).slice(0, 5).map(value => `${value.title} at ${value.company}`).join('; ').slice(0, 512), skills: (profile.skills ?? []).join(', ').slice(0, 512) }
      const observation = { id, fields }
      const size = Buffer.byteLength(JSON.stringify(observation)) + Number(observations.length > 0)
      if (bytes + size > MODEL_INPUT_BYTES) break
      bytes += size
      ids.set(id, profile)
      observations.push(observation)
    }
    let matches = []
    if (observations.length) {
      const input = JSON.stringify({ query: query.trim(), observations })
      const result = await completeWithRetry(complete, { input, candidateIds: observations.map(value => value.id) }, signal)
      if (!result || !Array.isArray(result.matches) || result.matches.length > 10) throw new Error('shared_search_result_invalid')
      const seen = new Set()
      matches = result.matches.map(value => {
        if (!value || !ids.has(value.id) || seen.has(value.id) || typeof value.reason !== 'string' || value.reason.length > 512) throw new Error('shared_search_result_invalid')
        seen.add(value.id); const profile = ids.get(value.id)
        return { id: profile.id, name: profile.name, ...(profile.headline === undefined ? {} : { headline: profile.headline }), ...(profile.location === undefined ? {} : { location: profile.location }), ...(profile.company === undefined ? {} : { company: profile.company }), reason: value.reason }
      })
    }
    // A cached candidate set/model response never bypasses a revoked publication.
    const current = await readPublishedSnapshot({ signal })
    if (!current || current.state !== 'published' || current.complete !== true || current.revision !== data.revision) throw new Error('shared_people_changed')
    return { scope: 'everyone', mode: 'public_index_retrieval_ai_rank', revision: data.revision, considered: data.profiles.length, lexicalMatches: ranked.matched, modelCandidates: observations.length, matches }
  }
  return ({ query, signal, unlistedGroups = null, budgetMs = 40000 }) =>
    withSearchDeadline({ signal, budgetMs, label: 'public_people_search', reserveMs: 0 }, ({ deadline }) =>
      search({ query, signal: deadline, unlistedGroups }))
}
