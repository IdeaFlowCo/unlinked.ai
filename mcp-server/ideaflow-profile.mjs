// Ideaflow universal profile (ideaflow.profile.v1) consumer — interests and "looking for"
// from a member's Ideaflow ideas-network About (social.ideaflow.app), idn-iv6.7 / unlinked-4dig.
//
// The ideas network stays the only writer: its About sections (bullets) are the source, and
// ProfileV1 is a derived read with flat fields plus stable entry ids. This module only reads,
// re-validates and renders; it never stores a copy. Lookups are by the shared Ideaflow owner key
// sha256(issuer + "\n" + subject) and return only what that service shows an anonymous viewer
// (public sections). Showing it on another member's Unlinked page is a cross-app publication
// decision: production composition does not wire `forProfile` yet (see docs in the PR).
import { createHash } from 'node:crypto'

export const IDEAFLOW_ISSUER = 'https://id.ideaflow.app/api/auth'
export const PROFILE_SCHEMA = 'ideaflow.profile.v1'
const LIMITS = Object.freeze({ items: 8, chars: 160, about: 600 })

export const ownerKey = (issuer, subject) => createHash('sha256').update(`${issuer}\n${subject}`).digest('hex')

const clean = (value, max = LIMITS.chars) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
const titles = list => Array.isArray(list) ? [...new Set(list.map(item => clean(typeof item === 'string' ? item : item?.title)).filter(Boolean))].slice(0, LIMITS.items) : []

/** Re-validate a ProfileV1 body; anything unexpected yields null (fail closed). */
export function normalizeProfile(body, { origin } = {}) {
  if (!body || typeof body !== 'object' || body.schema !== PROFILE_SCHEMA || typeof body.handle !== 'string' || !/^[A-Za-z0-9_]{2,32}$/.test(body.handle)) return null
  const interests = titles(body.interests), lookingFor = titles(body.looking_for), offers = titles(body.offers)
  if (!interests.length && !lookingFor.length && !offers.length) return null
  return { handle: body.handle, url: origin ? `${origin}/u/${encodeURIComponent(body.handle)}` : null, interests, lookingFor, offers, about: clean(body.about, LIMITS.about) }
}

/** Client for the ideas network's public ProfileV1 lookup, with a short cache and a hard timeout. */
export function createIdeaflowProfileClient({ origin = 'https://social.ideaflow.app', fetchImpl = globalThis.fetch, timeoutMs = 2500, ttlMs = 300000, now = Date.now, maxEntries = 2000 } = {}) {
  const base = String(origin).replace(/\/$/, '')
  if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(base)) throw new Error('ideaflow_profile_origin_invalid')
  const cache = new Map()
  return {
    async byOwnerKey(key) {
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return null
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      let value = null
      try {
        const res = await fetchImpl(`${base}/api/profiles/by-owner-key/${key}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
        value = res.status === 200 ? normalizeProfile(await res.json(), { origin: base }) : null
      } catch { value = null }
      if (cache.size >= maxEntries) cache.clear()
      cache.set(key, { at: now(), value })
      return value
    },
    async byIdentity({ issuer, subject } = {}) {
      if (issuer !== IDEAFLOW_ISSUER || typeof subject !== 'string' || !subject || subject.length > 512) return null
      return this.byOwnerKey(ownerKey(issuer, subject))
    },
  }
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
/** The person-page card. `self` marks the owner's private preview of their own page. */
export function ideaflowProfileCard(profile, { self = false } = {}) {
  if (!profile) return ''
  const list = (label, items) => items.length ? `<p class="small"><strong>${label}</strong></p><ul class="ideaflow-profile-list">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''
  const source = profile.url ? `<a href="${esc(profile.url)}" rel="noopener">their Ideaflow ideas page</a>` : 'their Ideaflow ideas page'
  return `<div class="card sec ideaflow-profile"><h3>Interests and asks</h3>${list('Interested in', profile.interests)}${list('Looking for', profile.lookingFor)}${list('Can help with', profile.offers)}<p class="small muted">From ${source}${self ? '. Only you see this preview on Unlinked for now.' : '.'}</p></div>`
}
