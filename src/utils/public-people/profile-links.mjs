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

// Member-published profile links (unlinked-8dm): a short list of professional
// addresses a member chooses to show on their own public profile. Only
// credential-free HTTPS addresses pass; LinkedIn keeps its person grammar.
// Contact-card fields, email and phone never travel through here.
export const SOCIAL_LINK_LIMITS = Object.freeze({ maxLinks: 6, maxLength: 300 })
const SOCIAL_HOSTS = Object.freeze([
  [host => host === 'x.com' || host === 'twitter.com', 'x', 'X'],
  [host => host === 'substack.com' || host.endsWith('.substack.com'), 'substack', 'Substack'],
  [host => host === 'github.com', 'github', 'GitHub'],
  [host => host === 'bsky.app', 'bluesky', 'Bluesky'],
  [host => host === 'youtube.com' || host === 'youtu.be', 'youtube', 'YouTube'],
  [host => host === 'instagram.com', 'instagram', 'Instagram'],
])
// One pasted address → { kind, label, url } or null. A bare "x.com/me" gets
// https://; http: upgrades; any other scheme (javascript:, mailto:, …) fails.
export function classifySocialLink(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > SOCIAL_LINK_LIMITS.maxLength) return null
  const address = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text.replace(/^http:\/\//i, 'https://') : `https://${text}`
  let url
  try { url = new URL(address) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.href.length > SOCIAL_LINK_LIMITS.maxLength) return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const linkedin = publicLinkedinUrl(url.href)
    return linkedin ? { kind: 'linkedin', label: 'LinkedIn', url: linkedin } : null
  }
  for (const [match, kind, label] of SOCIAL_HOSTS) if (match(host)) return { kind, label, url: url.href }
  const label = `${host}${url.pathname === '/' ? '' : url.pathname}`
  return { kind: 'website', label: label.length > 40 ? `${label.slice(0, 39)}…` : label, url: url.href }
}
// A member's list: classified, deduplicated by address, bounded. `problems`
// holds the 0-based indexes of entries that did not classify.
export function normalizeSocialLinks(values) {
  const links = [], problems = [], seen = new Set()
  for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
    const link = classifySocialLink(typeof value === 'string' ? value : value?.url)
    if (!link) { problems.push(index); continue }
    if (seen.has(link.url)) continue
    seen.add(link.url)
    links.push(link)
  }
  if (links.length > SOCIAL_LINK_LIMITS.maxLinks) return { links: [], problems: [], overLimit: true }
  return { links, problems, overLimit: false }
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
