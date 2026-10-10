import { linkedinUrl } from '../private-import/archive.mjs'

// Links are professional addresses, never email, phone or contact-card fields.
export const publicLinkedinUrl = value => typeof value === 'string' && value.length <= 2000 ? linkedinUrl(value.trim()) : null
export function linkedinUrlFromSlug(value) {
  if (typeof value !== 'string' || !value || /[/?#\\\s]/.test(value)) return null
  return publicLinkedinUrl(`https://www.linkedin.com/in/${value}`)
}
export function publicWebsite(value) {
  if (typeof value !== 'string' || value.length > 2000) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

// The exact source manifest supplements only people in its live publication.
// Never project account ids, timestamps or any other manifest fields.
export function withLegacyProfileDetails(snapshot, manifest) {
  if (!snapshot || snapshot.revision !== `legacy-public-v1:${manifest?.sourceSha256}`) return snapshot
  const rows = new Map((manifest.profiles ?? []).map(row => [row.legacyId, row]))
  return { ...snapshot, profiles: snapshot.profiles.map(profile => {
    const row = rows.get(profile.id), linkedinUrl = linkedinUrlFromSlug(row?.linkedinSlug)
    return { ...profile, ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(typeof row?.industry === 'string' && row.industry.trim() ? { industry: row.industry } : {}) }
  }) }
}
