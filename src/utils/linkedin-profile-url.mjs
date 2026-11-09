// Shared by the browser QR classifier and server lookup. Never follow redirects
// or accept another origin's embedded LinkedIn URL.
//
// Pasted addresses arrive with all kinds of junk, so this accepts anything that
// still names exactly one profile on a LinkedIn host: tracking queries and
// fragments, trailing sub-pages (/details/experience, /overlay/contact-info,
// /recent-activity/all, locale suffixes), http://, country and mobile
// subdomains, wrapping quotes or brackets, trailing punctuation, invisible
// characters, and surrounding words ("My LinkedIn: https://... thanks").
// Every candidate is still parsed as a whole URL whose host must be LinkedIn,
// and a LinkedIn URL nested inside another site's URL fails the whole input.
//
// Self-contained and ASCII-only on purpose: omni-search and the network filter
// serialize this function with toString() into inline browser scripts.
export function parseLinkedinProfileUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  const invisible = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g
  const parse = candidate => {
    try {
      const input = candidate.replace(invisible, '').trim()
        .replace(/^[\s"'\x60<([{\u00AB\u201C\u2018]+/, '')
        .replace(/[\s"'\x60>)\]}\u00BB\u201D\u2019.,;:!?\u2026]+$/, '')
      if (!input) return null
      const url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
      if (!/^(?:(?:www|m|mobile|[a-z]{2})\.)?linkedin\.com$/.test(url.hostname)) return null
      const match = /^\/+in\/+([^/]+)(?:\/.*)?$/i.exec(url.pathname)
      if (!match) return null
      const slug = decodeURIComponent(match[1].replace(/;.*$/, '')).replace(invisible, '').trim().toLowerCase()
      // Exported slugs may include tilde, registered signs and emoji. Other
      // symbols (including URL delimiters) remain outside the allowlist.
      if (!/^[\p{L}\p{N}\p{So}_.~-]{1,120}$/u.test(slug)) return null
      return { slug, url: 'https://www.linkedin.com/in/' + encodeURIComponent(slug) }
    } catch { return null }
  }
  const whole = parse(value)
  if (whole) return whole
  // Surrounding words or repeated pastes: every fragment that mentions a
  // LinkedIn profile path must parse on its own, and all must agree.
  const fragments = value.split(/[\s<>()[\]{}"'\x60|,]+/).filter(part => /linkedin\.com\/+in\//i.test(part))
  const found = fragments.map(parse)
  return found.length && found.every(item => item && item.slug === found[0].slug) ? found[0] : null
}
