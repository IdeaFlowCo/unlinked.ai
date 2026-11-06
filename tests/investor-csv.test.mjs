import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parseInvestorCsv } from '../src/utils/private-import/investor-csv.mjs'

test('investor CSV retains private source fields, comments and repeated people without guessing identity', () => {
  const csv = 'Name,LinkedIn,Comment,Other\n"Alex Doe",https://example.com/a,"Met in 2022, follow up",private\nAlex Doe,,Second meeting,more\n'
  const mapping = { name: 'Name', linkedinUrl: 'LinkedIn', notes: ['Comment'] }
  const parsed = parseInvestorCsv(Buffer.from(csv), mapping)
  assert.equal(parsed.accepted.length, 2)
  assert.equal(parsed.accepted[0].notes[0].text, 'Met in 2022, follow up')
  assert.equal(parsed.accepted[0].fields.Other, 'private')
  assert.notEqual(parsed.accepted[0].rowId, parsed.accepted[1].rowId)
  assert.deepEqual(parseInvestorCsv(Buffer.from(csv), mapping), parsed)
  assert.notEqual(parseInvestorCsv(Buffer.from(csv + 'Other,,,\n'), mapping).accepted[0].rowId, parsed.accepted[0].rowId)
})

test('requires unambiguous explicit mapping and reports bad rows without leaking data in errors', () => {
  const csv = Buffer.from('First,Last,Notes\nAda,Lovelace,hello\n,,no name\nGrace,Hopper\n')
  const parsed = parseInvestorCsv(csv, { firstName: 'First', lastName: 'Last', notes: ['Notes'] })
  assert.equal(parsed.accepted[0].name, 'Ada Lovelace')
  assert.deepEqual(parsed.rejected.map(row => row.reason), ['missing_name', 'csv_column_count'])
  assert.throws(() => parseInvestorCsv(Buffer.from('Name,name\na,b'), { name: 'Name' }), /csv_duplicate_header/)
  assert.throws(() => parseInvestorCsv(csv, { name: 'Missing' }), /csv_invalid_mapping/)
  assert.throws(() => parseInvestorCsv(csv, { name: 'First', notes: ['First'] }), /csv_invalid_mapping/)
  assert.throws(() => parseInvestorCsv(Buffer.from([0xff]), { name: 'Name' }), /csv_invalid_utf8/)
  assert.throws(() => parseInvestorCsv(Buffer.from('Name\n"unterminated'), { name: 'Name' }), /csv_invalid_format/)
})

test('keeps every record in a list larger than the graph detail limit', () => {
  const rows = Array.from({ length: 1001 }, (_, i) => `Investor ${i},"Line one\nLine two"`)
  const result = parseInvestorCsv(Buffer.from(['Name,Notes', ...rows].join('\n')), { name: 'Name', notes: ['Notes'] })
  assert.equal(result.accepted.length, 1001)
  assert.equal(new Set(result.accepted.map(row => row.rowId)).size, 1001)
  assert.equal(result.accepted[1000].notes[0].text, 'Line one\nLine two')
})

test('only valid LinkedIn addresses become exact-reference candidates; names never match people', () => {
  const csv = 'Name,URL\nAlex,https://www.linkedin.com/in/ALEx\nAlex,https://www.linkedin.com/in/alex/\nAlex,https://example.org/in/alex\nAlex,\n'
  const rows = parseInvestorCsv(Buffer.from(csv), { name: 'Name', linkedinUrl: 'URL' }).accepted
  const expected = createHash('sha256').update('alex').digest('hex')
  assert.deepEqual(rows[0].identity, { status: 'candidate', linkedinRefHash: expected })
  assert.deepEqual(rows[1].identity, rows[0].identity)
  assert.deepEqual(rows[2].identity, { status: 'invalid_linkedin_url' })
  assert.deepEqual(rows[3].identity, { status: 'unresolved' })
  assert.equal(rows[2].linkedinUrl, 'https://example.org/in/alex')
})
