import { createHash } from 'node:crypto'
import { createQueryMatcher, words } from './text-match.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')

// Retrieval evaluates every public profile; model ranking receives the bounded
// best lexical candidates, not private import rows or an arbitrary first page.
// The caller must authenticate its member/grant before invoking this service.
export function createSharedPeopleSearch({ readPublishedSnapshot, complete }) {
  if (typeof readPublishedSnapshot !== 'function' || typeof complete !== 'function') throw new Error('shared_search_configuration_required')
  return async ({ query, signal }) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 1024) throw new Error('shared_search_query_invalid')
    signal?.throwIfAborted()
    const data = await readPublishedSnapshot({ signal })
    if (!data || data.state !== 'published' || data.complete !== true || typeof data.revision !== 'string' || !Array.isArray(data.profiles) || data.profiles.length > 20000) throw new Error('shared_people_unavailable')
    const matcher = createQueryMatcher(query, 'best')
    const eligible = []
    for (const profile of data.profiles) {
      const professional = [profile.name, profile.headline, profile.company, profile.about, ...(profile.positions ?? []).flatMap(value => [value.title, value.company, value.description]), ...(profile.education ?? []).flatMap(value => [value.institution, value.degree]), ...(profile.skills ?? [])].filter(value => typeof value === 'string')
      // Word forms count (“investors” reaches “investor”); profiles with every word lead the shortlist.
      const found = matcher ? matcher.test({ text: words(professional.join(' ')), name: words(profile.name) }) : { matched: 0 }
      const score = found.matched ? found.matched * 3 + found.inName * 2 + (found.all ? 100 : 0) : 0
      if (score) eligible.push({ profile, score })
    }
    eligible.sort((a, b) => b.score - a.score || (a.profile.id < b.profile.id ? -1 : a.profile.id > b.profile.id ? 1 : 0))
    const shortlisted = eligible.slice(0, 200), ids = new Map(), observations = shortlisted.map(({ profile }) => {
      const id = hash(`unlinked-public-profile:${profile.id}`); ids.set(id, profile)
      const fields = { name: profile.name.slice(0, 256), headline: (profile.headline ?? '').slice(0, 256), company: (profile.company ?? '').slice(0, 256), roles: (profile.positions ?? []).slice(0, 5).map(value => `${value.title} at ${value.company}`).join('; ').slice(0, 512), skills: (profile.skills ?? []).join(', ').slice(0, 512) }
      return { id, fields }
    })
    let matches = []
    if (observations.length) {
      const input = JSON.stringify({ query: query.trim(), observations })
      if (Buffer.byteLength(input) > 256 * 1024) throw new Error('shared_search_context_limit')
      const result = await complete({ input, candidateIds: observations.map(value => value.id), signal })
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
    return { scope: 'everyone', mode: 'public_index_retrieval_ai_rank', revision: data.revision, considered: data.profiles.length, lexicalMatches: eligible.length, modelCandidates: observations.length, matches }
  }
}
