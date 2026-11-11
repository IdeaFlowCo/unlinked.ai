import { peopleFilters, matchesPeopleFilters, connectionDegrees } from './search-filters.mjs'
import { publicLinkedinUrl, publicWebsite } from './profile-links.mjs'
import { parseLinkedinProfileUrl } from '../linkedin-profile-url.mjs'
import { createHash } from 'node:crypto'
import { PUBLIC_INDEX_MAX_CONNECTIONS, PUBLIC_INDEX_MAX_PROFILES, PUBLIC_INDEX_MAX_TEXT_BYTES } from './limits.mjs'
import { PUBLIC_LIST_SORTS, orderNetwork } from '../network-order.mjs'
import { profileDetailLevel } from './detail-level.mjs'
import { PROFILE_DECISION_LIMIT } from './profile-decisions.mjs'
import { SEARCH_MODES, companyPageName, createQueryMatcher, rankMatches, words } from './text-match.mjs'
import { buildSuggestIndex, suggestCompanies, suggestPeople } from './suggest-index.mjs'
import { listedFor, unlistedProfiles, UNLISTED_GROUP } from './unlisted.mjs'
import { connectionPolicies, createConnectionVisibility } from './connection-privacy.mjs'
import { activePublicIndexHost } from './index-host.mjs'
import { reportIndexError } from './error-report.mjs'

export class PublicPeopleReaderError extends Error {
  // `reason` (optional) is a fixed diagnostic value, e.g. build_timeout, aborted, stale, worker_timeout.
  constructor(status, code, reason) { super(code); this.name = 'PublicPeopleReaderError'; this.status = status; this.code = code; if (reason) this.reason = reason }
}
const unavailable = () => { throw new PublicPeopleReaderError(503, 'public_people_unavailable') }
const invalid = () => { throw new PublicPeopleReaderError(400, 'public_people_input_invalid') }
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value !== '.' && value !== '..'
const revisionValid = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && [...value].every(character => character.charCodeAt(0) <= 127)
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const hash = value => createHash('sha256').update(value).digest('hex')
// Same grammar as PHOTO_URL in mcp-server/profile-photos.mjs: only a same-origin photo path.
const SUGGESTED_PEOPLE = 5
// Faces on a profile header's mutual connections line.
const MUTUAL_PREVIEW = 3
const PHOTO_URL = /^\/people\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|member-(?:signup|import)-[a-f0-9]{64})\/photo\?v=[a-f0-9]{16}$/

const dense = value => {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
  }
  return true
}
// A provider returns the same kept snapshot to every call; its profile and
// edge arrays (100k+ entries) were walked for holes and accessors on each one
// (up to ~80 ms per call on the production host). An array already found
// dense at its current length is not walked again.
const denseChecked = new WeakMap()
const denseOnce = value => {
  if (Array.isArray(value) && denseChecked.get(value) === value.length) return true
  const ok = dense(value)
  if (ok) denseChecked.set(value, value.length)
  return ok
}
const immutableIdentity = (value, ancestors = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if ((!plain(value) && !dense(value)) || !Object.isFrozen(value) || ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && Object.hasOwn(descriptor, 'value') && immutableIdentity(descriptor.value, ancestors)
  })
  ancestors.delete(value)
  return valid
}
// member: confirmed current account; legacy: recovered account awaiting claim; shadow: imported contact.
export const ENRICHMENT_STATUS = Object.freeze(['enriched', 'not_recorded', 'unknown'])
export const PRESENCE = Object.freeze(['member', 'legacy', 'shadow'])
const requestValue = value => {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid()
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) invalid()
  return value
}

// The injected provider owns public projection and both-endpoint visibility.
// No reader exists by default; private records and fixtures are never fallback sources.
// `reuse: true` keeps the first successful snapshot for this reader's whole
// life. Use it only for a reader made for one request, so a page that reads
// the index several times builds it once and sees one consistent revision.
// Compiled reader state (maps, search tokens, adjacency) per snapshot source.
// Kept only for sources whose revision string identifies the content
// (`revisionIdentifiesContent`), so an unchanged revision skips the rebuild
// while any change to the publication yields a new revision and a new build.
const compiled = new WeakMap()
// One autocomplete prefix index per compiled snapshot, shared by every reader.
const suggestIndexes = new WeakMap()
const suggestIndexFor = data => { let index = suggestIndexes.get(data); if (!index) suggestIndexes.set(data, index = buildSuggestIndex(data)); return index }
const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  if (!(value instanceof Map) && !(value instanceof Set)) for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

