import { PHOTO_URL } from './profile-photos.mjs'

// Link previews (docs/link-previews.md): the Open Graph / Twitter card head a
// shared Unlinked link unfurls into in iMessage, Slack, WhatsApp and friends.
//
// Only a view that says what it is (`view.preview`) gets a specific preview,
// and only public pages set one: the home page, the static public guides,
// company pages and a published profile read without a session. Everything
// else, including every signed-in, contact, private-context and error page,
// gets the neutral site preview, so an unfurl can never carry a private name
// or note even when the tab title is specific.

export const SITE_PREVIEW = Object.freeze({ title: 'Unlinked', description: 'Your professional profile and network, in a place that’s yours.', image: '/app-icon-512.png' })
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const text = (value, max) => {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('').trimEnd()}…` : flat
}
// Same-origin paths only: an image or address is never taken from a URL a
// profile row or request supplied.
const localPath = value => typeof value === 'string' && /^\/(?!\/)[^\s\\]*$/.test(value) ? value : null
const absolute = (origin, path) => { try { return path ? new URL(path, origin).href : null } catch { return null } }

// The <meta> tags for a page head. `origin` is the runtime's public origin.
export function previewMeta(preview, origin) {
  const specific = preview && typeof preview === 'object' && text(preview.title, 120)
  const title = specific || SITE_PREVIEW.title
  const description = (specific && text(preview.description, 300)) || SITE_PREVIEW.description
  const image = absolute(origin, (specific && localPath(preview.image)) || SITE_PREVIEW.image)
  const url = specific ? absolute(origin, localPath(preview.url)) : null
  const type = specific && preview.type === 'profile' ? 'profile' : 'website'
  const tags = [
    ['name', 'description', description],
    ['property', 'og:site_name', 'Unlinked'],
    ['property', 'og:type', type],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ...(image ? [['property', 'og:image', image]] : []),
    ...(url ? [['property', 'og:url', url]] : []),
    ['name', 'twitter:card', 'summary'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
    ...(image ? [['name', 'twitter:image', image]] : []),
  ]
  return tags.map(([key, name, value]) => `<meta ${key}="${name}" content="${escape(value)}">`).join('') + (url ? `<link rel="canonical" href="${escape(url)}">` : '')
}

// A published profile's preview: its name, then its headline (or current
// role) and location. Only fields the public profile page itself shows are
// read; the photo only in the exact same-origin grammar the page uses.
export function personPreview(profile, path) {
  if (!profile || typeof profile !== 'object' || !text(profile.name, 120)) return null
  const current = Array.isArray(profile.positions) ? profile.positions.find(position => position && (position.title || position.company)) : null
  const role = text(profile.headline, 200) || [text(current?.title, 100), text(current?.company, 100)].filter(Boolean).join(' at ')
  const description = [role, text(profile.location, 100)].filter(Boolean).join(' · ') || 'Professional profile on Unlinked.'
  return { type: 'profile', title: text(profile.name, 120), description, image: typeof profile.photo === 'string' && PHOTO_URL.test(profile.photo) ? profile.photo : null, url: path }
}

// Known link-unfurl fetchers: they read one page head when someone shares a
// link. iMessage sends "facebookexternalhit/1.1 Facebot Twitterbot/1.0".
// SEO and AI crawlers (Semrush, ShapBot, DataForSeo, GPTBot, …) are NOT here:
// they stay on the shared anonymous fuse (public-read-admission.mjs).
const UNFURLERS = /facebookexternalhit\/|\bFacebot\b|\bTwitterbot\/|Slackbot-LinkExpanding|\bDiscordbot\/|\bLinkedInBot\/|\bWhatsApp\/|\bTelegramBot\b|SkypeUriPreview|\bMastodon\//
export const linkUnfurler = request => {
  const agent = request?.headers?.['user-agent']
  return typeof agent === 'string' && agent.length <= 512 && UNFURLERS.test(agent)
}

// A small budget of its own for unfurlers, so a shared profile link previews
// even while SEO crawlers hold the shared anonymous fuse. Any client can claim
// an unfurler's user agent, so the lane is bounded per visitor and overall,
// holds at most `inFlight` reads, never queues, and serves only the cheap
// meta-only page. Over budget, the request simply continues on the ordinary
// shared fuse, exactly as before this lane existed.
export function createLinkPreviewAdmission({ now = Date.now, perMinute = 60, visitorPerMinute = 10, inFlight = 2, maxVisitors = 5000, record = () => {} } = {}) {
  const visitors = new Map()
  let window = now(), requests = 0, busy = 0
  const result = (reason, release) => {
    try { record({ lane: 'preview', route: 'profile', reason }) } catch { /* Diagnostics never gate reads. */ }
    return { reason, release }
  }
  return {
    acquire({ visitor } = {}) {
      const time = now()
      if (time - window >= 60000) { window = time; requests = 0 }
      if (requests >= perMinute) return result('minute')
      if (visitor) {
        let value = visitors.get(visitor)
        if (!value || time - value.window >= 60000) {
          if (!value && visitors.size >= maxVisitors) {
            for (const [key, entry] of visitors) if (time - entry.window >= 60000) visitors.delete(key)
            if (visitors.size >= maxVisitors) return result('capacity')
          }
          value = { window: time, requests: 0 }; visitors.set(visitor, value)
        }
        if (value.requests >= visitorPerMinute) return result('minute')
      }
      if (busy >= inFlight) return result('capacity')
      if (visitor) visitors.get(visitor).requests++
      requests++; busy++
      let released = false
      return result('admitted', () => { if (!released) { released = true; busy-- } })
    },
  }
}

// The whole page an unfurler receives: the preview head and a plain summary.
export function previewDocument(preview, origin) {
  const title = text(preview?.title, 120) || SITE_PREVIEW.title
  const url = absolute(origin, localPath(preview?.url))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Unlinked</title>${previewMeta(preview, origin)}</head><body><h1>${escape(title)}</h1>${preview?.description ? `<p>${escape(text(preview.description, 300))}</p>` : ''}${url ? `<p><a href="${escape(url)}">View on Unlinked</a></p>` : ''}</body></html>`
}
