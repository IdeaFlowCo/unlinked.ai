/** The OpenChat card route and token grammar are defined by its AddMe card API. */
const TOKEN = /^[0-9A-Za-z]{24}$/
const WEB_ORIGINS = new Set(['https://chat.globalbr.ai', 'https://chat.ideaflow.app'])
const CARD_PATH = /^\/c\/([0-9A-Za-z]{24})\/?$/

export function parseOpenChatCard(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > 256) return null

  // Check the raw authority and path too: URL parsing normalizes empty userinfo,
  // dot segments, and even an empty query or fragment marker.
  const raw = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)(\/[^?#]*)$/.exec(trimmed)
  if (!raw || raw[1].includes('@') || /[?#]/.test(trimmed)) return null
  let url
  try { url = new URL(trimmed) } catch { return null }
  if (url.protocol !== 'https:' || !WEB_ORIGINS.has(url.origin) || url.username || url.password) return null
  const token = CARD_PATH.exec(raw[2])?.[1]
  return token ? { origin: url.origin, token } : null
}

export function openChatCardUrl(card) {
  if (!card || !WEB_ORIGINS.has(card.origin) || typeof card.token !== 'string' || !TOKEN.test(card.token)) {
    throw new Error('Invalid OpenChat card')
  }
  return `${card.origin}/c/${card.token}`
}
