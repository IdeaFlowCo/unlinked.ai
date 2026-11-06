import { createHash } from 'node:crypto'
import path from 'node:path'
import Papa from 'papaparse'
import { SaxesParser } from 'saxes'
import { unpackArchive } from './archive.mjs'
import { parseInvestorCsv, normalizeInvestorHeaders, INVESTOR_CSV_LIMITS } from './investor-csv.mjs'

export const INVESTOR_FILE_BYTES = 512 * 1024
export const XLSX_LIMITS = Object.freeze({ sheets: 100, cells: 200000, strings: 100000, nodes: 1000000, depth: 32 })
const MAIN = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'])
const REL = new Set(['http://schemas.openxmlformats.org/package/2006/relationships', 'http://purl.oclc.org/ooxml/package/relationships'])
const DOCREL = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const invalid = code => { throw new Error(code) }
const attr = (node, name) => Object.values(node.attributes).find(a => a.local === name && !a.uri)?.value
const relId = node => Object.values(node.attributes).find(a => a.local === 'id' && DOCREL.has(a.uri))?.value
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { invalid('file_invalid_utf8') } }
const decodeSpreadsheetText = value => value.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

// No DOM, entity loading, network access, formula engine, or filesystem extraction.
// The ZIP reader checks declared sizes before inflation and caps actual output.
function xml(bytes, root, namespace, handlers = {}) {
  if (!bytes) invalid('xlsx_missing_part')
  const parser = new SaxesParser({ xmlns: true }), stack = []
  let nodes = 0
  parser.on('error', () => invalid('xlsx_invalid_xml'))
  parser.on('doctype', () => invalid('xlsx_doctype_forbidden'))
  parser.on('opentag', node => {
    if (++nodes > XLSX_LIMITS.nodes || stack.length >= XLSX_LIMITS.depth) invalid('xlsx_xml_limit')
    if (!stack.length && (node.local !== root || !namespace.has(node.uri))) invalid('xlsx_invalid_part')
    stack.push(node)
    handlers.open?.(node, stack)
  })
  parser.on('text', text => handlers.text?.(text, stack))
  parser.on('cdata', text => handlers.text?.(text, stack))
  parser.on('closetag', node => { handlers.close?.(node, stack); stack.pop() })
  parser.write(decode(bytes)).close()
}
const main = node => node && MAIN.has(node.uri)
function packageInfo(bytes) {
  const files = new Map(unpackArchive(bytes, 'workbook.zip').map(file => [file.path, file.bytes]))
  const types = files.get('[Content_Types].xml')
  if (!types || /macroEnabled|vbaProject/i.test(decode(types)) || [...files.keys()].some(name => /\.bin$/i.test(name))) invalid('xlsx_macros_or_binary_parts_unsupported')
  const relations = new Map()
  xml(files.get('xl/_rels/workbook.xml.rels'), 'Relationships', REL, { open(node) {
    if (node.local !== 'Relationship' || !REL.has(node.uri)) return
    const id = attr(node, 'Id'), target = attr(node, 'Target'), type = attr(node, 'Type')
    if (!id || !target || !type || relations.has(id)) invalid('xlsx_invalid_relationship')
    if (type.endsWith('/externalLink')) invalid('xlsx_external_workbook_unsupported')
    if (attr(node, 'TargetMode') === 'External') { relations.set(id, { external: true, type }); return }
    if (/[\\\0?#]/.test(target) || target.includes(':')) invalid('xlsx_invalid_relationship')
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    if (!resolved.startsWith('xl/') || !files.has(resolved)) invalid('xlsx_missing_relationship_target')
    relations.set(id, { path: resolved, type })
  } })
  const sheets = [], names = new Set(), ids = new Set(), targets = new Set()
  xml(files.get('xl/workbook.xml'), 'workbook', MAIN, { open(node, stack) {
    if (node.local !== 'sheet' || !main(node) || stack.at(-2)?.local !== 'sheets') return
    const name = attr(node, 'name'), id = attr(node, 'sheetId'), relation = relations.get(relId(node))
    if (!name || name.length > 128 || !/^[1-9][0-9]{0,9}$/.test(id ?? '') || !relation || relation.external || !relation.type.endsWith('/worksheet')) invalid('xlsx_invalid_sheet')
    if (names.has(name) || ids.has(id) || targets.has(relation.path)) invalid('xlsx_duplicate_sheet')
    names.add(name); ids.add(id); targets.add(relation.path)
    sheets.push({ name, id, path: relation.path, state: attr(node, 'state') ?? 'visible' })
    if (sheets.length > XLSX_LIMITS.sheets) invalid('xlsx_sheet_limit')
  } })
  if (!sheets.length) invalid('xlsx_no_sheets')
  const shared = [...relations.values()].filter(r => r.type.endsWith('/sharedStrings'))
  if (shared.length > 1 || shared[0]?.external) invalid('xlsx_invalid_shared_strings')
  return { files, sheets, sharedPath: shared[0]?.path }
}
function stringsFor(book) {
  if (!book.sharedPath) return []
  const strings = []; let value = null
  xml(book.files.get(book.sharedPath), 'sst', MAIN, {
    open(node) { if (main(node) && node.local === 'si') { if (value !== null) invalid('xlsx_invalid_shared_strings'); value = '' } },
    text(text, stack) {
      if (value !== null && main(stack.at(-1)) && stack.at(-1).local === 't' && !stack.some(n => n.local === 'rPh')) {
        value += text
        if (value.length > INVESTOR_CSV_LIMITS.fieldChars) invalid('xlsx_cell_size_limit')
      }
    },
    close(node) { if (main(node) && node.local === 'si') { strings.push(decodeSpreadsheetText(value)); value = null; if (strings.length > XLSX_LIMITS.strings) invalid('xlsx_string_limit') } },
  })
  return strings
}
function sheetRows(book, selected) {
  const strings = stringsFor(book), rows = []
  let row = null, cell = null, count = 0, previous = 0, previousColumn = -1
  xml(book.files.get(selected.path), 'worksheet', MAIN, {
    open(node, stack) {
      if (!main(node)) return
      if (node.local === 'row' && stack.at(-2)?.local === 'sheetData') {
        const number = attr(node, 'r') === undefined ? previous + 1 : Number(attr(node, 'r'))
        if (row || !Number.isSafeInteger(number) || number <= previous || number > INVESTOR_CSV_LIMITS.rows + 1) invalid('xlsx_row_limit_or_order')
        row = { number, values: [] }; previous = number; previousColumn = -1
      } else if (node.local === 'c' && row && stack.at(-2)?.local === 'row') {
        if (cell || ++count > XLSX_LIMITS.cells) invalid('xlsx_cell_limit')
        const reference = attr(node, 'r'), match = reference?.match(/^([A-Z]{1,3})([1-9][0-9]*)$/)
        if (reference && (!match || Number(match[2]) !== row.number)) invalid('xlsx_invalid_cell_reference')
        const column = match ? [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 : previousColumn + 1
        if (column <= previousColumn || column >= INVESTOR_CSV_LIMITS.columns) invalid('xlsx_column_limit_or_order')
        previousColumn = column
        cell = { column, type: attr(node, 't') ?? 'n', value: '', inline: '', valueNodes: 0 }
      } else if (cell && node.local === 'f') invalid('xlsx_formula_unsupported')
      else if (cell && node.local === 'v' && ++cell.valueNodes > 1) invalid('xlsx_invalid_cell')
    },
    text(text, stack) {
      if (!cell || !main(stack.at(-1))) return
      const node = stack.at(-1)
      if (node.local === 'v') cell.value += text
      if (node.local === 't' && stack.some(n => n.local === 'is') && !stack.some(n => n.local === 'rPh')) cell.inline += text
      if (cell.value.length > INVESTOR_CSV_LIMITS.fieldChars || cell.inline.length > INVESTOR_CSV_LIMITS.fieldChars) invalid('xlsx_cell_size_limit')
    },
    close(node) {
      if (!main(node)) return
      if (node.local === 'c' && cell) {
        let value = cell.value
        if (cell.type === 's') {
          if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) >= strings.length) invalid('xlsx_invalid_string_index')
          value = strings[Number(value)]
        } else if (cell.type === 'inlineStr') value = decodeSpreadsheetText(cell.inline)
        else if (cell.type === 'b') { if (!['0', '1'].includes(value)) invalid('xlsx_invalid_boolean'); value = value === '1' ? 'TRUE' : 'FALSE' }
        else if (!['n', 'str', 'd'].includes(cell.type)) invalid('xlsx_cell_type_unsupported')
        while (row.values.length < cell.column) row.values.push('')
        row.values.push(value); cell = null
      } else if (node.local === 'row' && row) {
        // Excel commonly serializes styled but empty cells beyond a table.
        // They are not additional data columns; retain interior empty cells.
        while (row.values.length && row.values.at(-1) === '') row.values.pop()
        if (row.values.some(value => value.trim())) rows.push(row)
        row = null
      }
    },
  })
  return rows
}

export function investorFileInput({ csv, fileBase64, filename, sheet, headerRow = 1 }) {
  if ((typeof csv === 'string') === (typeof fileBase64 === 'string')) invalid('file_choose_csv_or_base64')
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 100000) invalid('file_invalid_header_row')
  if (filename !== undefined && (typeof filename !== 'string' || !filename.length || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename))) invalid('file_invalid_filename')
  let bytes
  if (fileBase64 !== undefined) {
    if (!filename) invalid('file_filename_required')
    if (fileBase64.length > Math.ceil(INVESTOR_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fileBase64)) invalid('file_invalid_base64')
    bytes = Buffer.from(fileBase64, 'base64')
    if (bytes.toString('base64') !== fileBase64) invalid('file_invalid_base64')
  } else bytes = Buffer.from(csv, 'utf8')
  if (!bytes.length || bytes.length > INVESTOR_FILE_BYTES) invalid('file_size_limit')
  filename ??= 'investors.csv'
  const format = /\.xlsx$/i.test(filename) ? 'xlsx' : /\.csv$/i.test(filename) ? 'csv' : invalid('file_unsupported_format')
  if (format === 'xlsx' && csv !== undefined) invalid('xlsx_requires_base64')
  if (format === 'csv' && (sheet !== undefined || headerRow !== 1)) invalid('csv_sheet_options_unsupported')
  return { bytes, source: { format, filename, ...(format === 'xlsx' ? { sheet, headerRow } : {}) } }
}

