/** The OpenChat card route and token grammar are defined by its AddMe card API. */
const TOKEN = /^[0-9A-Za-z]{24}$/
const WEB_ORIGIN = 'https://chat.globalbr.ai'

export function parseOpenChatCard(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > 256) return null

  let url
  try { url = new URL(trimmed) } catch { return null }
  if (url.search || url.hash || url.username || url.password) return null

  let token = null
  if (url.origin === WEB_ORIGIN) {
    token = /^\/c\/([0-9A-Za-z]{24})\/?$/.exec(url.pathname)?.[1] ?? null
  } else if (url.protocol === 'openchat:' && url.hostname === 'card' && !url.port) {
    token = /^\/([0-9A-Za-z]{24})\/?$/.exec(url.pathname)?.[1] ?? null
  }
  return token && TOKEN.test(token) ? token : null
}

export function openChatCardUrl(token) {
  if (!TOKEN.test(token)) throw new Error('Invalid OpenChat card token')
  return `${WEB_ORIGIN}/c/${token}`
}
