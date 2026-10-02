import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import Papa from 'papaparse'

export const PARSER_VERSION = 'linkedin-archive-v5'
export const LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, expandedBytes: 40 * 1024 * 1024, files: 2000, rows: 100000, headerRows: 20, recordChars: 65536, fieldChars: 32768, fields: 256, quoteTokens: 1024 })
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function fail(code) { throw new Error(code) }
function safePath(path) {
  if (!path || path.length > 1024 || path.includes('\\') || path.startsWith('/') || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.')) fail('unsafe_archive_path')
  return path
}

// Inspect central-directory bounds before inflating. ZIP64, encryption, symlinks,
// duplicate paths and alternate compression methods are deliberately unsupported.
export function unpackArchive(input, filename, { selectedOnly = false } = {}) {
  const bytes = Buffer.from(input)
  if (!bytes.length || bytes.length > LIMITS.archiveBytes) fail('archive_size_limit')
  if (/\.csv$/i.test(filename)) {
    if (bytes.length > LIMITS.fileBytes) fail('file_size_limit')
    return [{ path: safePath(filename), bytes }]
  }
  if (!/\.zip$/i.test(filename)) fail('unsupported_archive_format')
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) fail('invalid_zip_directory')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || size === 0xffffffff || offset === 0xffffffff) fail('unsupported_zip_layout')
  if (count > LIMITS.files || offset + size !== end) fail('zip_directory_limit')
  const entries = [], paths = new Set()
  let cursor = offset, expanded = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('invalid_zip_entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24)
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameSize + extraSize + commentSize
    if (next > end || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff || bytes.readUInt16LE(cursor + 34)) fail('unsupported_zip_entry')
    if (((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) fail('zip_symlink_rejected')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize)
    const path = safePath(new TextDecoder('utf-8', { fatal: true }).decode(nameBytes))
    if (paths.has(path)) fail('duplicate_archive_path')
    paths.add(path)
    const selected = !selectedOnly || Object.hasOwn(categories, path.split('/').pop().toLowerCase())
    if (selected) {
      expanded += uncompressed
      if (uncompressed > LIMITS.fileBytes || expanded > LIMITS.expandedBytes) fail('zip_expansion_limit')
    }
    if (localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('invalid_zip_local_header')
    const localNameSize = bytes.readUInt16LE(localOffset + 26), localExtraSize = bytes.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameSize + localExtraSize
    if (bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes) || start + compressed > offset) fail('zip_header_mismatch')
    entries.push({ path, method, crc, uncompressed, compressed, start, selected })
    cursor = next
  }
  if (cursor !== end) fail('invalid_zip_directory_size')
  return entries.filter(e => !e.path.endsWith('/')).map(e => {
    const compressed = bytes.subarray(e.start, e.start + e.compressed)
    if (!e.selected) return { path: e.path, skippedEntry: { path: e.path, compressionMethod: e.method, crc32: e.crc, expandedBytes: e.uncompressed, compressedBytes: e.compressed, compressedSha256: digest(compressed) } }
    const content = e.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: LIMITS.fileBytes })
    if (content.length !== e.uncompressed || crc32(content) !== e.crc) fail('zip_content_mismatch')
    return { path: e.path, bytes: content }
  })
}

const categories = {
  'connections.csv': { category: 'connections', required: ['first name', 'last name', 'url'] },
  // People a member added by hand: a LinkedIn address is optional, and checked when given.
  'added people.csv': { category: 'connections', required: ['first name'], optionalUrl: true },
  'profile.csv': { category: 'profile', required: ['first name', 'last name'] },
  'positions.csv': { category: 'positions', required: ['company name', 'title'] },
  'education.csv': { category: 'education', required: ['school name'] },
  'skills.csv': { category: 'skills', required: ['name'] },
}
export function linkedinUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !/^\/in\/[\w%-]+\/?$/.test(url.pathname)) return null
    return `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`
  } catch { return null }
}