export function parseInvestorFile(bytes, source, mapping, { inspectOnly = false } = {}) {
  const sourceDigest = sha(bytes)
  if (source?.format !== 'xlsx') {
    if (!inspectOnly) return parseInvestorCsv(bytes, mapping)
    const parsed = Papa.parse(decode(bytes).replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', dynamicTyping: false })
    const headers = normalizeInvestorHeaders(parsed.data[0] ?? [])
    if (headers.length > INVESTOR_CSV_LIMITS.columns || headers.some(v => v.length > INVESTOR_CSV_LIMITS.fieldChars) || Buffer.byteLength(JSON.stringify(headers)) > 60000) invalid('csv_invalid_header')
    return { sourceDigest, format: 'csv', headers, retained: false }
  }
  const book = packageInfo(bytes)
  const inventory = { sourceDigest, format: 'xlsx', sheets: book.sheets, retained: false }
  if (source.sheet === undefined) { if (inspectOnly) return inventory; invalid('xlsx_sheet_selection_required') }
  const selected = book.sheets.find(s => s.name === source.sheet)
  if (!selected) invalid('xlsx_sheet_not_found')
  const rows = sheetRows(book, selected), headerIndex = rows.findIndex(row => row.number === source.headerRow)
  if (headerIndex < 0) invalid('xlsx_header_row_missing')
  const table = rows.slice(headerIndex), width = table[0].values.length
  if (Buffer.byteLength(JSON.stringify(table[0].values)) > 60000) invalid('xlsx_header_size_limit')
  for (const row of table) while (row.values.length < width) row.values.push('')
  if (inspectOnly) return { ...inventory, selectedSheet: selected, headerRow: source.headerRow, headers: normalizeInvestorHeaders(table[0].values), dataRows: table.length - 1 }
  const csv = Papa.unparse(table.map(row => row.values))
  if (Buffer.byteLength(csv) > INVESTOR_CSV_LIMITS.bytes) invalid('xlsx_table_size_limit')
  const parsed = parseInvestorCsv(Buffer.from(csv), mapping)
  for (const row of [...parsed.accepted, ...parsed.rejected]) {
    row.row = table[row.row - 1].number
    row.rowId = sha(`investor-xlsx-v1\n${sourceDigest}\n${selected.id}\n${selected.path}\n${row.row}`)
  }
  return { ...parsed, sourceDigest, parserVersion: 'investor-xlsx-v1', selectedSheet: selected }
}
