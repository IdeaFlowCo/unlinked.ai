// Member handles (unlinked-qpud): the readable segment of a member's public
// address, /people/<handle>. Internal profile ids never change; a handle is
// only an address for one, so connections, requests and notifications keep
// using ids while every emitted link prefers the handle. docs/profile-handles.md.
import { linkedinSlug } from './url-identity.mjs'

export const HANDLE_LIMITS = Object.freeze({ min: 3, max: 60, perProfile: 10 })
const GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
// Words that name pages or would read as official. /people/add and
// /people/lookup are real routes; the rest keep addresses unambiguous.
export const RESERVED_HANDLES = new Set(['add', 'lookup', 'search', 'api', 'admin', 'administrator', 'root', 'system', 'settings', 'profile', 'me', 'my',
  'help', 'support', 'about', 'privacy', 'terms', 'security', 'legal', 'login', 'logout', 'signin', 'signout', 'signup', 'join', 'register',
  'people', 'person', 'network', 'messages', 'card', 'scan', 'meet', 'connections', 'removal', 'report', 'block', 'photo', 'edit', 'new',
  'invites', 'invitations', 'notifications', 'import', 'export', 'agents', 'oauth', 'mcp', 'companies', 'company', 'home', 'index',
  'unlinked', 'unlinkedai', 'ideaflow', 'official', 'staff', 'team', 'moderator', 'www', 'mail', 'null', 'undefined', 'anonymous'])

// Shapes that are, or look like, internal profile ids: those addresses must
// always keep meaning the id they already name.
const ID_SHAPED = [/^[0-9a-f]{8}-[0-9a-f]{4}-/, /^(?:public|member|legacy|shadow|test)-/, /^[0-9a-f]{32,}$/]

export function normalizeHandleInput(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : ''
}

// { handle } for a usable handle, else { code }: length, invalid or reserved.
export function validateHandle(value) {
  const handle = normalizeHandleInput(value)
  if (handle.length < HANDLE_LIMITS.min || handle.length > HANDLE_LIMITS.max) return { code: 'length' }
  if (!GRAMMAR.test(handle) || handle.includes('--')) return { code: 'invalid' }
  if (RESERVED_HANDLES.has(handle) || ID_SHAPED.some(pattern => pattern.test(handle))) return { code: 'reserved' }
  return { handle }
}

export const isHandle = value => typeof value === 'string' && validateHandle(value).handle === value

// A readable base from a display name: accents folded, words joined by '-'.
export function nameHandleBase(name) {
  const base = (typeof name === 'string' ? name : '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return base || 'someone'
}

// Default handles in preference order: the LinkedIn vanity slug already shown
// on the public profile, then the name, then the name with a number.
export function handleCandidates({ name, linkedinUrl } = {}) {
  const candidates = []
  const slug = linkedinSlug(linkedinUrl)
  if (slug && validateHandle(slug).handle === slug) candidates.push(slug)
  const base = nameHandleBase(name)
  if (validateHandle(base).handle === base) candidates.push(base)
  for (let n = 2; n <= 60; n++) { const value = `${base}-${n}`; if (validateHandle(value).handle === value) candidates.push(value) }
  return [...new Set(candidates)]
}

// The public path for a profile id. The composition registers the live handle
// lookup once at startup; until then (and in tests that do not), paths use ids.
let lookupHandle = () => null
export function setProfileHandleLookup(lookup) { lookupHandle = typeof lookup === 'function' ? lookup : () => null }
export function profileSegment(id) {
  let handle = null
  try { handle = typeof id === 'string' ? lookupHandle(id) : null } catch { handle = null }
  return typeof handle === 'string' && isHandle(handle) ? handle : id
}
export const profilePath = id => `/people/${encodeURIComponent(profileSegment(id))}`
