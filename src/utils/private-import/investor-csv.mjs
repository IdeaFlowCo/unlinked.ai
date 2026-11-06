import { createHash } from 'node:crypto'
import Papa from 'papaparse'
import { linkedinUrl as canonicalLinkedinUrl } from './archive.mjs'
import { linkedinRefHash, linkedinSlug } from '../public-people/url-identity.mjs'

// This parser only stages data; callers must store the result in an owner-private
// import and must not interpret a name as evidence of identity.
export const INVESTOR_CSV_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, rows: 100000, columns: 256, fieldChars: 32768 })
const sha = value => createHash('sha256').update(value).digest('hex')
const invalid = code => { throw new Error(code) }

/** Parse a CSV with caller-selected column names. The original fields remain
 * attached to each row for private provenance. Stable row IDs identify source
 * occurrences, not people; repeated names and repeated rows remain distinct.
 */
export function parseInvestorCsv(input, mapping) {
  const bytes = Buffer.from(input)
  if (!bytes.length || bytes.length > INVESTOR_CSV_LIMITS.bytes) invalid('csv_size_limit')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { invalid('csv_invalid_utf8') }
  const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', dynamicTyping: false })
  // A names-only CSV has no delimiter to infer. Papa still parses its single
  // column correctly; retain fatal handling for malformed quoting and rows.
  const singleColumn = parsed.data.every(row => row.length === 1)
  if (parsed.errors.some(error => error.code !== 'UndetectableDelimiter' || !singleColumn)) invalid('csv_invalid_format')
  if (!parsed.data.length) invalid('csv_missing_header')
  if (parsed.data.length - 1 > INVESTOR_CSV_LIMITS.rows) invalid('csv_row_limit')
  const headers = parsed.data[0].map(value => value.trim())
  if (!headers.length || headers.length > INVESTOR_CSV_LIMITS.columns || headers.some(value => !value || value.length > INVESTOR_CSV_LIMITS.fieldChars)) invalid('csv_invalid_header')
  if (new Set(headers.map(value => value.toLocaleLowerCase('en-US'))).size !== headers.length) invalid('csv_duplicate_header')
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) invalid('csv_invalid_mapping')
  const keys = ['name', 'firstName', 'lastName', 'linkedinUrl', 'email', 'company', 'title', 'notes']
  if (Object.keys(mapping).some(key => !keys.includes(key))) invalid('csv_invalid_mapping')
  if (!mapping.name && !mapping.firstName && !mapping.lastName) invalid('csv_name_mapping_required')
  const noteColumns = mapping.notes === undefined ? [] : mapping.notes
  if (!Array.isArray(noteColumns)) invalid('csv_invalid_mapping')
  const selected = [...keys.filter(key => key !== 'notes').map(key => mapping[key]).filter(value => value !== undefined), ...noteColumns]
  if (selected.some(value => typeof value !== 'string' || !headers.includes(value)) || new Set(selected).size !== selected.length) invalid('csv_invalid_mapping')
  const sourceDigest = sha(bytes)
  const accepted = [], rejected = []
  for (const [index, values] of parsed.data.slice(1).entries()) {
    const row = index + 2
    const rowId = sha(`investor-csv-v1\n${sourceDigest}\n${row}`)
    const fields = Object.fromEntries(headers.slice(0, values.length).map((header, i) => [header, values[i]]))
    const reject = reason => rejected.push({ row, rowId, reason, fields, sourceValues: values })
    if (values.length !== headers.length) { reject('csv_column_count'); continue }
    if (values.some(value => value.length > INVESTOR_CSV_LIMITS.fieldChars)) { reject('csv_field_size_limit'); continue }
    const read = key => mapping[key] ? fields[mapping[key]].trim() : ''
    const name = read('name') || [read('firstName'), read('lastName')].filter(Boolean).join(' ')
    if (!name) { reject('missing_name'); continue }
    const suppliedUrl = read('linkedinUrl')
    const url = suppliedUrl && canonicalLinkedinUrl(suppliedUrl)
    const refHash = url && linkedinRefHash(linkedinSlug(url))
    // An invalid supplied address is retained for review, never used as a key.
    // A valid address is only a candidate for exact-reference lookup; the
    // import itself never asserts a match or a personal connection.
    const identity = refHash ? { status: 'candidate', linkedinRefHash: refHash }
      : suppliedUrl ? { status: 'invalid_linkedin_url' } : { status: 'unresolved' }
    accepted.push({ row, rowId, name, linkedinUrl: suppliedUrl || null, identity, email: read('email') || null,
      company: read('company') || null, title: read('title') || null,
      notes: noteColumns.map(column => ({ column, text: fields[column] })).filter(note => note.text.trim()), fields })
  }
  return { parserVersion: 'investor-csv-v1', sourceDigest, headers, accepted, rejected }
}
