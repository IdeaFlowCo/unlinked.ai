import { runAsync, runSync, ticker } from '../cooperative.mjs'
import { createHash } from 'node:crypto'
// A member's import mints a `public-<row>` person for every connection row. When
// that row's LinkedIn address is the address of a recovered legacy profile, it
// is the same person: these automatic merges fold the minted copy into the
// legacy profile. Same address is the only evidence used; names never are.
// Explicit operator decisions win, and survivors follow explicit merges.

export function linkedinSlug(subject) {
  const match = /^https:\/\/www\.linkedin\.com\/in\/([^/?#]+)$/.exec(typeof subject === 'string' ? subject : '')
  if (!match) return null
  try { return decodeURIComponent(match[1]).toLowerCase() } catch { return null }
}

// The canonical form of a stored slug key: percent-decoded and lowercased,
// exactly as linkedinSlug() returns it. The recovered legacy manifests store
// non-ASCII slugs percent-encoded (`ceyda-k%c4%b1ran-…`) while imports decode
// them, so index keys must pass through this before any comparison
// (unlinked-ade). A key that is not valid percent-encoding stays as written.
export function normalizeLinkedinSlug(value) {
  if (typeof value !== 'string' || !value) return null
  try { return decodeURIComponent(value).toLowerCase() } catch { return value.toLowerCase() }
}

// A slug -> profile id index with every key in canonical form; the first entry wins.
export function normalizedSlugIndex(entries) {
  const index = new Map()
  for (const [key, id] of entries ?? []) {
    const slug = normalizeLinkedinSlug(String(key))
    if (slug && !index.has(slug)) index.set(slug, id)
  }
  return index
}

export function urlIdentityMerges(input) { return runSync(urlIdentityMergesSteps(input)) }
export function urlIdentityMergesAsync(input) { return runAsync(urlIdentityMergesSteps(input)) }
function* urlIdentityMergesSteps({ rows, slugIndex, explicit = [] }) {
  const tick = ticker(512)
  const decided = new Set(explicit.map(value => value.profileId))
  const survivorOf = new Map(explicit.filter(value => value.kind === 'merge').map(value => [value.profileId, value.survivorId]))
  const merges = []
  const index = normalizedSlugIndex(slugIndex)
  for (const row of rows) {
    if (tick()) yield
    if (typeof row?.publicId !== 'string' || !row.publicId.startsWith('public-') || decided.has(row.publicId)) continue
    const slug = linkedinSlug(row.subject), legacyId = slug && index.get(slug)
    if (!legacyId) continue
    decided.add(row.publicId)
    merges.push({ id: `url:${row.publicId}`, kind: 'merge', profileId: row.publicId, survivorId: survivorOf.get(legacyId) ?? legacyId })
  }
  return merges
}

// The canonical LinkedIn slug as a private-graph reference value: the Ideaflow
// people overlay names an imported contact `linkedin:in:<sha256 hex of slug>`
// (Noos docs/PEOPLE_OVERLAY.md), so no plaintext address is stored there.
export function linkedinRefHash(slug) {
  if (typeof slug !== 'string' || !slug) return null
  return createHash('sha256').update(slug, 'utf8').digest('hex')
}

// Imported copies of a suspended person (docs/profile-suspension.md): every
// minted `public-<row>` whose LinkedIn address matches a suspension's stored
// address is suspended with it, so a new import cannot re-list the person.
export function urlIdentitySuspensions(input) { return runSync(urlIdentitySuspensionsSteps(input)) }
export function urlIdentitySuspensionsAsync(input) { return runAsync(urlIdentitySuspensionsSteps(input)) }
function* urlIdentitySuspensionsSteps({ rows, explicit = [] }) {
  const tick = ticker(512)
  const refs = new Set(explicit.filter(value => value.kind === 'suspend' && typeof value.linkedinRefHash === 'string').map(value => value.linkedinRefHash))
  const decided = new Set(explicit.filter(value => value.kind === 'suspend').map(value => value.profileId))
  if (!refs.size) return []
  const suspensions = []
  for (const row of rows) {
    if (tick()) yield
    if (typeof row?.publicId !== 'string' || !row.publicId.startsWith('public-') || decided.has(row.publicId)) continue
    const ref = linkedinRefHash(linkedinSlug(row.subject))
    if (!ref || !refs.has(ref)) continue
    decided.add(row.publicId)
    suspensions.push({ id: `suspend-url:${row.publicId}`, kind: 'suspend', profileId: row.publicId })
  }
  return suspensions
}

// One person, one page (docs/profile-handles.md): published profiles that carry
// the same LinkedIn address are the same person, so they fold into one.
// - A member whose address is verified (`absorbers`: it comes from their own
//   uploaded archive or a confirmed recovered account; a URL typed at signup,
//   or a self-asserted claim, is not) absorbs every imported copy of itself,
//   keeping only its own fields (`fill: false`, carried onto earlier merges
//   re-pointed at it). An unverified address absorbs nothing, so typing
//   someone's URL can never take over their page. An address shared by two
//   members is left alone.
// - Copies minted by several imports (`public-<row>`) fold into one survivor:
//   a copy an operator removed (so the person stays removed), else the copy
//   `prefer(ids)` names (the one already holding the address), else the
//   smallest id.
// Copies already merged, members, and any profile another decision names are
// never moved. Same address is the only evidence; names never are. Returns the
// merges plus every earlier merge whose survivor folded away, re-pointed at the
// new survivor so no chain is left.
export function linkedinIdentityMerges(input) { return runSync(linkedinIdentityMergesSteps(input)) }
// The same grouping, giving the event loop a turn between slices (cold builds).
export function linkedinIdentityMergesAsync(input) { return runAsync(linkedinIdentityMergesSteps(input)) }
function* linkedinIdentityMergesSteps({ profiles, members = [], absorbers = members, decisions = [], refFor, prefer = () => null }) {
  const tick = ticker(512)
  const memberSet = new Set(members), absorbing = new Set(absorbers)
  const known = new Set(profiles.map(profile => profile.id))
  const named = new Set(), mergedAway = new Set(), removed = new Set(), survivorOf = new Map()
  for (const decision of decisions) {
    if (typeof decision?.profileId !== 'string') continue
    named.add(decision.profileId)
    if (decision.kind === 'merge' && known.has(decision.profileId) && known.has(decision.survivorId) && !memberSet.has(decision.profileId)) {
      mergedAway.add(decision.profileId)
      survivorOf.set(decision.profileId, decision.survivorId)
    }
    if (decision.kind === 'remove') removed.add(decision.profileId)
  }
  const candidates = profiles.filter(profile => !mergedAway.has(profile.id))
  const parent = new Map(candidates.map(profile => [profile.id, profile.id])), owners = new Map()
  const root = id => { let value = id; while (parent.get(value) !== value) value = parent.get(value); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, value); id = next } return value }
  for (const profile of profiles) {
    if (tick()) yield
    const id = survivorOf.get(profile.id) ?? profile.id
    if (!parent.has(id)) continue
    const value = refFor(profile), refs = Array.isArray(value) ? value : [value]
    for (const ref of new Set(refs.filter(Boolean))) {
      if (!owners.has(ref)) { owners.set(ref, id); continue }
      const a = root(owners.get(ref)), b = root(id)
      if (a !== b) parent.set(b, a)
    }
  }
  const groups = new Map()
  for (const profile of candidates) {
    if (tick()) yield
    const key = root(profile.id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(profile.id)
  }
  const merges = [], survivorFor = new Map(), mergeTargets = new Set(survivorOf.values())
  const fold = (survivorId, ids, extra = {}) => { for (const id of ids) { merges.push({ id: `same-linkedin:${id}`, kind: 'merge', profileId: id, survivorId, ...extra }); survivorFor.set(id, survivorId) } }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    const membersHere = ids.filter(id => memberSet.has(id))
    if (membersHere.length) {
      if (membersHere.length > 1) continue
      if (!absorbing.has(membersHere[0])) continue
      const movable = ids.filter(id => id !== membersHere[0] && !named.has(id))
      if (movable.length) fold(membersHere[0], movable, { fill: false })
      continue
    }
    const professional = id => /^professional-[a-f0-9]{64}$/.test(id)
    const copy = id => id.startsWith('public-') || professional(id)
    const hasProfessional = ids.some(professional)
    if (!ids.every(copy) && !hasProfessional) continue
    const movable = ids.filter(id => !named.has(id)), removedHere = ids.filter(id => removed.has(id)).sort()
    if (removedHere.length) { if (movable.length) fold(removedHere[0], movable); continue }
    const namedHere = ids.filter(id => named.has(id))
    const targetsHere = ids.filter(id => mergeTargets.has(id))
    const protectedHere = namedHere.length ? namedHere : targetsHere
    const anchors = protectedHere.length ? protectedHere : ids.filter(id => !copy(id))
    if (anchors.length && hasProfessional) {
      const eligible = protectedHere.length ? anchors : movable
      const preferred = prefer(eligible)
      const survivorId = eligible.includes(preferred) ? preferred : [...anchors].sort()[0]
      fold(survivorId, movable.filter(id => id !== survivorId))
      continue
    }
    if (movable.length < ids.length || movable.length < 2) continue
    const preferred = prefer(movable)
    const existing = movable.filter(id => !professional(id))
    const survivorId = movable.includes(preferred) ? preferred : (existing.length ? existing : [...movable]).sort()[0]
    fold(survivorId, movable.filter(id => id !== survivorId))
  }
  const keepOwn = new Set(merges.filter(value => value.fill === false).map(value => value.survivorId))
  const rewritten = decisions.map(decision => {
    if (decision?.kind !== 'merge' || !survivorFor.has(decision.survivorId)) return decision
    const survivorId = survivorFor.get(decision.survivorId)
    return { ...decision, survivorId, ...(keepOwn.has(survivorId) ? { fill: false } : {}) }
  })
  return { merges, decisions: rewritten }
}