function* csvRecords(text) {
  let newline, recordStart = 0, fieldStart = 0, fields = 1, quotes = 0, quoted = false
  const separatorAt = i => newline ? text.startsWith(newline, i) : text[i] === '\r' || text[i] === '\n'
  for (let i = 0; i < text.length; i++) {
    const recordEnd = !quoted && separatorAt(i)
    const fieldEnd = !quoted && (text[i] === ',' || recordEnd)
    if (i - recordStart + Number(!recordEnd) > LIMITS.recordChars) { yield { error: 'csv_record_size_limit' }; return }
    if (i - fieldStart + Number(!fieldEnd) > LIMITS.fieldChars) { yield { error: 'csv_field_size_limit' }; return }
    if (text[i] === '"') {
      if (++quotes > LIMITS.quoteTokens) { yield { error: 'csv_quote_limit' }; return }
      if (!quoted && i === fieldStart) quoted = true
      else if (quoted) {
        if (text[i + 1] === '"') {
          if (++quotes > LIMITS.quoteTokens) { yield { error: 'csv_quote_limit' }; return }
          i++
        } else {
          let next = i + 1
          while (next < text.length && text[next] !== ',' && !separatorAt(next) && !text[next].trim()) {
            if (next - recordStart >= LIMITS.recordChars) { yield { error: 'csv_record_size_limit' }; return }
            if (next - fieldStart >= LIMITS.fieldChars) { yield { error: 'csv_field_size_limit' }; return }
            next++
          }
          if (i === text.length - 1 || text[next] === ',' || separatorAt(next)) quoted = false
        }
      }
    } else if (!quoted && text[i] === ',') {
      if (++fields > LIMITS.fields) { yield { error: 'csv_field_count_limit' }; return }
      fieldStart = i + 1
    } else if (recordEnd) {
      newline ??= text[i] === '\r' && text[i + 1] === '\n' ? '\r\n' : text[i]
      i += newline.length - 1
      yield { text: text.slice(recordStart, i + 1), newline }
      recordStart = fieldStart = i + 1
      fields = 1; quotes = 0
    }
  }
  if (text.length - recordStart > LIMITS.recordChars) { yield { error: 'csv_record_size_limit' }; return }
  if (text.length - fieldStart > LIMITS.fieldChars) { yield { error: 'csv_field_size_limit' }; return }
  yield { text: text.slice(recordStart), newline: newline ?? '\n' }
}

export function parseSource(source, budget = { remaining: LIMITS.rows }, limitError = 'csv_row_limit') {
  const filename = source.path.split('/').pop().toLowerCase()
  const spec = Object.hasOwn(categories, filename) ? categories[filename] : undefined
  const base = { path: source.path, sha256: digest(source.bytes), bytes: source.bytes.length, category: spec?.category ?? 'unsupported', accepted: [], rejected: [], skipped: !spec }
  if (!spec) return base
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes).replace(/^\uFEFF/, '') }
  catch { return { ...base, error: 'invalid_utf8' } }
  let headers, record = 0
  for (const window of csvRecords(text)) {
    if (budget.remaining <= 0) { base.error = limitError; break }
    if (window.error) { base.error = window.error; break }
    budget.remaining--
    const result = Papa.parse(window.text, { delimiter: ',', newline: window.newline, fastMode: false, preview: 1 })
    const row = result.data[0] ?? ['']
    const error = result.errors[0]?.code
    if (!error && row.every(value => !value.trim())) continue
    record++
    const rowId = `${source.path}#record=${record}`
    if (error) base.rejected.push({ rowId, reason: error })
    if (!headers) {
      const candidate = row.map(value => value.trim().toLowerCase())
      if (!error && spec.required.every(key => candidate.includes(key))) {
        if (new Set(candidate).size !== candidate.length || candidate.some(h => !h)) {
          base.error = 'invalid_csv_header'
          break
        }
        headers = candidate
      } else if (record >= LIMITS.headerRows) {
        base.error = 'csv_header_not_found'
        break
      }
      continue
    }
    if (error) continue
    if (row.length !== headers.length) { base.rejected.push({ rowId, reason: 'csv_column_count' }); continue }
    const fields = Object.fromEntries(headers.map((key, i) => [key, row[i].trim()]))
    if (spec.required.some(key => !fields[key])) { base.rejected.push({ rowId, reason: 'missing_required_field' }); continue }
    // Without a LinkedIn address, a hand-added person is identified by what was typed.
    const subject = spec.category !== 'connections' ? 'archive_owner_observation'
      : spec.optionalUrl && !fields.url ? `unlinked:added-person:${digest(JSON.stringify([fields['first name'], fields['last name'] ?? '', fields.company ?? '', fields.position ?? '']))}`
      : linkedinUrl(fields.url)
    if (!subject) { base.rejected.push({ rowId, reason: 'invalid_or_missing_linkedin_url' }); continue }
    base.accepted.push({ rowId, category: spec.category, subject, fields })
  }
  if (!headers && !base.error) base.error = 'csv_header_not_found'
  if (base.error) { base.accepted = []; base.rejected = [] }
  return base
}

export function parseArchive(input, filename) {
  const sources = unpackArchive(input, filename, { selectedOnly: true })
  const budget = { remaining: LIMITS.rows }
  const ignored = sources.filter(source => source.skippedEntry).map(source => source.skippedEntry)
  const receipts = sources.filter(source => !source.skippedEntry).map(source => {
    const receipt = parseSource(source, budget, 'archive_row_limit')
    if (receipt.error === 'archive_row_limit') fail('archive_row_limit')
    return { ...receipt, rawBytes: source.bytes }
  })
  if (ignored.length) {
    const source = { path: '__archive_manifest__/ignored-entries.json', bytes: Buffer.from(JSON.stringify({ version: 1, entries: ignored })) }
    receipts.push({ ...parseSource(source, budget), rawBytes: source.bytes, skippedFileCount: ignored.length })
  }
  return { parserVersion: PARSER_VERSION, archiveSha256: digest(input), sources: receipts }
}
