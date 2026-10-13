// Shared by the browser QR classifier and server lookup. Never follow redirects
// or accept another origin's embedded LinkedIn URL.
export function parseLinkedinProfileUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const input = value.trim(), url = new URL(/^https:\/\//i.test(input) ? input : `https://${input}`)
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) return null
    const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname)
    if (!match) return null
    const slug = decodeURIComponent(match[1]).toLowerCase()
    if (!/^[\p{L}\p{N}_.-]{1,120}$/u.test(slug)) return null
    return { slug, url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}` }
  } catch { return null }
}
