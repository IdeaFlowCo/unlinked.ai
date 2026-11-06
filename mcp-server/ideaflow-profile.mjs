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

// ---- Owner control: whether a member's Ideaflow interests/asks appear on their Unlinked profile ----
// Default (no record) is 'shown': the section appears collapsed, opened by a second click. A member can
// hide it; the choice is theirs alone and goes with the account. Collapsed is not private: the source
// is the member's own public About on the ideas network (public sections only; unlisted and
// signed-in-only bullets never reach this lookup).
export const IDEAFLOW_PROFILE_VISIBILITY = Object.freeze(['shown', 'hidden'])
const validOwner = owner => typeof owner?.ownerId === 'string' && owner.ownerId && typeof owner.userId === 'string' && owner.userId

export function createMemoryIdeaflowProfileChoices({ now = Date.now } = {}) {
  const records = new Map()
  return {
    async initialize() {},
    async get(owner) { if (!validOwner(owner)) return 'shown'; const v = records.get(owner.ownerId); return v && v.userId === owner.userId ? v.visibility : 'shown' },
    async set(owner, visibility) {
      if (!validOwner(owner)) throw new Error('ideaflow_profile_owner_required')
      if (!IDEAFLOW_PROFILE_VISIBILITY.includes(visibility)) throw new Error('ideaflow_profile_visibility_invalid')
      records.set(owner.ownerId, { userId: owner.userId, visibility, updatedAt: now() }); return visibility
    },
    async removeOwner(owner) { if (validOwner(owner)) records.delete(owner.ownerId) },
  }
}

export function createNeo4jIdeaflowProfileChoices(driver, database = 'neo4j', { now = Date.now } = {}) {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      await run('CREATE CONSTRAINT unlinked_ideaflow_profile_choice_owner IF NOT EXISTS FOR (p:UnlinkedIdeaflowProfileChoice) REQUIRE p.ownerId IS UNIQUE', {})
    },
    async get(owner) {
      if (!validOwner(owner)) return 'shown'
      const result = await run('MATCH (p:UnlinkedIdeaflowProfileChoice {ownerId: $ownerId}) WHERE p.userId = $userId RETURN p.visibility AS visibility LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ')
      const v = result.records[0]?.get('visibility')
      return IDEAFLOW_PROFILE_VISIBILITY.includes(v) ? v : 'shown'
    },
    async set(owner, visibility) {
      if (!validOwner(owner)) throw new Error('ideaflow_profile_owner_required')
      if (!IDEAFLOW_PROFILE_VISIBILITY.includes(visibility)) throw new Error('ideaflow_profile_visibility_invalid')
      await run('MERGE (p:UnlinkedIdeaflowProfileChoice {ownerId: $ownerId}) SET p.userId = $userId, p.visibility = $visibility, p.updatedAt = $updatedAt', { ownerId: owner.ownerId, userId: owner.userId, visibility, updatedAt: now() })
      return visibility
    },
    async removeOwner(owner) {
      if (!validOwner(owner)) return
      await run('MATCH (p:UnlinkedIdeaflowProfileChoice {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
    },
  }
}

/**
 * Provider for the person page. Resolves a published profile to its member account and that account
 * to its one verified Ideaflow identity (no names, emails or guesses), then reads ProfileV1.
 */
export function createIdeaflowProfileProvider({ client, accountForProfile, identityForOwner, choices }) {
  if (!client?.byIdentity || typeof accountForProfile !== 'function' || typeof identityForOwner !== 'function' || !choices?.get || !choices?.set) throw new Error('ideaflow_profile_provider_configuration_required')
  return {
    publicCards: true,
    choices,
    async forProfile(profileId, { self = false } = {}) {
      const owner = await accountForProfile(profileId)
      if (!owner) return null
      const visibility = await choices.get(owner)
      if (!self && visibility !== 'shown') return null
      const identity = await identityForOwner(owner)
      if (!identity || identity.issuer !== IDEAFLOW_ISSUER) return null
      const profile = await client.byIdentity(identity)
      return profile ? { ...profile, visibility } : (self ? { empty: true, visibility } : null)
    },
  }
}

/** Collapsed "second click" section for viewers; the owner gets the open preview plus the control. */
export function ideaflowProfileSection(profile, { self = false, csrf = '', action = '/profile/ideaflow' } = {}) {
  if (!profile) return ''
  const list = (label, items) => items?.length ? `<p class="small"><strong>${label}</strong></p><ul class="ideaflow-profile-list">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''
  const body = profile.empty
    ? `<p class="small">Nothing public yet. Add Interests, Looking for or Can help with sections to <a href="https://social.ideaflow.app/" rel="noopener">your Ideaflow ideas page</a> and they can appear here.</p>`
    : `${list('Interested in', profile.interests)}${list('Looking for', profile.lookingFor)}${list('Can help with', profile.offers)}<p class="small muted">From ${profile.url ? `<a href="${esc(profile.url)}" rel="noopener">their Ideaflow ideas page</a>` : 'their Ideaflow ideas page'} (public sections only).</p>`
  if (!self) return `<details class="card sec ideaflow-profile"><summary><h3 style="display:inline">Interests and asks</h3></summary>${body}</details>`
  const shown = profile.visibility !== 'hidden'
  const control = `<form method="post" action="${esc(action)}" class="actions">${csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : ''}<input type="hidden" name="visibility" value="${shown ? 'hidden' : 'shown'}"><button class="quiet sm" type="submit">${shown ? 'Hide from my profile' : 'Show on my profile'}</button></form>`
  const status = shown ? 'Shown on your profile, collapsed: visitors open it with a click.' : 'Hidden from your profile. Only you see this.'
  return `<details class="card sec ideaflow-profile" open><summary><h3 style="display:inline">Interests and asks</h3></summary>${body}<p class="small">${status}</p>${control}</details>`
}