// `photoFor(id)` optionally names a same-origin profile photo URL
// (mcp-server/profile-photos.mjs); summaries and details then carry `photo`.
// `suggestFreshMs` / `suggestStaleMs` (default 0: every suggestion checks the
// source) let `suggest` reuse the last verified index: as-is while younger than
// the fresh window, and while younger than the stale bound with one background
// refresh. A failed refresh drops it, so a revoked publication fails closed.
export function createPublicPeopleReader({ readPublishedSnapshot, viewer = null, pageSize = 50, maxProfiles = PUBLIC_INDEX_MAX_PROFILES, maxConnections = PUBLIC_INDEX_MAX_CONNECTIONS, maxTextBytes = PUBLIC_INDEX_MAX_TEXT_BYTES, timeoutMs = 8000, reuse = false, photoFor, suggestFreshMs = 0, suggestStaleMs = 0, now = Date.now } = {}) {
  if ((readPublishedSnapshot !== undefined && typeof readPublishedSnapshot !== 'function') || (photoFor !== undefined && typeof photoFor !== 'function') || !bounded(pageSize, 100) || !bounded(maxProfiles, PUBLIC_INDEX_MAX_PROFILES) || !bounded(maxConnections, PUBLIC_INDEX_MAX_CONNECTIONS) || !bounded(maxTextBytes, PUBLIC_INDEX_MAX_TEXT_BYTES) || !bounded(timeoutMs, 30000) || (viewer !== null && (!plain(viewer) || !immutableIdentity(viewer))) || typeof reuse !== 'boolean' || !Number.isSafeInteger(suggestFreshMs) || suggestFreshMs < 0 || !Number.isSafeInteger(suggestStaleMs) || suggestStaleMs < suggestFreshMs || suggestStaleMs > 300000 || typeof now !== 'function') throw new TypeError('public_people_configuration_invalid')

  // Reads that overlap share one build: a page may read the snapshot twice at
  // once, and building it is slow. With the default `reuse: false`, each new
  // read checks the source before reusing any compiled public index. A
  // caller's own signal reads alone unless request-scoped reuse is enabled.
  let inflight = null, kept = null, latest = null, exportPlan = null
  async function snapshot(signal) {
    if (signal?.aborted) unavailable()
    if (kept) return kept
    if (signal && !reuse) return build(signal).then(value => { hold(value); return value })
    if (!inflight) inflight = build(signal).then(value => { if (reuse) kept = value; hold(value); return value }, error => { latest = null; throw error }).finally(() => { inflight = null })
    if (!signal) return inflight
    return new Promise((resolve, reject) => {
      const abort = () => reject(new PublicPeopleReaderError(503, 'public_people_unavailable'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      inflight.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  // A suggesting reader prepares the autocomplete index for each new snapshot
  // off the request path, so no keystroke waits for it.
  const hold = value => {
    latest = { data: value, at: now() }
    if (suggestStaleMs > 0 && !value.remote && !suggestIndexes.has(value)) setImmediate(() => { try { suggestIndexFor(value) } catch { /* built on demand instead */ } })
  }
  const age = () => latest ? now() - latest.at : Infinity
  const refresh = () => { if (!inflight) snapshot().catch(() => {}) }
  // Suggestions: the last verified index while recent, else a fresh read.
  async function recent(signal) {
    const held = latest, elapsed = age()
    if (held && elapsed < suggestFreshMs) return held.data
    if (held && elapsed < suggestStaleMs) { refresh(); return held.data }
    return snapshot(signal)
  }
  async function build(signal) {
    if (!readPublishedSnapshot) unavailable()
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let timer, abortHandler
    try {
      const interruption = new Promise((_, reject) => {
        abortHandler = () => reject(new PublicPeopleReaderError(503, 'public_people_unavailable', controller.signal.aborted && !signal?.aborted ? 'build_timeout' : 'aborted'))
        combined.addEventListener('abort', abortHandler, { once: true })
        timer = setTimeout(() => controller.abort(), timeoutMs)
        if (combined.aborted) abortHandler()
      })
      const value = await Promise.race([Promise.resolve().then(() => readPublishedSnapshot({ maxProfiles, maxConnections, maxTextBytes, signal: combined, viewer })), interruption])
      if (!plain(value) || value.state !== 'published' || value.complete !== true || !revisionValid(value.revision) || !Array.isArray(value.profiles) || value.profiles.length > maxProfiles || !denseOnce(value.profiles) || !Array.isArray(value.connections) || value.connections.length > maxConnections || !denseOnce(value.connections)) unavailable()
      // A wrapper that only observes the source names it (`compiledSource`), so
      // its readers share the source's compiled index instead of rebuilding it.
      const source = typeof readPublishedSnapshot.compiledSource === 'function' ? readPublishedSnapshot.compiledSource : readPublishedSnapshot
      const cacheable = viewer === null && source.revisionIdentifiesContent === true && plain(value) && revisionValid(value.revision)
      const cacheKey = cacheable ? [value.revision, maxProfiles, maxConnections, maxTextBytes].join('\u0000') : null
      // With an index host (index-host.mjs) a worker compiles and keeps the
      // index; this reader keeps only a descriptor and sends it each call.
      const host = cacheable ? activePublicIndexHost() : null
      if (host?.available()) {
        const sourceKey = host.sourceKey(source)
        await host.ensure(sourceKey, cacheKey, value, { maxProfiles, maxConnections, maxTextBytes })
        return { remote: { host, sourceKey, cacheKey }, revision: value.revision }
      }
      if (cacheable && compiled.get(source)?.key === cacheKey) return compiled.get(source).data
      let textBytes = 0
      const text = (input, required = false, nonempty = false) => {
        if (input === undefined && !required) return undefined
        if (typeof input !== 'string' || input.length > 20000 || (nonempty && !input.trim())) unavailable()
        textBytes += Buffer.byteLength(input)
        if (textBytes > maxTextBytes) unavailable()
        return input
      }
      const optional = (output, key, input) => { const result = text(input); if (result !== undefined) output[key] = result }
      const array = (input, max) => { if (!Array.isArray(input) || input.length > max || !dense(input)) unavailable(); return input }
      const summaries = new Map(), details = new Map(), tokens = new Map()
      for (const input of value.profiles) {
        if (!plain(input) || !idValid(input.id) || summaries.has(input.id)) unavailable()
        const summary = { id: input.id, name: text(input.name, true, true) }
        optional(summary, 'headline', input.headline); optional(summary, 'location', input.location)
        const detail = { ...summary }
        optional(detail, 'about', input.about)
        for (const key of ['company', 'industry']) optional(detail, key, input[key])
        const linkedinUrl = publicLinkedinUrl(input.linkedinUrl), website = publicWebsite(input.website)
        if (linkedinUrl) optional(detail, 'linkedinUrl', linkedinUrl)
        if (website) optional(detail, 'website', website)
        detail.positions = array(input.positions, 100).map(position => {
          if (!plain(position)) unavailable()
          const result = { title: text(position.title, true), company: text(position.company, true) }
          for (const key of ['startDate', 'endDate', 'description']) optional(result, key, position[key])
          return result
        })
        detail.education = array(input.education, 100).map(education => {
          if (!plain(education)) unavailable()
          const result = { institution: text(education.institution, true) }
          for (const key of ['degree', 'startDate', 'endDate']) optional(result, key, education[key])
          return result
        })
        detail.skills = array(input.skills, 500).map(skill => text(skill, true))
        const company = text(input.company)
        summary.detailLevel = profileDetailLevel(detail)
        detail.detailLevel = summary.detailLevel
        if (input.enrichmentStatus !== undefined && !ENRICHMENT_STATUS.includes(input.enrichmentStatus)) unavailable()
        summary.enrichmentStatus = detail.enrichmentStatus = input.enrichmentStatus ?? 'unknown'
        summaries.set(input.id, summary); details.set(input.id, detail)
        // Everything searchable is already public on the profile page.
        tokens.set(input.id, { name: words(summary.name), text: words([summary.name, summary.headline, company, detail.about, ...detail.positions.flatMap(position => [position.title, position.company, position.description]), ...detail.education.flatMap(school => [school.institution, school.degree]), ...detail.skills].filter(Boolean).join(' ')),
          // Position companies, the profile's own company and the headline,
          // tokenized once per compile, so a company page never re-tokenizes
          // every profile per request. The profile company is linked from the
          // profile header, so it must find its page too: an import can name
          // "Lopus AI (YC W25)" while the experience says "Lopus (YC W25)".
          companies: [...detail.positions.map(position => words(position.company)), words(company ?? ''), words(summary.headline ?? '')].filter(list => list.length) })
      }
      const outgoing = new Map([...summaries.keys()].map(id => [id, new Set()]))
      // A connection is mutual, but an edge is stored only from the person whose export listed it.
      const connected = new Map([...summaries.keys()].map(id => [id, new Set()]))
      for (const edge of value.connections) {
        if (!plain(edge) || !summaries.has(edge.fromId) || !summaries.has(edge.toId) || outgoing.get(edge.fromId).has(edge.toId)) unavailable()
        outgoing.get(edge.fromId).add(edge.toId)
        connected.get(edge.fromId).add(edge.toId); connected.get(edge.toId).add(edge.fromId)
      }
      // Presence is display evidence; only confirmed membership takes precedence
      // over recovered historical membership. Neither implies owner authorization.
      // Members' connection privacy (docs/connection-privacy.md). Listing counts
      // are what an anonymous visitor may see; signed-in views recount per viewer.
      const policies = connectionPolicies(value.connectionPrivacy, id => summaries.has(id))
      const listedBy = (a, b) => outgoing.get(a)?.has(b) ?? false
      const anonymous = createConnectionVisibility({ policies, connected, listedBy, viewer: null })
      const visibleCount = id => { if (!anonymous.restricted) return connected.get(id).size; let count = 0; for (const other of connected.get(id)) if (anonymous.visible(id, other)) count++; return count }
      if (value.members !== undefined) {
        const members = new Set(array(value.members, maxProfiles).map(id => { if (!summaries.has(id)) unavailable(); return id }))
        const legacy = new Set(array(value.legacyMembers ?? [], maxProfiles).map(id => { if (!summaries.has(id)) unavailable(); return id }))
        for (const [id, summary] of summaries) {
          const marks = { presence: members.has(id) ? 'member' : legacy.has(id) ? 'legacy' : 'shadow', connectionCount: visibleCount(id) }
          Object.assign(summary, marks); Object.assign(details.get(id), marks)
        }
      }
      const ordered = [...summaries.values()].sort((a, b) => compare(normalized(a.name), normalized(b.name)) || compare(a.id, b.id))
      // A merged profile's address points at its survivor.
      const aliases = new Map(), aliasesById = new Map()
      if (value.aliases !== undefined) {
        if (!plain(value.aliases) || Object.keys(value.aliases).length > maxProfiles) unavailable()
        for (const [from, to] of Object.entries(value.aliases)) { if (!idValid(from) || summaries.has(from) || !summaries.has(to)) unavailable(); aliases.set(from, to); if (!aliasesById.has(to)) aliasesById.set(to, []); aliasesById.get(to).push(from) }
      }
      // Autocomplete companies come only from visible positions, never raw imports.
      const companies = new Map()
      for (const detail of details.values()) for (const position of detail.positions) {
        const name = position.company.trim(), key = normalized(name), tokens = words(name)
        if (name.length <= 200 && tokens.length > 0 && tokens.length <= 12 && !companies.has(key)) companies.set(key, { name, tokens })
      }
      // Published but left out of listings (docs/unlisted-profiles.md).
      const unlisted = unlistedProfiles(value)
      // Suspended (soft-deleted) ids are never published; they are only named
      // so an account's own pages and photos can stay hidden too
      // (docs/profile-suspension.md).
      const suspended = new Set()
      if (value.suspended !== undefined) for (const id of array(value.suspended, maxProfiles + Math.max(maxProfiles, PROFILE_DECISION_LIMIT))) { if (!idValid(id) || summaries.has(id) || aliases.has(id)) unavailable(); suspended.add(id) }
      // SHA-256 LinkedIn slug references of suspended people, for owner-private rows.
      const suspendedRefs = new Set()
      if (value.suspendedRefs !== undefined) for (const ref of array(value.suspendedRefs, 2 * maxProfiles + Math.max(maxProfiles, PROFILE_DECISION_LIMIT))) { if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) unavailable(); suspendedRefs.add(ref) }
      // Addresses an operator removal took out; never published, only named.
      const removed = new Set()
      if (Array.isArray(value.removed)) for (const id of value.removed) if (idValid(id) && !summaries.has(id)) removed.add(id)
      const linkedinProfiles = new Map(), linkedinIds = new Map()
      for (const detail of details.values()) {
        const slug = parseLinkedinProfileUrl(detail.linkedinUrl)?.slug
        if (!slug) continue
        if (!linkedinIds.has(slug)) linkedinIds.set(slug, [])
        linkedinIds.get(slug).push(detail.id)
        const previous = linkedinProfiles.get(slug)
        if (!previous || Number(detail.presence === 'member') > Number(previous.presence === 'member') ||
          (Number(detail.presence === 'member') === Number(previous.presence === 'member') && compare(detail.id, previous.id) < 0)) linkedinProfiles.set(slug, detail)
      }
      const data = { revision: value.revision, ordered, summaries, details, linkedinProfiles, linkedinIds, connected, policies, listedBy, tokens, aliases, aliasesById, unlisted, suspended, suspendedRefs, removed, companyList: [...companies.values()] }
      // Shared across requests, so no caller can change what another one sees.
      if (cacheable) { for (const row of [...summaries.values(), ...details.values()]) deepFreeze(row); compiled.set(source, { key: cacheKey, data }) }
      return data
    } catch (error) {
      // Keep why the build failed as a fixed reason: the deadline or caller
      // abort, a worker install/transfer failure, or a snapshot that failed
      // validation (typed refusals without a reason). Never the error text.
      // Always the generic 503: a provider's own status/code never passes through.
      if (error instanceof PublicPeopleReaderError) throw new PublicPeopleReaderError(503, 'public_people_unavailable', ['build_timeout', 'aborted'].includes(error.reason) ? error.reason : 'snapshot_invalid')
      if (typeof error?.reason === 'string') throw new PublicPeopleReaderError(503, 'public_people_unavailable', error.reason === 'worker_timeout' ? 'install_timeout' : error.reason)
      reportIndexError('reader', 'build', error)
      throw new PublicPeopleReaderError(503, 'public_people_unavailable', 'reader_exception')
    } finally {
      clearTimeout(timer)
      if (abortHandler) combined.removeEventListener('abort', abortHandler)
      controller.abort()
    }
  }

  // `unlistedGroups`: the signed-in viewer's own unlisted groups (a Set of
  // names), so profiles unlisted in the same group stay listed for them.
  const groupsValue = value => {
    if (value === undefined || value === null) return null
    if (!(value instanceof Set) || value.size > 8 || ![...value].every(group => typeof group === 'string' && UNLISTED_GROUP.test(group))) invalid()
    return value.size ? value : null
  }
  const groupScope = groups => groups ? `g=${[...groups].sort().join(',')}:` : ''
  // `viewer`: who is looking, for members' connection privacy
  // (docs/connection-privacy.md): { signedIn, id?: their published profile }.
  // Missing means an anonymous visitor, so a caller that forgets it can only
  // show less, never more.
  const viewerValue = value => {
    if (value === undefined || value === null) return null
    if (!plain(value) || typeof value.signedIn !== 'boolean' || (value.id !== undefined && value.id !== null && !idValid(value.id)) || Object.keys(value).some(key => !['signedIn', 'id'].includes(key))) invalid()
    return value
  }
  // The viewer's private `known` set never widens what they see: relationships
  // come only from the published owner-side lists (docs/connection-privacy.md).
  const visibilityFor = (data, viewer) => createConnectionVisibility({ policies: data.policies, connected: data.connected, listedBy: data.listedBy,
    viewer: viewer ? { signedIn: viewer.signedIn, ...(viewer.id ? { id: data.aliases.get(viewer.id) ?? viewer.id } : {}) } : null })
  // Connection lists can differ per viewer, so a signed-in viewer's cursors are theirs.
  const viewerScope = viewer => viewer ? `:v=${hash(JSON.stringify([viewer.signedIn === true, viewer.id ?? null]))}` : ''
  const queryValue = value => { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > 200) invalid(); return normalized(value) }
  function cursorValue(cursor, scope) {
    if (cursor === undefined) return undefined
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid()
    let decoded
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { invalid() }
    if (!plain(decoded) || decoded.v !== 1 || decoded.scope !== hash(scope) || !revisionValid(decoded.revision) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) invalid()
    return decoded
  }
  // Photos have their own live publication pointer and are not identified by
  // the People revision. Resolve them only for returned rows, never in the index.
  const withPhoto = row => {
    if (!photoFor) return row
    const photo = photoFor(row.id)
    return Object.freeze({ ...row, ...(typeof photo === 'string' && PHOTO_URL.test(photo) ? { photo } : {}) })
  }
  function page(rows, cursor, scope, revision) {
    let offset = 0
    if (cursor !== undefined) {
      if (cursor.revision !== revision) unavailable()
      if (cursor.offset > rows.length) invalid()
      offset = cursor.offset
    }
    const profiles = rows.slice(offset, offset + pageSize).map(withPhoto)
    const nextCursor = offset + pageSize < rows.length ? Buffer.from(JSON.stringify({ v: 1, scope: hash(scope), revision, offset: offset + pageSize })).toString('base64url') : undefined
    return { profiles, ...(nextCursor ? { nextCursor } : {}) }
  }
  // Rows that carry a photo, per method, so photos stay resolved on this side
  // (their publication is live and not part of the index revision).
  // Rows arrive as fresh copies; frozen like compiled rows, so a caller can no
  // more change one than it could an in-process index row.
  const out = row => withPhoto(deepFreeze(row))
  const withPhotos = (method, result) => {
    if (result === null || result === undefined) return result
    switch (method) {
      case 'suggest': return { ...result, people: result.people.map(out) }
      case 'list': return { ...result, profiles: result.profiles.map(out) }
      case 'company': return { ...result, people: result.people.map(out) }
      case 'neighbors': return result.map(out)
      case 'lookupLinkedin': return out(result)
      case 'lookup': return new Map([...result].map(([key, row]) => [key, out(row)]))
      case 'card': { if (!result.card) return result; const { mutual, ...summary } = result.card; return { card: { ...out(summary), ...(mutual === undefined ? {} : { mutual }) } } }
      case 'profile': {
        if (!result.profile) return result
        const { connectionCount, connectionsTotal, connectionFacets, mutual, connections, nextConnectionsCursor, ...detail } = result.profile
        return { profile: { ...out(detail), connectionCount, connectionsTotal, connectionFacets, ...(mutual ? { mutual: { ...mutual, preview: mutual.preview.map(out) } } : {}), connections: connections.map(out), ...(nextConnectionsCursor ? { nextConnectionsCursor } : {}) } }
      }
      default: return result
    }
  }
  // Keeps the fixed failure reason across the worker boundary; an untyped
  // exception here also writes one fixed stderr line (class and location only).
  const asReaderError = error => {
    if (error instanceof PublicPeopleReaderError) return error
    const typedFailure = Number.isSafeInteger(error?.status)
    if (!typedFailure) reportIndexError('reader', 'any', error)
    const reason = typeof error?.reason === 'string' ? error.reason : error?.stale ? 'stale' : typedFailure ? undefined : 'reader_exception'
    return new PublicPeopleReaderError(error?.status === 400 ? 400 : 503, error?.status === 400 ? 'public_people_input_invalid' : 'public_people_unavailable', reason)
  }
  // Run `method` in the index worker against the snapshot descriptor `data`.
  // A worker that no longer holds that index (restarted, or the revision
  // aged out) answers `stale`: read and install once more, then retry once.
  async function remote(method, request, data, retried = false) {
    const { signal, ...rest } = request
    const { host, sourceKey, cacheKey } = data.remote
    const call = host.call(sourceKey, cacheKey, { pageSize, limits: { maxProfiles, maxConnections, maxTextBytes } }, method, rest)
    // An abort can settle this call first; a later rejection must not go unhandled.
    call.catch(() => {})
    let result
    try {
      result = await (signal ? new Promise((resolve, reject) => {
        const abort = () => reject(new PublicPeopleReaderError(503, 'public_people_unavailable', 'aborted'))
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      }) : call)
    } catch (error) {
      if (error?.stale && !retried) {
        if (kept === data) kept = null
        if (latest?.data === data) latest = null
        const fresh = method === 'suggest' ? await recent(signal) : await snapshot(signal)
        if (fresh.remote) return remote(method, request, fresh, true)
      }
      throw asReaderError(error)
    }
    return withPhotos(method, result)
  }
  return {
    // Start loading the index (e.g. when the search field gains focus) so the
    // first keystroke finds it ready. Never waits and never returns data.
    warm() { if (age() >= suggestFreshMs) refresh() },
    // `known`: published ids the signed-in member is connected to; they are
    // marked and preferred among equal matches. Never read here.
    async suggest(request = {}) {
      const { query = '', signal, known, unlistedGroups } = requestValue(request)
      if (known !== undefined && !(known instanceof Set)) invalid()
      const groups = groupsValue(unlistedGroups)
      const search = queryValue(query)
      if (search.length < 2 || !words(search).length) return { people: [], companies: [] }
      const data = await recent(signal)
      if (data.remote) return remote('suggest', request, data)
      const index = suggestIndexFor(data)
      return { people: suggestPeople(index, data, search, { limit: SUGGESTED_PEOPLE, known, listed: listedFor(data.unlisted, groups) }).map(withPhoto), companies: suggestCompanies(index, data, search, { limit: 3 }) }
    },
    async list(request = {}) {
      const { query = '', cursor, signal, mode = 'best', presence, enrichmentStatus, sort = 'best', includeTotal = false, exclude = [], unlistedGroups, filters: inputFilters = {}, networkSeeds, networkSelf } = requestValue(request)
      const groups = groupsValue(unlistedGroups), filters = peopleFilters(inputFilters), viewer = networkSeeds ? viewerValue(request.viewer) : null
      if (networkSeeds !== undefined && (!Array.isArray(networkSeeds) || networkSeeds.length > maxProfiles || !networkSeeds.every(idValid))) invalid()
      if (networkSelf !== undefined && !idValid(networkSelf)) invalid()
      if (filters.degree && !networkSeeds) invalid()
      if (!PUBLIC_LIST_SORTS.includes(sort) || !SEARCH_MODES.includes(mode) || (presence !== undefined && !PRESENCE.includes(presence)) || (enrichmentStatus !== undefined && !ENRICHMENT_STATUS.includes(enrichmentStatus))) invalid()
      // `exclude`: published ids the caller already shows elsewhere on the page
      // (a signed-in owner's own people), left out before paging and totals.
      if (!Array.isArray(exclude) || exclude.length > maxProfiles || !exclude.every(idValid)) invalid()
      const normalizedQuery = queryValue(query), matcher = normalizedQuery ? createQueryMatcher(normalizedQuery, mode) : null
      // The presence filter and exclusions are part of the cursor scope, so a page never mixes filters.
      const filter = `${enrichmentStatus ? `enrichment=${enrichmentStatus}:` : ''}${presence ? `${presence}:` : ''}${sort === 'best' ? '' : `sort=${sort}:`}${groupScope(groups)}${Object.keys(filters).length ? `filters=${hash(JSON.stringify(filters))}:` : ''}${networkSeeds ? `network=${hash(JSON.stringify([networkSelf, [...networkSeeds].sort(), viewerScope(viewer)]))}:` : ''}`
      const data0 = exclude.length ? await snapshot(signal) : null
      if (data0?.remote) return remote('list', request, data0)
      const excluded = data0 ? new Set(exclude.map(id => data0.aliases.get(id) ?? id)) : null
      const without = excluded?.size ? `x=${hash([...excluded].sort().join('\n'))}:` : ''
      const scope = matcher ? `list:${filter}${without}${mode}:${normalizedQuery}` : `list:${filter}${without}`
      const decodedCursor = cursorValue(cursor, scope), data = data0 ?? await snapshot(signal)
      if (data.remote) return remote('list', request, data)
      // A snapshot that does not name its members has no presence, so it matches no filter.
      const listed = listedFor(data.unlisted, groups)
      const degrees = networkSeeds ? connectionDegrees({ seeds: networkSeeds.map(id => data.aliases.get(id) ?? id), self: data.aliases.get(networkSelf) ?? networkSelf, connected: data.connected, visible: visibilityFor(data, viewer).visible }) : null
      const people = data.ordered.filter(person => (!presence || person.presence === presence) && (!enrichmentStatus || person.enrichmentStatus === enrichmentStatus) && listed(person.id) && matchesPeopleFilters(data.details.get(person.id), filters) && (!filters.degree || degrees.get(person.id) === Number(filters.degree)))
        .map(person => degrees?.get(person.id) ? { ...person, connectionDegree: degrees.get(person.id) } : person)
      // Exclusions apply after ranking, so leaving out the full matches the
      // page already shows never promotes people who match only some words.
      const kept = rows => excluded?.size ? rows.filter(person => !excluded.has(person.id)) : rows
      if (!matcher) { const rows = kept(people); return { ...page(orderNetwork(rows, sort), decodedCursor, scope, data.revision), ...(presence || enrichmentStatus || includeTotal ? { total: rows.length } : {}) } }
      // `match` says whether the rows have every word ('all') or only some of them.
      const ranked = rankMatches(people, matcher, person => data.tokens.get(person.id)), rows = kept(ranked.rows)
      return { ...page(orderNetwork(rows, sort), decodedCursor, scope, data.revision), match: ranked.match, total: rows.length }
    },
    // Page an export from the exact same sanitized projection and viewer
    // visibility as browsing. Never copy the raw publication or adjacency map.
    async exportPage(request = {}) {
      const { signal, cursor, query = '', ids = [], unlistedGroups, presence, filters: rawFilters = {}, mode = 'exact', networkSeeds, networkSelf } = requestValue(request)
      const viewer = viewerValue(request.viewer), groups = groupsValue(unlistedGroups)
      if (!viewer?.signedIn || !Array.isArray(ids) || ids.length > 10000 || !ids.every(idValid)) invalid()
      const search = queryValue(query), filters = peopleFilters(rawFilters)
      if (!SEARCH_MODES.includes(mode) || ![undefined, ...PRESENCE].includes(presence) || networkSeeds !== undefined && (!Array.isArray(networkSeeds) || networkSeeds.length > maxProfiles || !networkSeeds.every(idValid)) || networkSelf !== undefined && !idValid(networkSelf) || filters.degree && !networkSeeds) invalid()
      const scope = `export:${search}:${hash(JSON.stringify([...ids].sort()))}:${groupScope(groups)}${viewerScope(viewer)}:${hash(JSON.stringify([presence, filters, mode, networkSeeds, networkSelf]))}`
      const decoded = cursorValue(cursor, scope), data = await snapshot(signal)
      if (data.remote) return remote('exportPage', request, data)
      // Keep one selection plan per reader, so a whole-network download
      // walks its index once rather than rebuilding a 100k-ID set per page.
      if (exportPlan?.data !== data || exportPlan.scope !== scope) {
        const listed = listedFor(data.unlisted, groups), selected = new Set(ids.map(id => data.aliases.get(id) ?? id))
        const matcher = search ? createQueryMatcher(search, mode) : null
        const degrees = networkSeeds ? connectionDegrees({ seeds: networkSeeds.map(id => data.aliases.get(id) ?? id), self: data.aliases.get(networkSelf) ?? networkSelf, connected: data.connected, visible: visibilityFor(data, viewer).visible }) : null
        let people = data.ordered.filter(person => listed(person.id) && (!presence || person.presence === presence) && matchesPeopleFilters(data.details.get(person.id), filters) && (!filters.degree || degrees.get(person.id) === Number(filters.degree)) && (!ids.length || selected.has(person.id)))
        if (matcher) people = rankMatches(people, matcher, person => data.tokens.get(person.id)).rows
        exportPlan = { data, scope, people, included: new Set(people.map(person => person.id)), visibility: visibilityFor(data, viewer) }
      }
      const { people, included, visibility } = exportPlan
      const result = page(people, decoded, scope, data.revision)
      const profiles = result.profiles.map(person => ({ ...data.details.get(person.id) }))
      const connections = []
      for (const person of result.profiles) for (const toId of data.connected.get(person.id) ?? []) {
        if (included.has(toId) && visibility.visible(person.id, toId)) connections.push({ fromId: person.id, toId })
      }
      return { revision: data.revision, profiles, connections, total: people.length, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    },
    async profile(request = {}) {
      // `show` narrows to members ('members') or to `known`, the published ids
      // the signed-in viewer is connected to ('known'). `known` also yields the
      // "You both know" count; it is never read here.
      const { id, cursor, signal, query = '', sort = 'name', show, known } = requestValue(request), viewer = viewerValue(request.viewer)
      if (!idValid(id) || !['name', 'detail'].includes(sort) || ![undefined, 'members', 'known'].includes(show) || (known !== undefined && !(known instanceof Set)) || (show === 'known' && !known)) invalid()
      const search = queryValue(query)
      const narrowed = show ? `:${show}${show === 'known' ? `:${hash([...known].sort().join('\n'))}` : ''}` : ''
      const scope = `connections:${id}${sort === 'name' && !search && !show ? '' : `:${sort}:${search}${narrowed}`}${viewerScope(viewer)}`, decodedCursor = cursorValue(cursor, scope)
      const data = await snapshot(signal)
      if (decodedCursor && decodedCursor.revision !== data.revision) unavailable()
      if (data.remote) return remote('profile', request, data)
      if (data.aliases.has(id)) return { moved: data.aliases.get(id) }
      if (!data.details.has(id)) return null
      const visibility = visibilityFor(data, viewer)
      let rows = data.ordered.filter(person => person.id !== id && data.connected.get(id).has(person.id) && visibility.visible(id, person.id))
      const connectionCount = rows.length
      // For a signed-in viewer, who they both know across the whole list (not
      // the current search): the count and a few faces, members first, for
      // the profile header's mutual line. Only this person's published
      // connections are read; the viewer's own set is never listed.
      const mutual = known ? (shared => ({ total: shared.length, preview: shared.sort((a, b) => Number(b.presence === 'member') - Number(a.presence === 'member')).slice(0, MUTUAL_PREVIEW).map(withPhoto) }))(rows.filter(person => known.has(person.id))) : undefined
      if (search) { const matcher = createQueryMatcher(search, 'best'); rows = matcher ? rows.filter(person => matcher.test(data.tokens.get(person.id)).all) : [] }
      // Counts for each narrowing, within the current search.
      const connectionFacets = { all: rows.length, members: rows.filter(person => person.presence === 'member').length, ...(known ? { known: rows.filter(person => known.has(person.id)).length } : {}) }
      if (show === 'members') rows = rows.filter(person => person.presence === 'member')
      else if (show === 'known') rows = rows.filter(person => known.has(person.id))
      if (sort === 'detail') rows.sort((a, b) => Number(b.detailLevel === 'detailed') - Number(a.detailLevel === 'detailed'))
      const connections = page(rows, decodedCursor, scope, data.revision)
      return { profile: { ...withPhoto(data.details.get(id)), connectionCount, connectionsTotal: rows.length, connectionFacets, ...(mutual ? { mutual } : {}), connections: connections.profiles, ...(connections.nextCursor ? { nextConnectionsCursor: connections.nextCursor } : {}) } }
    },
    // A small public card for hover previews: the summary, plus for a signed-in
    // viewer (`known`: published ids they are connected to; never read here)
    // how many of this person's connections they know too.
    async card(request = {}) {
      const { id, signal, known } = requestValue(request), viewer = viewerValue(request.viewer)
      if (!idValid(id) || (known !== undefined && !(known instanceof Set))) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('card', request, data)
      const resolved = data.aliases.get(id) ?? id, visibility = visibilityFor(data, viewer)
      const summary = data.summaries.get(resolved)
      if (!summary) return null
      let mutual
      if (known) { mutual = 0; for (const other of data.connected.get(resolved) ?? []) if (other !== resolved && known.has(other) && visibility.visible(resolved, other)) mutual++ }
      return { card: { ...withPhoto(summary), ...(mutual === undefined ? {} : { mutual }) } }
    },
    // The group a profile is unlisted in (null when unlisted for everyone),
    // or undefined when it is listed. Used for a viewer's own profile.
    async unlistedGroup(request = {}) {
      const { id, signal } = requestValue(request)
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('unlistedGroup', request, data)
      const resolved = data.aliases.get(id) ?? id
      return data.unlisted.has(resolved) ? data.unlisted.get(resolved) : undefined
    },
    // Whether an id names a suspended profile (docs/profile-suspension.md).
    async suspended(request = {}) {
      const { id, signal } = requestValue(request)
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('suspended', request, data)
      return data.suspended.has(id)
    },
    // Every suspended id and LinkedIn reference, as fresh sets.
    async suspensions(request = {}) {
      const { signal } = requestValue(request)
      const data = await snapshot(signal)
      if (data.remote) return remote('suspensions', request, data)
      return { ids: new Set(data.suspended), refs: new Set(data.suspendedRefs) }
    },
    // What an address registry needs (docs/profile-handles.md): every
    // published profile's id, name, presence and LinkedIn address, the merged
    // addresses and the ids a removal or suspension took out.
    async addresses(request = {}) {
      const { signal } = requestValue(request)
      const data = await snapshot(signal)
      if (data.remote) return remote('addresses', request, data)
      return {
        revision: data.revision,
        profiles: data.ordered.map(summary => { const url = data.details.get(summary.id).linkedinUrl; return { id: summary.id, name: summary.name, presence: summary.presence ?? 'shadow', ...(url ? { linkedinUrl: url } : {}) } }),
        aliases: new Map(data.aliases),
        hidden: new Set([...data.suspended, ...data.removed]),
      }
    },
    // Exact URL evidence only; names never establish a person match.
    async lookupLinkedin(request = {}) {
      const { address, signal } = requestValue(request), parsed = parseLinkedinProfileUrl(address)
      if (!parsed) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('lookupLinkedin', request, data)
      const match = data.linkedinProfiles.get(parsed.slug)
      return match ? withPhoto(data.summaries.get(match.id)) : null
    },
    async linkedinProfileIds(request = {}) {
      const { id, signal } = requestValue(request)
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('linkedinProfileIds', request, data)
      const resolved = data.aliases.get(id) ?? id
      const detail = data.details.get(resolved)
      if (!detail) return []
      const parsed = parseLinkedinProfileUrl(detail.linkedinUrl)
      const ids = parsed ? data.linkedinIds.get(parsed.slug) ?? [] : [resolved]
      return ids.flatMap(value => [value, ...(data.aliasesById.get(value) ?? [])])
    },
    // Exact identity from a currently readable public address, never an id's
    // spelling, a name, or an email. Private callers use it only in their own overlay.
    async linkedinRef(request = {}) {
      const { id, signal } = requestValue(request)
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('linkedinRef', request, data)
      const resolved = data.aliases.get(id) ?? id
      const parsed = parseLinkedinProfileUrl(data.details.get(resolved)?.linkedinUrl)
      return parsed ? hash(parsed.slug) : null
    },
    // The public summaries for known IDs, so a private row can link to the
    // matching public profile only when one is published.
    async lookup(request = {}) {
      const { ids, signal, filters = {}, details = false, listedOnly = false } = requestValue(request)
      if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(idValid)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('lookup', request, data)
      const resolved = id => data.aliases.get(id) ?? id
      const parsed = peopleFilters(filters), listed = listedFor(data.unlisted, new Set())
      return new Map(ids.filter(id => data.summaries.has(resolved(id)) && (!listedOnly || listed(resolved(id))) && matchesPeopleFilters(data.details.get(resolved(id)), parsed)).map(id => [id, withPhoto((details ? data.details : data.summaries).get(resolved(id)))]))
    },
    // Whether the public graph already connects two profiles (either direction,
    // merged addresses resolved). Used to avoid offering "Connect" to people
    // who are already connected through an import.
    async linked(request = {}) {
      const { fromId, toId, signal } = requestValue(request), viewer = viewerValue(request.viewer)
      if (!idValid(fromId) || !idValid(toId)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('linked', request, data)
      const from = data.aliases.get(fromId) ?? fromId, to = data.aliases.get(toId) ?? toId
      return from !== to && Boolean(data.connected.get(from)?.has(to)) && visibilityFor(data, viewer).visible(from, to)
    },
    // Everyone the public graph connects to one profile (either direction,
    // merged addresses resolved), as public summaries in name order.
    async neighbors(request = {}) {
      const { id, signal } = requestValue(request), viewer = viewerValue(request.viewer)
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (data.remote) return remote('neighbors', request, data)
      const from = data.aliases.get(id) ?? id
      const connected = data.connected.get(from), visibility = visibilityFor(data, viewer)
      return connected ? data.ordered.filter(person => connected.has(person.id) && visibility.visible(from, person.id)).map(withPhoto) : []
    },
    // Everyone whose public profile ties them to a company, by the company name
    // as it appears on profiles: a position at it, or a headline naming it.
    async company(request = {}) {
      const { name, cursor, signal, unlistedGroups } = requestValue(request)
      if (!companyPageName(name)) invalid()
      const groups = groupsValue(unlistedGroups)
      const phrase = words(name)
      const contains = tokens => {
        outer: for (let start = 0; start + phrase.length <= tokens.length; start++) {
          for (let offset = 0; offset < phrase.length; offset++) if (tokens[start + offset] !== phrase[offset]) continue outer
          return true
        }
        return false
      }
      const scope = `company:${groupScope(groups)}${phrase.join(' ')}`, decodedCursor = cursorValue(cursor, scope)
      const data = await snapshot(signal)
      if (data.remote) return remote('company', request, data)
      const listed = listedFor(data.unlisted, groups)
      const rows = data.ordered.filter(person => listed(person.id) && data.tokens.get(person.id).companies.some(contains))
      const people = page(rows, decodedCursor, scope, data.revision)
      return { name: name.trim(), total: rows.length, people: people.profiles, ...(people.nextCursor ? { nextCursor: people.nextCursor } : {}) }
    },
  }
}
