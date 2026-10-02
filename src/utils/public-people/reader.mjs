import { createHash } from 'node:crypto'
import { SEARCH_MODES, createQueryMatcher, rankMatches, words } from './text-match.mjs'

export class PublicPeopleReaderError extends Error {
  constructor(status, code) { super(code); this.name = 'PublicPeopleReaderError'; this.status = status; this.code = code }
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

const dense = value => {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
  }
  return true
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
// member: a confirmed account owns the profile; shadow: imported, not on Unlinked yet.
export const PRESENCE = Object.freeze(['member', 'shadow'])
const requestValue = value => {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid()
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) invalid()
  return value
}

// The injected provider owns public projection and both-endpoint visibility.
// No reader exists by default; private records and fixtures are never fallback sources.
export function createPublicPeopleReader({ readPublishedSnapshot, viewer = null, pageSize = 50, maxProfiles = 20000, maxConnections = 100000, maxTextBytes = 16 * 1024 * 1024, timeoutMs = 3000 } = {}) {
  if ((readPublishedSnapshot !== undefined && typeof readPublishedSnapshot !== 'function') || !bounded(pageSize, 100) || !bounded(maxProfiles, 20000) || !bounded(maxConnections, 100000) || !bounded(maxTextBytes, 16 * 1024 * 1024) || !bounded(timeoutMs, 30000) || (viewer !== null && (!plain(viewer) || !immutableIdentity(viewer)))) throw new TypeError('public_people_configuration_invalid')

  // Reads that overlap share one build: a page may read the snapshot twice at
  // once, and building it is slow. Nothing outlives the build, so every new
  // read still sees the current publication. A caller's own signal reads alone.
  let inflight = null
  async function snapshot(signal) {
    if (signal) return build(signal)
    if (!inflight) inflight = build().finally(() => { inflight = null })
    return inflight
  }
  async function build(signal) {
    if (!readPublishedSnapshot) unavailable()
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let timer, abortHandler
    try {
      const interruption = new Promise((_, reject) => {
        abortHandler = () => reject(new PublicPeopleReaderError(503, 'public_people_unavailable'))
        combined.addEventListener('abort', abortHandler, { once: true })
        timer = setTimeout(() => controller.abort(), timeoutMs)
        if (combined.aborted) abortHandler()
      })
      const value = await Promise.race([Promise.resolve().then(() => readPublishedSnapshot({ maxProfiles, maxConnections, maxTextBytes, signal: combined, viewer })), interruption])
      if (!plain(value) || value.state !== 'published' || value.complete !== true || !revisionValid(value.revision) || !Array.isArray(value.profiles) || value.profiles.length > maxProfiles || !dense(value.profiles) || !Array.isArray(value.connections) || value.connections.length > maxConnections || !dense(value.connections)) unavailable()
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
        summaries.set(input.id, summary); details.set(input.id, detail)
        // Everything searchable is already public on the profile page.
        tokens.set(input.id, { name: words(summary.name), text: words([summary.name, summary.headline, company, detail.about, ...detail.positions.flatMap(position => [position.title, position.company, position.description]), ...detail.education.flatMap(school => [school.institution, school.degree]), ...detail.skills].filter(Boolean).join(' ')) })
      }
      const outgoing = new Map([...summaries.keys()].map(id => [id, new Set()]))
      // A connection is mutual, but an edge is stored only from the person whose export listed it.
      const connected = new Map([...summaries.keys()].map(id => [id, new Set()]))
      for (const edge of value.connections) {
        if (!plain(edge) || !summaries.has(edge.fromId) || !summaries.has(edge.toId) || outgoing.get(edge.fromId).has(edge.toId)) unavailable()
        outgoing.get(edge.fromId).add(edge.toId)
        connected.get(edge.fromId).add(edge.toId); connected.get(edge.toId).add(edge.fromId)
      }
      // A snapshot that names its members marks everyone else as a shadow
      // (imported, not on Unlinked yet) and says how far each person reaches.
      if (value.members !== undefined) {
        const members = new Set(array(value.members, maxProfiles).map(id => { if (!summaries.has(id)) unavailable(); return id }))
        for (const [id, summary] of summaries) {
          const marks = { presence: members.has(id) ? 'member' : 'shadow', connectionCount: connected.get(id).size }
          Object.assign(summary, marks); Object.assign(details.get(id), marks)
        }
      }
      const ordered = [...summaries.values()].sort((a, b) => compare(normalized(a.name), normalized(b.name)) || compare(a.id, b.id))
      return { revision: value.revision, ordered, summaries, details, connected, tokens }
    } catch {
      unavailable()
    } finally {
      clearTimeout(timer)
      if (abortHandler) combined.removeEventListener('abort', abortHandler)
      controller.abort()
    }
  }

  const queryValue = value => { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > 200) invalid(); return normalized(value) }
  function cursorValue(cursor, scope) {
    if (cursor === undefined) return undefined
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid()
    let decoded
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { invalid() }
    if (!plain(decoded) || decoded.v !== 1 || decoded.scope !== hash(scope) || !revisionValid(decoded.revision) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) invalid()
    return decoded
  }
  function page(rows, cursor, scope, revision) {
    let offset = 0
    if (cursor !== undefined) {
      if (cursor.revision !== revision) unavailable()
      if (cursor.offset > rows.length) invalid()
      offset = cursor.offset
    }
    const profiles = rows.slice(offset, offset + pageSize)
    const nextCursor = offset + pageSize < rows.length ? Buffer.from(JSON.stringify({ v: 1, scope: hash(scope), revision, offset: offset + pageSize })).toString('base64url') : undefined
    return { profiles, ...(nextCursor ? { nextCursor } : {}) }
  }
  return {
    async list(request = {}) {
      const { query = '', cursor, signal, mode = 'best', presence } = requestValue(request)
      if (!SEARCH_MODES.includes(mode) || (presence !== undefined && !PRESENCE.includes(presence))) invalid()
      const normalizedQuery = queryValue(query), matcher = normalizedQuery ? createQueryMatcher(normalizedQuery, mode) : null
      // The presence filter is part of the cursor scope, so a page never mixes filters.
      const filter = presence ? `${presence}:` : ''
      const scope = matcher ? `list:${filter}${mode}:${normalizedQuery}` : `list:${filter}`
      const decodedCursor = cursorValue(cursor, scope), data = await snapshot(signal)
      // A snapshot that does not name its members has no presence, so it matches no filter.
      const people = presence ? data.ordered.filter(person => person.presence === presence) : data.ordered
      if (!matcher) return { ...page(people, decodedCursor, scope, data.revision), ...(presence ? { total: people.length } : {}) }
      // `match` says whether the rows have every word ('all') or only some of them.
      const ranked = rankMatches(people, matcher, person => data.tokens.get(person.id))
      return { ...page(ranked.rows, decodedCursor, scope, data.revision), match: ranked.match, total: ranked.rows.length }
    },
    async profile(request = {}) {
      const { id, cursor, signal } = requestValue(request)
      if (!idValid(id)) invalid()
      const scope = `connections:${id}`, decodedCursor = cursorValue(cursor, scope)
      const data = await snapshot(signal)
      if (decodedCursor && decodedCursor.revision !== data.revision) unavailable()
      if (!data.details.has(id)) return null
      const connections = page(data.ordered.filter(person => data.connected.get(id).has(person.id)), decodedCursor, scope, data.revision)
      return { profile: { ...data.details.get(id), connections: connections.profiles, ...(connections.nextCursor ? { nextConnectionsCursor: connections.nextCursor } : {}) } }
    },
    // The public summaries for known IDs, so a private row can link to the
    // matching public profile only when one is published.
    async lookup(request = {}) {
      const { ids, signal } = requestValue(request)
      if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(idValid)) invalid()
      const data = await snapshot(signal)
      return new Map(ids.filter(id => data.summaries.has(id)).map(id => [id, data.summaries.get(id)]))
    },
    // Everyone whose public profile ties them to a company, by the company name
    // as it appears on profiles: a position at it, or a headline naming it.
    async company(request = {}) {
      const { name, cursor, signal } = requestValue(request)
      if (typeof name !== 'string' || !name.trim() || name.length > 200) invalid()
      const phrase = words(name)
      if (!phrase.length || phrase.length > 12) invalid()
      const contains = tokens => {
        outer: for (let start = 0; start + phrase.length <= tokens.length; start++) {
          for (let offset = 0; offset < phrase.length; offset++) if (tokens[start + offset] !== phrase[offset]) continue outer
          return true
        }
        return false
      }
      const scope = `company:${phrase.join(' ')}`, decodedCursor = cursorValue(cursor, scope)
      const data = await snapshot(signal)
      const rows = data.ordered.filter(person => {
        const detail = data.details.get(person.id)
        return detail.positions.some(position => contains(words(position.company))) || contains(words(person.headline ?? ''))
      })
      const people = page(rows, decodedCursor, scope, data.revision)
      return { name: name.trim(), total: rows.length, people: people.profiles, ...(people.nextCursor ? { nextCursor: people.nextCursor } : {}) }
    },
  }
}
