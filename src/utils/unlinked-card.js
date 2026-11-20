/**
 * Unlinked card QR/link grammar: an exact canonical-host public profile URL,
 * or a member's contact card link (/c/ + 24 alphanumerics, the same token
 * grammar as an OpenChat card).
 */
const WEB_ORIGINS = new Set(['https://www.unlinked.ai', 'https://private.unlinked.ai'])
// The same person-id grammar the browser runtime accepts for /people/ return paths.
const PROFILE_PATH = /^\/people\/([A-Za-z0-9._~%-]{1,480})\/?$/
const MEET_LINK = /^https:\/\/([^/?#]+)(\/m\/[A-Za-z0-9]{24})\?e=([a-z0-9]+(?:-[a-z0-9]+)*)(?:&g=([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}))?$/
export function parseUnlinkedMeetLink(value) {
  if (typeof value !== 'string' || value.length > 240) return null
  const match = MEET_LINK.exec(value.trim())
  if (!match || !WEB_ORIGINS.has('https://' + match[1]) || match[3].length > 45) return null
  return `${match[2]}?e=${match[3]}${match[4] ? '&g=' + match[4] : ''}`
}

const CONTACT_PATH = /^\/c\/([0-9A-Za-z]{24})\/?$/

export function parseUnlinkedCard(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > 600) return null
  // Check the raw authority and path too: URL parsing normalizes empty userinfo,
  // dot segments, and even an empty query or fragment marker.
  const raw = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)(\/[^?#]*)$/.exec(trimmed)
  if (!raw || raw[1].includes('@') || /[?#\\]/.test(trimmed)) return null
  let url
  try { url = new URL(trimmed) } catch { return null }
  if (url.protocol !== 'https:' || !WEB_ORIGINS.has(url.origin) || url.username || url.password) return null
  const contact = CONTACT_PATH.exec(raw[2])?.[1]
  if (contact) return { origin: url.origin, contact }
  const id = PROFILE_PATH.exec(raw[2])?.[1]
  if (!id) return null
  try { decodeURIComponent(id) } catch { return null }
  return { origin: url.origin, id }
}

/** Same-host relative path to the scanned profile, so a scan never changes hosts. */
export function unlinkedProfilePath(card) {
  if (card && WEB_ORIGINS.has(card.origin) && typeof card.contact === 'string' && CONTACT_PATH.test(`/c/${card.contact}`)) return `/c/${card.contact}`
  if (!card || !WEB_ORIGINS.has(card.origin) || typeof card.id !== 'string' || !PROFILE_PATH.test(`/people/${card.id}`)) {
    throw new Error('Invalid Unlinked profile card')
  }
  return `/people/${card.id}`
}
