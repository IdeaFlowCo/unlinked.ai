import { createHash } from 'node:crypto'
import { UNLISTED_GROUP } from './unlisted.mjs'

// Operator decisions about published people, applied when the shared snapshot
// is built. Inputs are never changed: a merge drops the merged profile from the
// projection, points its edges at the survivor and leaves an alias, so its old
// address keeps resolving. A removal drops an imported profile, its edges and
// any address merged into it (removal requests, docs/removal-requests.md).
// Revoking a decision restores the projection exactly.
// Claimed (member) profiles are never merged away or removed. An `unlist`
// keeps a profile (member or not) published but out of listings, optionally
// visible to one named group (docs/unlisted-profiles.md).

const hash = value => createHash('sha256').update(value).digest('hex')
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160
const name = value => typeof value === 'string' && value.trim() && [...value].length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)

export function validateProfileDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length > 5000) throw Error('profile_decisions_invalid')
  const merged = new Set(), renamed = new Set(), removed = new Set(), unlisted = new Set(), ids = new Set()
  for (const decision of decisions) {
    if (!decision || !id(decision.id) || ids.has(decision.id)) throw Error('profile_decisions_invalid')
    ids.add(decision.id)
    if (decision.kind === 'merge') {
      if (!id(decision.profileId) || !id(decision.survivorId) || decision.profileId === decision.survivorId || merged.has(decision.profileId)) throw Error('profile_decisions_invalid')
      merged.add(decision.profileId)
    } else if (decision.kind === 'rename') {
      if (!id(decision.profileId) || !name(decision.name) || renamed.has(decision.profileId)) throw Error('profile_decisions_invalid')
      renamed.add(decision.profileId)
    } else if (decision.kind === 'remove') {
      if (!id(decision.profileId) || removed.has(decision.profileId)) throw Error('profile_decisions_invalid')
      removed.add(decision.profileId)
    } else if (decision.kind === 'unlist') {
      if (!id(decision.profileId) || unlisted.has(decision.profileId) || (decision.group !== undefined && decision.group !== null && (typeof decision.group !== 'string' || !UNLISTED_GROUP.test(decision.group)))) throw Error('profile_decisions_invalid')
      unlisted.add(decision.profileId)
    } else throw Error('profile_decisions_invalid')
  }
  // No chains: a survivor is never itself merged away.
  for (const decision of decisions) if (decision.kind === 'merge' && merged.has(decision.survivorId)) throw Error('profile_decisions_invalid')
  return decisions
}

// The usable subset of stored decisions: the first valid decision per profile,
// minus any merge whose survivor is itself merged. A stray or racing operator
// write can only make a decision inert, never break the published index.
export function usableProfileDecisions(decisions) {
  const usable = [], seen = new Set()
  for (const decision of Array.isArray(decisions) ? decisions.slice(0, 5000) : []) {
    try { validateProfileDecisions([decision]) } catch { continue }
    const key = `${decision.kind}:${decision.profileId}`
    if (seen.has(key) || seen.has(`id:${decision.id}`)) continue
    seen.add(key); seen.add(`id:${decision.id}`); usable.push(decision)
  }
  const merged = new Set(usable.filter(value => value.kind === 'merge').map(value => value.profileId))
  return usable.filter(value => value.kind !== 'merge' || !merged.has(value.survivorId))
}

export function applyProfileDecisions(snapshot, stored) {
  const decisions = usableProfileDecisions(stored)
  if (!decisions.length) return snapshot
  const known = new Map(snapshot.profiles.map(profile => [profile.id, profile]))
  const members = new Set(snapshot.members ?? [])
  // A decision about a profile that is not published, or that would merge a
  // claimed profile away, is inert rather than fatal.
  const merges = new Map(decisions.filter(value => value.kind === 'merge' && known.has(value.profileId) && known.has(value.survivorId) && !members.has(value.profileId)).map(value => [value.profileId, value.survivorId]))
  const renames = new Map(decisions.filter(value => value.kind === 'rename' && known.has(value.profileId)).map(value => [value.profileId, value.name.trim()]))
  const point = value => merges.get(value) ?? value
  // A removal names a published profile (or an address merged into one) that
  // nobody has claimed; it removes the profile it resolves to.
  const removals = new Map(decisions.filter(value => value.kind === 'remove' && known.has(value.profileId) && !members.has(point(value.profileId))).map(value => [value.profileId, point(value.profileId)]))
  const removed = new Set(removals.values())
  // Unlisting follows merges to the profile shown; a removed profile has nothing to unlist.
  const unlists = new Map(decisions.filter(value => value.kind === 'unlist' && known.has(value.profileId) && !removed.has(point(value.profileId))).map(value => [value.profileId, { id: point(value.profileId), group: typeof value.group === 'string' ? value.group : null }]))
  const fill = (survivor, merged) => {
    const result = { ...survivor }
    for (const key of ['headline', 'location', 'about', 'company', 'industry', 'linkedinUrl', 'website']) if (result[key] === undefined && merged[key] !== undefined) result[key] = merged[key]
    for (const key of ['positions', 'education', 'skills']) if (!result[key]?.length && merged[key]?.length) result[key] = merged[key]
    return result
  }
  const survivors = new Map()
  for (const [mergedId, survivorId] of merges) survivors.set(survivorId, fill(survivors.get(survivorId) ?? known.get(survivorId), known.get(mergedId)))
  const profiles = snapshot.profiles.filter(profile => !merges.has(profile.id) && !removed.has(profile.id)).map(profile => {
    const value = survivors.get(profile.id) ?? profile
    return renames.has(profile.id) ? { ...value, name: renames.get(profile.id) } : value
  })
  const pairs = new Map()
  for (const edge of snapshot.connections) {
    const fromId = point(edge.fromId), toId = point(edge.toId)
    if (fromId !== toId && !removed.has(fromId) && !removed.has(toId)) pairs.set(JSON.stringify([fromId, toId]), { fromId, toId })
  }
  const applied = decisions.filter(value => value.kind === 'merge' ? merges.has(value.profileId) : value.kind === 'remove' ? removals.has(value.profileId) : value.kind === 'unlist' ? unlists.has(value.profileId) : renames.has(value.profileId))
    .map(value => [value.id, value.kind, value.profileId, value.kind === 'merge' ? value.survivorId : value.kind === 'remove' ? removals.get(value.profileId) : value.kind === 'unlist' ? `${unlists.get(value.profileId).id}#${unlists.get(value.profileId).group ?? ''}` : value.name.trim()])
  // One entry per shown profile; the first decision about it wins.
  const unlisted = [...new Map([...unlists.values()].reverse().map(value => [value.id, value])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return {
    ...snapshot,
    revision: `${snapshot.revision}+decisions:${hash(JSON.stringify(applied)).slice(0, 16)}`,
    profiles,
    connections: [...pairs.values()],
    ...(snapshot.members ? { members: [...new Set(snapshot.members.map(point))].sort() } : {}),
    ...(snapshot.legacyMembers ? { legacyMembers: [...new Set(snapshot.legacyMembers.map(point))].filter(value => !removed.has(value)).sort() } : {}),
    // An address merged into a removed profile no longer resolves.
    aliases: Object.fromEntries([...merges].filter(([, survivor]) => !removed.has(survivor)).sort()),
    ...(unlisted.length ? { unlisted } : {}),
  }
}
