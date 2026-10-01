import { createHash } from 'node:crypto'

export class PublicPeopleReaderError extends Error {
  constructor(status, code) { super(code); this.name = 'PublicPeopleReaderError'; this.status = status; this.code = code }
}
const unavailable = () => { throw new PublicPeopleReaderError(503, 'public_people_unavailable') }
const invalid = () => { throw new PublicPeopleReaderError(400, 'public_people_input_invalid') }
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value !== '.' && value !== '..'
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')

// The injected provider owns public projection and both-endpoint visibility.
// No reader exists by default; private records and fixtures are never fallback sources.
export function createPublicPeopleReader({ readPublishedSnapshot, viewer = null, pageSize = 50, maxProfiles = 20000, maxConnections = 100000, maxTextBytes = 16 * 1024 * 1024, timeoutMs = 3000 } = {}) {
  if ((readPublishedSnapshot !== undefined && typeof readPublishedSnapshot !== 'function') || !bounded(pageSize, 100) || !bounded(maxProfiles, 20000) || !bounded(maxConnections, 100000) || !bounded(maxTextBytes, 16 * 1024 * 1024) || !bounded(timeoutMs, 30000) || (viewer !== null && (!plain(viewer) || !Object.isFrozen(viewer)))) throw new TypeError('public_people_configuration_invalid')

  async function snapshot(signal) {
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
      if (!plain(value) || value.state !== 'published' || value.complete !== true || typeof value.revision !== 'string' || !value.revision.length || value.revision.length > 512 || !Array.isArray(value.profiles) || value.profiles.length > maxProfiles || !Array.isArray(value.connections) || value.connections.length > maxConnections) unavailable()
      let textBytes = 0
      const text = (input, required = false, nonempty = false) => {
        if (input === undefined && !required) return undefined
        if (typeof input !== 'string' || input.length > 20000 || (nonempty && !input.trim())) unavailable()
        textBytes += Buffer.byteLength(input)
        if (textBytes > maxTextBytes) unavailable()
        return input
      }
      const optional = (output, key, input) => { const result = text(input); if (result !== undefined) output[key] = result }
      const array = (input, max) => { if (!Array.isArray(input) || input.length > max) unavailable(); return input }
      const summaries = new Map(), details = new Map(), search = new Map()
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
        search.set(input.id, normalized([summary.name, company, ...detail.positions.map(position => position.company)].filter(Boolean).join(' ')))
      }
      const outgoing = new Map([...summaries.keys()].map(id => [id, new Set()]))
      for (const edge of value.connections) {
        if (!plain(edge) || !summaries.has(edge.fromId) || !summaries.has(edge.toId) || outgoing.get(edge.fromId).has(edge.toId)) unavailable()
        outgoing.get(edge.fromId).add(edge.toId)
      }
      const ordered = [...summaries.values()].sort((a, b) => compare(normalized(a.name), normalized(b.name)) || compare(a.id, b.id))
      return { revision: value.revision, ordered, summaries, details, outgoing, search }
    } catch (error) {
      if (error instanceof PublicPeopleReaderError) throw error
      unavailable()
    } finally {
      clearTimeout(timer)
      if (abortHandler) combined.removeEventListener('abort', abortHandler)
      controller.abort()
    }
  }

  const queryValue = value => { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > 200) invalid(); return normalized(value) }
  function page(rows, cursor, scope, revision) {
    let offset = 0
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid()
      let decoded
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { invalid() }
      if (!plain(decoded) || decoded.v !== 1 || decoded.scope !== hash(scope) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > rows.length) invalid()
      if (decoded.revision !== revision) unavailable()
      offset = decoded.offset
    }
    const profiles = rows.slice(offset, offset + pageSize)
    const nextCursor = offset + pageSize < rows.length ? Buffer.from(JSON.stringify({ v: 1, scope: hash(scope), revision, offset: offset + pageSize })).toString('base64url') : undefined
    return { profiles, ...(nextCursor ? { nextCursor } : {}) }
  }
  return {
    async list({ query = '', cursor, signal } = {}) {
      const normalizedQuery = queryValue(query), data = await snapshot(signal)
      const terms = normalizedQuery ? normalizedQuery.split(' ') : []
      return page(data.ordered.filter(person => terms.every(term => data.search.get(person.id).includes(term))), cursor, `list:${normalizedQuery}`, data.revision)
    },
    async profile({ id, cursor, signal } = {}) {
      if (!idValid(id)) invalid()
      const data = await snapshot(signal)
      if (!data.details.has(id)) return null
      const connections = page(data.ordered.filter(person => data.outgoing.get(id).has(person.id)), cursor, `connections:${id}`, data.revision)
      return { profile: { ...data.details.get(id), connections: connections.profiles, ...(connections.nextCursor ? { nextConnectionsCursor: connections.nextCursor } : {}) } }
    },
  }
}
