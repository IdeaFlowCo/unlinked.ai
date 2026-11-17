import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import { createQueryMatcher, rankMatches, words } from '../src/utils/public-people/text-match.mjs'

const invalid = () => { throw Object.assign(Error('invalid_roster'), { code: 'invalid_roster' }) }
const keys = ['display_name', 'phone_hash', 'participant_id']
export const rosterDigest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
export function parseGroupRoster(input, format) {
  const bytes = Buffer.from(input)
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) invalid()
  let text, rows
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') } catch { invalid() }
  if (format === 'json') {
    try { rows = JSON.parse(text) } catch { invalid() }
  } else if (format === 'csv') {
    const parsed = Papa.parse(text, { delimiter: ',', skipEmptyLines: 'greedy', dynamicTyping: false })
    if (parsed.errors.length || !parsed.data.length) invalid()
    const headers = parsed.data.shift()
    if (headers.length !== 3 || new Set(headers).size !== 3 || headers.some(k => !keys.includes(k))) invalid()
    rows = parsed.data.map(values => {
      if (values.length !== 3) invalid()
      return Object.fromEntries(headers.map((key, i) => [key, values[i]]))
    })
  } else invalid()
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) invalid()
  const ids = new Set()
  return rows.map(row => {
    if (!row || Array.isArray(row) || Object.keys(row).length !== 3 || keys.some(k => !Object.hasOwn(row, k))) invalid()
    const { display_name: name, phone_hash: hash, participant_id: id } = row
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name) ||
      // Phone-like names are never an escape hatch for raw numbers.
      /(?:\+?\p{Nd}[\s().-]*){7,}/u.test(name.normalize('NFKC')) || typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || ids.has(id) ||
      !(hash === null || hash === '' || (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))) invalid()
    ids.add(id)
    return { display_name: name.trim(), phone_hash: hash || null, participant_id: id }
  })
}

// Pure name proposals over an already-authorized published projection. No
// provider, phone lookup, private cross-owner search or auto-linking capability.
export function suggestRosterMatches(rows, profiles) {
  if (!Array.isArray(profiles) || profiles.length > 100000) throw Error('group_candidate_limit')
  return rows.map(row => {
    const matcher = createQueryMatcher(row.display_name)
    const ranked = matcher ? rankMatches(profiles, matcher, p => ({ name: words(p.name), text: words(p.name) })) : { rows: [] }
    const candidates = ranked.rows.slice(0, 3).filter(p => typeof p.id === 'string' && typeof p.name === 'string').map(p => ({
      profileId: p.id, name: p.name.slice(0, 200), presence: p.presence === 'member' ? 'member' : 'profile', confidence: 'low', evidence: 'name_only',
    }))
    return { ...row, resolution: { status: candidates.length > 1 ? 'ambiguous' : candidates.length ? 'suggested' : 'unmatched', candidates } }
  })
}
