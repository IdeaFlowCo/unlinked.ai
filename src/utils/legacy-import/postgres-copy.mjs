import { createHash } from 'node:crypto'

export const LEGACY_COLUMNS = Object.freeze(Object.fromEntries(Object.entries({
  companies: ['id', 'name', 'created_at'],
  institutions: ['id', 'name', 'created_at'],
  connections: ['id', 'profile_id_a', 'profile_id_b', 'created_at'],
  education: ['id', 'profile_id', 'institution_id', 'degree_name', 'started_on', 'finished_on', 'created_at'],
  positions: ['id', 'profile_id', 'company_id', 'title', 'description', 'started_on', 'finished_on', 'created_at'],
  profiles: ['id', 'user_id', 'full_name', 'headline', 'linkedin_slug', 'summary', 'industry', 'created_at', 'updated_at'],
  skills: ['id', 'profile_id', 'name', 'created_at'],
  uploads: ['id', 'profile_id', 'file_name', 'file_path', 'created_at'],
}).map(([table, columns]) => [table, Object.freeze(columns)])))
const fail = code => { throw new Error(code) }
const identifier = value => {
  if (/^"(?:[^"]|"")+"$/.test(value)) return value.slice(1, -1).replaceAll('""', '"')
  if (/^[a-z_][a-z0-9_]*$/.test(value)) return value
  fail('legacy_copy_identifier_invalid')
}
export function decodeCopyField(field) {
  if (field === '\\N') return null
  const chunks = []
  const escapes = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
  let start = 0
  for (let i = 0; i < field.length; i++) {
    if (field[i] !== '\\') continue
    chunks.push(Buffer.from(field.slice(start, i)))
    const character = field[++i]
    if (character === undefined) fail('legacy_copy_escape_incomplete')
    if (/[0-7]/.test(character)) {
      let digits = character
      while (digits.length < 3 && /[0-7]/.test(field[i + 1] ?? '')) digits += field[++i]
      const byte = parseInt(digits, 8)
      if (byte > 255) fail('legacy_copy_octal_invalid')
      chunks.push(Buffer.from([byte]))
    } else if (character === 'x') {
      let digits = ''
      while (digits.length < 2 && /[a-fA-F0-9]/.test(field[i + 1] ?? '')) digits += field[++i]
      if (!digits) fail('legacy_copy_hex_invalid')
      chunks.push(Buffer.from([parseInt(digits, 16)]))
    } else chunks.push(Object.hasOwn(escapes, character) ? Buffer.from([escapes[character]]) : Buffer.from(character))
    start = i + 1
  }
  chunks.push(Buffer.from(field.slice(start)))
  let result
  try { result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)) } catch { fail('legacy_copy_field_utf8_invalid') }
  if (result.includes('\0')) fail('legacy_copy_nul_invalid')
  return result
}

// Parse data, never execute SQL. Unknown schemas/tables remain opaque and are discarded.
export function parseLegacyCopy(source, { maxBytes = 64 * 1024 * 1024, maxLineBytes = 2 * 1024 * 1024, maxRowsPerTable = 1000000, maxCopySections = 256 } = {}) {
  for (const bound of [maxBytes, maxLineBytes, maxRowsPerTable, maxCopySections]) if (!Number.isSafeInteger(bound) || bound < 1) fail('legacy_copy_bound_invalid')
  if (!(typeof source === 'string' || Buffer.isBuffer(source) || source instanceof Uint8Array)) fail('legacy_copy_source_invalid')
  const sourceByteLength = typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength
  if (sourceByteLength > maxBytes) fail('legacy_copy_bytes_limit')
  const bytes = Buffer.from(source)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('legacy_copy_utf8_invalid') }
  const tables = Object.fromEntries(Object.keys(LEGACY_COLUMNS).map(table => [table, []]))
  const seen = new Set()
  let current = null, sections = 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const original of lines) {
    const line = original.endsWith('\r') ? original.slice(0, -1) : original
    if (Buffer.byteLength(line) > maxLineBytes) fail('legacy_copy_line_limit')
    if (current) {
      if (line === '\\.') { current = null; continue }
      current.rowOrdinal++
      if (current.rowOrdinal > maxRowsPerTable) fail('legacy_copy_rows_limit')
      if (!current.allowed) continue
      const fields = line.split('\t')
      if (fields.length !== current.columns.length) fail('legacy_copy_width_invalid')
      const record = Object.fromEntries(current.columns.map((column, index) => [column, decodeCopyField(fields[index])]))
      tables[current.table].push({ ...record, provenance: { table: `public.${current.table}`, rowOrdinal: current.rowOrdinal } })
      continue
    }
    if (!line.startsWith('COPY ')) continue
    if (++sections > maxCopySections) fail('legacy_copy_sections_limit')
    const header = /^COPY ((?:"(?:[^"]|"")+"|[a-z_][a-z0-9_]*))\.((?:"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)) \((.*)\) FROM stdin;$/.exec(line)
    if (!header) fail('legacy_copy_header_invalid')
    const schema = identifier(header[1]), table = identifier(header[2])
    const allowed = schema === 'public' && Object.hasOwn(LEGACY_COLUMNS, table)
    const columns = allowed ? header[3].split(',').map(value => identifier(value.trim())) : []
    if (allowed) {
      if (seen.has(table)) fail('legacy_copy_table_duplicate')
      seen.add(table)
      const expected = LEGACY_COLUMNS[table]
      if (columns.length !== expected.length || new Set(columns).size !== columns.length || columns.some(column => !expected.includes(column))) fail('legacy_copy_columns_invalid')
    }
    current = { table, columns, allowed, rowOrdinal: 0 }
  }
  if (current) fail('legacy_copy_unterminated')
  if (seen.size !== Object.keys(LEGACY_COLUMNS).length) fail('legacy_copy_table_missing')
  return { sourceSha256: createHash('sha256').update(bytes).digest('hex'), tables }
}
