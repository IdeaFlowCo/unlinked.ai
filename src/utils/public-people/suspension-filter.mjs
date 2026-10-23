import { parseLinkedinProfileUrl } from '../linkedin-profile-url.mjs'
import { linkedinRefHash, linkedinSlug } from './url-identity.mjs'

// Owner-private rows about a suspended person (docs/profile-suspension.md).
// A row is matched only by stable identity: the published profile id it points
// at, or the SHA-256 of its canonical LinkedIn slug. Names never match.
const refOf = value => {
  if (typeof value !== 'string' || !value) return null
  const slug = parseLinkedinProfileUrl(value)?.slug ?? linkedinSlug(value)
  return slug ? linkedinRefHash(slug) : null
}

export function rowLinkedinRefs(row) {
  return [refOf(row?.subject), refOf(row?.fields?.url), refOf(row?.fields?.URL)].filter(Boolean)
}

// `suppressions`: { ids: Set, refs: Set } or null (nothing suspended).
export function suspendedRow(row, suppressions) {
  if (!suppressions || (!suppressions.ids?.size && !suppressions.refs?.size)) return false
  const target = row?.provenance?.toId ?? row?.publishedProfileId ?? row?.profileId
  if (typeof target === 'string' && suppressions.ids?.has(target)) return true
  return rowLinkedinRefs(row).some(ref => suppressions.refs?.has(ref))
}

export function withoutSuspendedRows(rows, suppressions) {
  return Array.isArray(rows) ? rows.filter(row => !suspendedRow(row, suppressions)) : rows
}
