import { parseLinkedinProfileUrl } from '../linkedin-profile-url.mjs'

// Profiles that stay published (their page, links to them and their
// connections keep working) but are left out of listings: the People
// directory, search, header suggestions, company pages and AI search
// (docs/unlisted-profiles.md).
//
// Two sources:
// - Operator `unlist` decisions (profile-decisions.mjs), carried on the
//   snapshot as `unlisted: [{ id, group }]`. A profile with a `group` is still
//   listed for viewers whose own profile is unlisted in the same group, e.g.
//   the App Store review demo accounts see each other and nobody else sees
//   them. A profile without a group is unlisted for everyone.
// - Second accounts of one person: two member profiles from different
//   accounts that are provably the same person. Evidence is the same LinkedIn
//   address, or the same name, headline and About text (the person's own
//   LinkedIn text, at least ABOUT_MIN characters). Names alone never count.
//   The best-connected profile stays listed; the others are unlisted for
//   everyone. Nothing is merged: each account keeps its own profile.

export const UNLISTED_GROUP = /^[a-z0-9][a-z0-9-]{0,39}$/
const ABOUT_MIN = 40
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() : ''
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// Member profiles that duplicate another member profile of the same person:
// Map(id → survivor id). Pure; reads only the published snapshot.
export function duplicateMembers(snapshot) {
  const members = new Set(Array.isArray(snapshot?.members) ? snapshot.members : [])
  const profiles = Array.isArray(snapshot?.profiles) ? snapshot.profiles.filter(profile => profile && members.has(profile.id)) : []
  if (profiles.length < 2) return new Map()
  const parent = new Map(profiles.map(profile => [profile.id, profile.id]))
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id) } return id }
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y) }
  const seen = new Map()
  const keyed = (key, id) => { if (!key) return; if (seen.has(key)) join(seen.get(key), id); else seen.set(key, id) }
  for (const profile of profiles) {
    const slug = parseLinkedinProfileUrl(profile.linkedinUrl)?.slug
    keyed(slug ? `linkedin:${slug.toLowerCase()}` : null, profile.id)
    const name = normalized(profile.name), headline = normalized(profile.headline), about = normalized(profile.about)
    keyed(name && headline && about.length >= ABOUT_MIN ? `text:${JSON.stringify([name, headline, about])}` : null, profile.id)
  }
  const groups = new Map()
  for (const profile of profiles) { const root = find(profile.id); groups.set(root, [...(groups.get(root) ?? []), profile]) }
  const degree = new Map()
  for (const edge of Array.isArray(snapshot.connections) ? snapshot.connections : []) {
    for (const id of [edge?.fromId, edge?.toId]) if (parent.has(id)) degree.set(id, (degree.get(id) ?? 0) + 1)
  }
  const result = new Map()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // Most connections first, then a profile with a LinkedIn address, then id order.
    const [survivor, ...rest] = [...group].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || Number(Boolean(b.linkedinUrl)) - Number(Boolean(a.linkedinUrl)) || compare(a.id, b.id))
    for (const profile of rest) result.set(profile.id, survivor.id)
  }
  return result
}

// Map(id → group or null) of every profile left out of listings.
export function unlistedProfiles(snapshot) {
  const known = new Set(Array.isArray(snapshot?.profiles) ? snapshot.profiles.map(profile => profile?.id) : [])
  const hidden = new Map()
  for (const entry of Array.isArray(snapshot?.unlisted) ? snapshot.unlisted : []) {
    if (!entry || !known.has(entry.id)) continue
    hidden.set(entry.id, typeof entry.group === 'string' && UNLISTED_GROUP.test(entry.group) ? entry.group : null)
  }
  for (const id of duplicateMembers(snapshot).keys()) if (!hidden.has(id)) hidden.set(id, null)
  return hidden
}

// Whether a listing shows `id` to a viewer whose own groups are `groups` (a Set, or null).
export const listedFor = (hidden, groups) => id => {
  if (!hidden.has(id)) return true
  const group = hidden.get(id)
  return group !== null && groups instanceof Set && groups.has(group)
}
