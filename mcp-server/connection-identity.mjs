import { linkedinRefHash, linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'
import { validTimestamp } from '../src/utils/network-order.mjs'

// Exact-identity evidence for one owner's own connection rows, shared by the
// web /network page, unlinked_lookup_contact and unlinked_list_connections.
// Evidence is only ever a published profile id (the row's own target or the
// published profile with the same LinkedIn address, merges/moves followed by
// the public reader) or the canonical LinkedIn address. Names never are.

export const usableProfileId = id => typeof id === 'string' && id && id.length <= 160 && id !== '.' && id !== '..' ? id : null

// The canonical LinkedIn slug of a connection row, or null.
export const rowSlug = row => linkedinSlug(row?.subject) ?? (typeof row?.fields?.url === 'string' ? linkedinSlug(canonicalLinkedinUrl(row.fields.url)) : null)

// The published profile a row itself names: recorded/invite/connection rows
// carry it, a public-consent import row is published as public-<row id>.
export const rowPublicTarget = row => ['recovered-legacy-public-v1', 'unlinked-invite', 'unlinked-connection'].includes(row?.provenance?.source) && typeof row.provenance.toId === 'string' ? row.provenance.toId
  : typeof row?.id === 'string' && /^[a-f0-9]{64}$/.test(row.id) ? 'public-' + row.id : null

// Each row's candidate published ids: [own target, same-LinkedIn-address profile].
async function candidateIds(rows, { publicTarget = rowPublicTarget, lookupSlug }) {
  return Promise.all(rows.map(async row => {
    const slug = typeof lookupSlug === 'function' ? rowSlug(row) : null
    return [usableProfileId(publicTarget(row)), slug ? usableProfileId(await Promise.resolve(lookupSlug(slug)).catch(() => null)) : null]
  }))
}
// Published summaries for ids, in batches of 1000. Throws when the reader does.
async function lookupAll(ids, lookup) {
  const found = new Map()
  for (let start = 0; start < ids.length; start += 1000) for (const [id, summary] of await lookup(ids.slice(start, start + 1000))) found.set(id, summary)
  return found
}

// The published person each own connection row should link to, or null.
// A row tries its own published person first, then an existing public profile
// with the same LinkedIn address (old shadow profiles, rows of private-consent
// imports). Only people the reader finds are linked, so links never 404.
export async function publishedPeopleFor(rows, { publicTarget = rowPublicTarget, lookupSlug, lookup }) {
  const candidates = await candidateIds(rows, { publicTarget, lookupSlug })
  const found = await lookupAll([...new Set(candidates.flat().filter(Boolean))], lookup)
  return candidates.map(ids => ids.map(id => id && found.get(id)).find(Boolean) ?? null)
}

const PROVENANCE_RANK = { owner_import: 0, recorded_public_path: 1 }
const importedSource = row => !['recovered-legacy-public-v1', 'unlinked-invite', 'unlinked-connection'].includes(row?.provenance?.source)

// Group a owner's connection rows into one person per exact identity
// (unlinked-tto.1). `entries[i]` is the agent entry for `rows[i]` (with
// `provenance.type`). Rows join when they share any published profile id
// (resolved through merges when the reader is available, else as recorded) or
// the LinkedIn ref hash; the relation is transitive. Without a lookup the
// recorded ids still group. Returns groups of row indexes, primary first:
// owner imports before recorded paths, uploaded imports before invite and
// connection rows, the earliest import first, then id. The primary row's id
// is the group's id, so an id stays stable when a later re-import joins.
export async function groupConnectionRows(rows, entries, { lookupSlug, lookup } = {}) {
  const candidates = await candidateIds(rows, { lookupSlug })
  let found = null
  if (typeof lookup === 'function') {
    try { found = await lookupAll([...new Set(candidates.flat().filter(Boolean))], lookup) } catch { found = null }
  }
  const parent = rows.map((_, index) => index)
  const root = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index] } return index }
  const owners = new Map()
  const published = rows.map(() => null)
  rows.forEach((row, index) => {
    const keys = []
    for (const id of candidates[index]) {
      if (!id) continue
      const summary = found?.get(id)
      if (summary && !published[index]) published[index] = summary
      keys.push(`profile:${summary?.id ?? id}`)
    }
    const refHash = linkedinRefHash(rowSlug(row))
    if (refHash) keys.push(`linkedin:${refHash}`)
    for (const key of keys) {
      if (!owners.has(key)) { owners.set(key, index); continue }
      const a = root(owners.get(key)), b = root(index)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  })
  const groups = new Map()
  rows.forEach((_, index) => { const key = root(index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index) })
  const rank = index => [PROVENANCE_RANK[entries[index].provenance?.type] ?? 2, Number(!importedSource(rows[index])), validTimestamp(rows[index].importedAt) ?? 0]
  const order = (a, b) => {
    const left = rank(a), right = rank(b)
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i]
    return entries[a].id < entries[b].id ? -1 : entries[a].id > entries[b].id ? 1 : 0
  }
  return { groups: [...groups.values()].map(indexes => indexes.sort(order)), published }
}
