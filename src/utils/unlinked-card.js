/** Unlinked profile QR/link grammar: an exact canonical-host public profile URL. */
const WEB_ORIGINS = new Set(['https://www.unlinked.ai', 'https://private.unlinked.ai'])
// The same person-id grammar the browser runtime accepts for /people/ return paths.
const PROFILE_PATH = /^\/people\/([A-Za-z0-9._~%-]{1,480})\/?$/

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
  const id = PROFILE_PATH.exec(raw[2])?.[1]
  if (!id) return null
  try { decodeURIComponent(id) } catch { return null }
  return { origin: url.origin, id }
}

/** Same-host relative path to the scanned profile, so a scan never changes hosts. */
export function unlinkedProfilePath(card) {
  if (!card || !WEB_ORIGINS.has(card.origin) || typeof card.id !== 'string' || !PROFILE_PATH.test(`/people/${card.id}`)) {
    throw new Error('Invalid Unlinked profile card')
  }
  return `/people/${card.id}`
}
