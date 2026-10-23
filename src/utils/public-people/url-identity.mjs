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

export function urlIdentityMerges({ rows, slugIndex, explicit = [] }) {
  const decided = new Set(explicit.map(value => value.profileId))
  const survivorOf = new Map(explicit.filter(value => value.kind === 'merge').map(value => [value.profileId, value.survivorId]))
  const merges = []
  const index = normalizedSlugIndex(slugIndex)
  for (const row of rows) {
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
export function urlIdentitySuspensions({ rows, explicit = [] }) {
  const refs = new Set(explicit.filter(value => value.kind === 'suspend' && typeof value.linkedinRefHash === 'string').map(value => value.linkedinRefHash))
  const decided = new Set(explicit.filter(value => value.kind === 'suspend').map(value => value.profileId))
  if (!refs.size) return []
  const suspensions = []
  for (const row of rows) {
    if (typeof row?.publicId !== 'string' || !row.publicId.startsWith('public-') || decided.has(row.publicId)) continue
    const ref = linkedinRefHash(linkedinSlug(row.subject))
    if (!ref || !refs.has(ref)) continue
    decided.add(row.publicId)
    suspensions.push({ id: `suspend-url:${row.publicId}`, kind: 'suspend', profileId: row.publicId })
  }
  return suspensions
}
