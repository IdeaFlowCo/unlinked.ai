import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Papa from 'papaparse'
import { investorFileInput, parseInvestorFile } from '../src/utils/private-import/investor-file.mjs'
import { fixture } from './helpers/investor-fixture.mjs'
import { workbook, workbookInput, worksheet, inline, XMLNS } from './helpers/investor-xlsx-fixture.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { exportAccountData, deleteAccountData } from '../src/utils/private-import/account-data.mjs'
const grant = (ownerId = 'alice', scope = 'owner_network_and_private_notes') => ({ ownerId, userId: ownerId, scope, agent: 'synthetic-xlsx',
  version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] })
const parse = (bytes, options = {}) => { const input = { ...workbookInput(bytes), ...options }; const file = investorFileInput(input); return parseInvestorFile(file.bytes, file.source, input.mapping, { inspectOnly: input.inspectOnly }) }
const hyperlinkPart = 'xl/worksheets/_rels/sheet1.xml.rels'
const linkedSheet = (cells, links) => worksheet(cells).replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ').replace('</worksheet>', `<hyperlinks>${links}</hyperlinks></worksheet>`)
const linkedWorkbook = (target = 'https://www.linkedin.com/in/Synthetic-Maya', overrides = {}) => workbook({
  'xl/worksheets/sheet1.xml': linkedSheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row><row r="2">${inline('A2', 'Synthetic Maya')}${inline('B2', 'Profile')}</row>`, '<hyperlink ref="B2" r:id="profile"/>'),
  [hyperlinkPart]: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="profile" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`,
  ...overrides,
})
const linkedInput = bytes => ({ ...workbookInput(bytes), mapping: { name: 'Name', linkedinUrl: 'LinkedIn' } })

test('formula refusal names the cell and offers values-only recovery without echoing formula data or writing', async () => {
  const bytes = await workbook({ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row><row r="2">${inline('A2', 'Person')}<c r="B2"><f>HYPERLINK("https://linkedin.com/in/private-formula-person","Private Name")</f><v>Private Name</v></c></row>`) })
  for (const inspectOnly of [false, true]) {
    const f = fixture()
    await assert.rejects(f.tools().unlinked_stage_investor_csv(grant(), { ...linkedInput(bytes), inspectOnly }), error => {
      assert.equal(error.code, 'invalid_input')
      assert.deepEqual(error.details, { failureReason: 'xlsx_formula_unsupported', cell: 'B2', row: 2, column: 2, recovery: 'values_only_export' })
      assert.match(error.message, /cell B2/); assert.match(error.message, /values-only CSV/)
      assert.match(error.message, /actual LinkedIn URL/); assert.doesNotMatch(error.message, /private-formula-person|Private Name/)
      return true
    })
    assert.equal(f.resources.size, 0); assert.equal(f.assets.size, 0)
  }
})

test('mapped LinkedIn hyperlink supplies exact identity while original text, private source and replay stay intact', async () => {
  const bytes = await linkedWorkbook('https://linkedin.com/in/Synthetic-Maya/'), f = fixture(), owner = grant(), input = linkedInput(bytes)
  const result = parse(bytes, input)
  assert.equal(result.parserVersion, 'investor-xlsx-v2')
  assert.equal(result.accepted[0].fields.LinkedIn, 'Profile')
  const hash = createHash('sha256').update('synthetic-maya').digest('hex')
  assert.equal(result.accepted[0].identity.linkedinRefHash, hash)
  assert.equal(result.accepted[0].linkedinUrl, 'https://www.linkedin.com/in/Synthetic-Maya')
  const staged = await f.tools().unlinked_stage_investor_csv(owner, input)
  assert.equal((await f.tools().unlinked_stage_investor_csv(owner, input)).importId, staged.importId)
  await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId })
  await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId })
  const state = f.state('alice'), person = [...state.entities.values()].find(e => e.kind === 'person')
  assert.ok(person.refs.includes(`linkedin:in:${hash}`)); assert.equal(state.links.size, 1)
  const status = await f.tools().unlinked_get_investor_import(owner, { importId: staged.importId })
  assert.equal(status.receipts[0].fields.LinkedIn, 'Profile')
  assert.deepEqual(status.receipts[0].sourceHyperlink, { cell: 'B2', relationshipId: 'profile', part: hyperlinkPart, target: 'https://linkedin.com/in/Synthetic-Maya/' })
  await assert.rejects(f.tools().unlinked_get_investor_import(grant('bob'), { importId: staged.importId }), error => error.code === 'not_found')
  assert.deepEqual(f.assets.get(`alice:${staged.sourceDigest}`), bytes)
})

test('hyperlinks never change names or notes and conflicting or non-LinkedIn identity targets fail before writes', async () => {
  const nonIdentity = await linkedWorkbook('javascript:alert(1)')
  const ordinary = parse(nonIdentity, { mapping: { name: 'Name', notes: ['LinkedIn'] } })
  assert.equal(ordinary.accepted[0].notes[0].text, 'Profile')
  assert.equal(ordinary.accepted[0].identity.status, 'unresolved')
  const conflict = await linkedWorkbook(undefined, { 'xl/worksheets/sheet1.xml': linkedSheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row><row r="2">${inline('A2', 'Person')}${inline('B2', 'https://www.linkedin.com/in/another-person')}</row>`, '<hyperlink ref="B2" r:id="profile"/>') })
  const missingName = await linkedWorkbook('javascript:alert(1)', { 'xl/worksheets/sheet1.xml': linkedSheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row><row r="2">${inline('B2', 'Profile')}</row>`, '<hyperlink ref="B2" r:id="profile"/>') })
  const emptyRow = await linkedWorkbook('javascript:alert(1)', { 'xl/worksheets/sheet1.xml': linkedSheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row>`, '<hyperlink ref="B2" r:id="profile"/>') })
  for (const [bytes, code] of [[nonIdentity, 'xlsx_hyperlink_target_unsupported'], [missingName, 'xlsx_hyperlink_target_unsupported'], [emptyRow, 'xlsx_hyperlink_target_unsupported'], [conflict, 'xlsx_hyperlink_identity_conflict']]) {
    const f = fixture()
    await assert.rejects(f.tools().unlinked_stage_investor_csv(grant(), linkedInput(bytes)), new RegExp(code))
    assert.equal(f.resources.size, 0); assert.equal(f.assets.size, 0)
  }
})

test('hyperlink XML and reference bounds fail closed without following external targets', async () => {
  for (const reference of ['B2:C2', 'XFD1048576', 'B999999', 'B0']) {
    const bytes = await linkedWorkbook(undefined, { 'xl/worksheets/sheet1.xml': linkedSheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'LinkedIn')}</row><row r="2">${inline('A2', 'Person')}</row>`, `<hyperlink ref="${reference}" r:id="profile"/>`) })
    assert.throws(() => parse(bytes, linkedInput(bytes)), /xlsx_(invalid_hyperlink_reference|hyperlink_limit)/)
  }
  const bytes = await linkedWorkbook(undefined, { [hyperlinkPart]: '<!DOCTYPE Relationships [<!ENTITY bomb "bad">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' })
  assert.throws(() => parse(bytes, linkedInput(bytes)), /xlsx_doctype_forbidden/)
})

test('old XLSX jobs keep v1 text-only parsing during resume and receipt recovery', async () => {
  const bytes = await linkedWorkbook(), input = linkedInput(bytes), file = investorFileInput(input)
  const old = parseInvestorFile(file.bytes, file.source, input.mapping, { parserVersion: 'investor-xlsx-v1' })
  assert.equal(old.accepted[0].identity.status, 'invalid_linkedin_url'); assert.equal(old.accepted[0].sourceHyperlink, undefined)
  const f = fixture(), owner = grant(), staged = await f.tools().unlinked_stage_investor_csv(owner, input)
  // Synthetic persisted pre-upgrade job: its recorded parser controls resumption.
  f.resources.get(`alice:${staged.importId}`).payload.parserVersion = 'investor-xlsx-v1'
  await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId })
  const person = [...f.state('alice').entities.values()].find(e => e.kind === 'person')
  assert.ok(person.refs.every(ref => !ref.startsWith('linkedin:in:')))
  const status = await f.tools().unlinked_get_investor_import(owner, { importId: staged.importId })
  assert.equal(status.receipts[0].rowId, old.accepted[0].rowId)
  assert.equal(status.receipts[0].sourceHyperlink, undefined)
})

test('workbook discovery is read-only; exact tab selection and full-original retention acknowledgement precede storage', async () => {
  const f = fixture(), tools = f.tools(), owner = grant(), input = workbookInput(await workbook())
  const inventory = await tools.unlinked_stage_investor_csv(owner, { fileBase64: input.fileBase64, filename: input.filename, inspectOnly: true })
  assert.equal(inventory.retained, false)
  assert.deepEqual(inventory.sheets.map(s => [s.name, s.state]), [['Previous investors', 'visible'], ['Private other tab', 'hidden']])
  assert.match(inventory.disclosure, /entire original workbook.*unselected and hidden sheets/)
  assert.equal(f.resources.size, 0); assert.equal(f.assets.size, 0)
  for (const [change, error] of [[{ sheet: undefined }, /sheet_selection_required/], [{ sheet: 'previous investors' }, /sheet_not_found/], [{ retainOriginalConfirmed: undefined }, /retainOriginalConfirmed/], [{ listName: undefined }, /listName/]]) {
    await assert.rejects(tools.unlinked_stage_investor_csv(owner, { ...input, ...change }), error)
    assert.equal(f.resources.size, 0); assert.equal(f.assets.size, 0)
  }
  const preview = await tools.unlinked_stage_investor_csv(owner, { ...input, inspectOnly: true })
  assert.deepEqual(preview.headers, ['Name', 'Comment']); assert.equal(preview.dataRows, 2)
})

test('selected XLSX sheet keeps physical rows, private original bytes, restart/replay, owner fences and account lifecycle', async () => {
  const bytes = await workbook({ 'customXml/synthetic-padding.txt': randomBytes(80000).toString('base64') }), input = workbookInput(bytes), f = fixture(), owner = grant()
  assert.ok(bytes.length > 32768)
  const service = () => createAccountToolService(f.options)
  const call = async (name, args, caller = owner) => (await service().call({ grant: caller, name, input: args })).result
  const staged = await call('unlinked_stage_investor_csv', input)
  assert.equal(staged.sourceDigest, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(staged.sourceFile.selectedSheet.name, 'Previous investors')
  assert.equal(staged.importId, (await call('unlinked_stage_investor_csv', input)).importId)
  assert.equal((await call('unlinked_resume_investor_import', { importId: staged.importId, batchSize: 1 })).processed, 1)
  f.failReceipt()
  await assert.rejects(call('unlinked_resume_investor_import', { importId: staged.importId }), /synthetic_receipt_outage/)
  assert.equal((await call('unlinked_resume_investor_import', { importId: staged.importId })).status, 'complete')
  await call('unlinked_resume_investor_import', { importId: staged.importId })
  const state = f.state('alice')
  assert.equal(state.links.size, 2)
  assert.deepEqual([...state.entities.values()].filter(e => e.kind === 'person').map(e => e.name), ['Synthetic Maya', 'Synthetic Jules'])
  assert.ok([...state.notes.values()].every(n => n.provenance.author === 'agent:synthetic-xlsx'))
  assert.ok([...state.notes.values()].some(n => n.text.includes(`XLSX ${staged.importId} sheet 1 row 2`)))
  const status = await call('unlinked_get_investor_import', { importId: staged.importId })
  assert.deepEqual(status.receipts.map(r => r.sourceRow), [2, 5])
  assert.equal(status.receipts[1].fields.Comment, '')
  assert.equal(status.receipts[0].sourceSheet.id, '1')
  const recovered = []; let sourceOffset = 0
  do { const chunk = await call('unlinked_get_investor_import', { importId: staged.importId, sourceOffset }); assert.equal(chunk.source.offsetUnit, 'bytes'); recovered.push(Buffer.from(chunk.source.base64, 'base64')); sourceOffset = chunk.source.nextOffset } while (sourceOffset !== null)
  assert.deepEqual(Buffer.concat(recovered), bytes)
  assert.ok(recovered.length > 1)
  await assert.rejects(call('unlinked_get_investor_import', { importId: staged.importId, sourceOffset: bytes.length + 1 }), e => e.code === 'invalid_input')
  for (const name of ['unlinked_get_investor_import', 'unlinked_resume_investor_import']) await assert.rejects(call(name, { importId: staged.importId }, grant('bob')), e => e.code === 'not_found')
  await assert.rejects(call('unlinked_stage_investor_csv', { ...input, listId: staged.listId ?? [...state.entities.values()].find(e => e.kind === 'list').id }, grant('bob')), e => e.code === 'not_found')
  for (const scope of ['owner_network', 'owner_network_and_write']) await assert.rejects(call('unlinked_stage_investor_csv', { ...input, inspectOnly: true }, grant('alice', scope)), e => e.code === 'scope_not_granted')
  const backend = await f.getBackend(owner), exported = await exportAccountData({ owner, backend, jobs: [] })
  assert.deepEqual(Buffer.from(exported.investorImports[0].originalFile.base64, 'base64'), bytes)
  assert.equal(exported.investorImports[0].job.disclosure.originalWorkbookRetentionConfirmed, true)
  const second = await call('unlinked_stage_investor_csv', { ...input, sheet: 'Private other tab' })
  assert.notEqual(second.importId, staged.importId)
  assert.notEqual((await call('unlinked_get_investor_import', { importId: second.importId })).receipts[0].rowId, status.receipts[0].rowId)
  await deleteAccountData({ owner, backend, jobs: [] })
  await assert.rejects(call('unlinked_get_investor_import', { importId: staged.importId }), e => e.code === 'not_found')
})

test('shared and inline strings, explicit later header row, sparse cells and typed values preserve data', async () => {
  const base = await workbook(), zip = await (await import('jszip')).default.loadAsync(base)
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const bytes = await workbook({
    'xl/_rels/workbook.xml.rels': rels.replace('</Relationships>', '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    'xl/sharedStrings.xml': `<sst xmlns="${XMLNS}"><si><r><t>Synthetic </t></r><r><t>Shared</t></r><rPh><t>ignored</t></rPh></si></sst>`,
    'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Title, not headers')}</row><row r="3">${inline('A3', 'Name')}${inline('B3', 'Comment')}</row><row r="7"><c r="A7" t="s"><v>0</v></c><c r="B7" t="b"><v>1</v></c></row>`),
  })
  const result = parse(bytes, { headerRow: 3 })
  assert.equal(result.accepted[0].name, 'Synthetic Shared')
  assert.equal(result.accepted[0].row, 7)
  assert.equal(result.accepted[0].notes[0].text, 'TRUE')
})

test('inspection headers map to staged CSV and XLSX rows and spreadsheet escapes decode once', async () => {
  const csv = Buffer.from('\n Name , Comment \nAda,private\n')
  const csvSource = { format: 'csv' }
  const csvHeaders = parseInvestorFile(csv, csvSource, undefined, { inspectOnly: true }).headers
  assert.deepEqual(csvHeaders, ['Name', 'Comment'])
  assert.equal(parseInvestorFile(csv, csvSource, { name: csvHeaders[0], notes: [csvHeaders[1]] }).accepted[0].notes[0].text, 'private')

  const base = await workbook(), zip = await (await import('jszip')).default.loadAsync(base)
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const bytes = await workbook({
    'xl/_rels/workbook.xml.rels': rels.replace('</Relationships>', '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    'xl/sharedStrings.xml': `<sst xmlns="${XMLNS}"><si><t>Shared_x000D_line _x005F_x0041_</t></si></sst>`,
    'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', ' Name ')}${inline('B1', ' Comment ')}</row><row r="2">${inline('A2', 'Ada')}<c r="B2" t="s"><v>0</v></c></row><row r="3">${inline('A3', 'Grace')}${inline('B3', 'Inline_x000D_line _x005F_x0041_')}</row>`),
  })
  const headers = parse(bytes, { inspectOnly: true }).headers
  assert.deepEqual(headers, ['Name', 'Comment'])
  const result = parse(bytes, { mapping: { name: headers[0], notes: [headers[1]] } })
  assert.deepEqual(result.accepted.map(row => row.notes[0].text), ['Shared\rline _x0041_', 'Inline\rline _x0041_'])
})

test('shared-string and sparse-table amplification is rejected before serialization for inspection and staging', async t => {
  const original = await workbook(), zip = await (await import('jszip')).default.loadAsync(original)
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const repeated = await workbook({
    'xl/_rels/workbook.xml.rels': rels.replace('</Relationships>', '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    'xl/sharedStrings.xml': `<sst xmlns="${XMLNS}"><si><t>${'🙂"'.repeat(6000)}</t></si></sst>`,
    'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}</row>` + Array.from({ length: 300 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>0</v></c></row>`).join('')),
  })
  const columnName = i => i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26)
  const header = Array.from({ length: 256 }, (_, i) => inline(`${columnName(i)}1`, i ? `Column ${i}` : 'Name')).join('')
  const sparse = await workbook({ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${header}</row>` + Array.from({ length: 900 }, (_, i) => `<row r="${i + 2}">${inline(`A${i + 2}`, 'Person')}</row>`).join('')) })
  const unparse = t.mock.method(Papa, 'unparse', () => { throw Error('serialization_before_bound') })
  for (const bytes of [repeated, sparse]) {
    assert.ok(bytes.length < 512 * 1024)
    for (const inspectOnly of [false, true]) assert.throws(() => parse(bytes, { inspectOnly, mapping: { name: 'Name' } }), /xlsx_table_size_limit/)
  }
  assert.equal(unparse.mock.callCount(), 0)
})

test('escaped Unicode pairs and string cells remain exact; malformed escaped surrogates are refused', async () => {
  const bytes = await workbook({ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'Comment')}</row><row r="2">${inline('A2', 'Person')}<c r="B2" t="str"><v>_xD83D__xDE42_ _x005F_x0041_</v></c></row>`) })
  assert.equal(parse(bytes).accepted[0].notes[0].text, '🙂 _x0041_')
  for (const text of ['_xD800_', '_xDC00_', '_xD800_X']) {
    const bad = await workbook({ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}</row><row r="2">${inline('A2', text)}</row>`) })
    assert.throws(() => parse(bad, { mapping: { name: 'Name' } }), /xlsx_invalid_text_escape/)
  }
})

test('unsupported or malicious workbook inputs fail before any durable write', async () => {
  const normal = await workbook(), zip = await (await import('jszip')).default.loadAsync(normal)
  const wb = await zip.file('xl/workbook.xml').async('string'), rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const cases = [
    [{ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}</row><row r="2"><c r="A2"><f>WEBSERVICE("https://synthetic.invalid")</f><v>1</v></c></row>`) }, /formula_unsupported/],
    [{ 'xl/workbook.xml': '<!DOCTYPE workbook [<!ENTITY x "bad">]>' + wb }, /doctype_forbidden/],
    [{ 'xl/workbook.xml': wb.replace('</sheets>', '<sheet name="Previous investors" sheetId="3" r:id="rId2"/></sheets>') }, /duplicate_sheet/],
    [{ 'xl/workbook.xml': wb.slice(0, -12) }, /invalid_xml/],
    [{ 'xl/_rels/workbook.xml.rels': rels.replace('Target="worksheets/sheet1.xml"', 'Target="https://synthetic.invalid" TargetMode="External"') }, /invalid_sheet/],
    [{ 'xl/vbaProject.bin': Buffer.from('synthetic') }, /macros_or_binary/],
    [{ 'xl/worksheets/sheet1.xml': worksheet('<row r="1000000000"/>') }, /row_limit/],
    [{ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('XFD1', 'Name')}</row>`) }, /column_limit/],
    [{ 'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}${inline('A1', 'Again')}</row>`) }, /column_limit_or_order/],
    [{ 'xl/worksheets/sheet1.xml': worksheet('<row r="1"><c r="A1" t="s"><v>999999</v></c></row>') }, /invalid_string_index/],
    [{ 'xl/worksheets/sheet1.xml': ' '.repeat(8 * 1024 * 1024 + 1) }, /zip_expansion_limit/],
  ]
  for (const [overrides, error] of cases) {
    const f = fixture()
    await assert.rejects(f.tools().unlinked_stage_investor_csv(grant(), workbookInput(await workbook(overrides))), error)
    assert.equal(f.resources.size, 0); assert.equal(f.assets.size, 0)
  }
  for (const args of [{ ...workbookInput(normal), csv: 'Name\nA' }, { ...workbookInput(normal), fileBase64: 'not base64' }, { ...workbookInput(normal), filename: '../unsafe.xlsx' }, { ...workbookInput(normal), filename: 'file.xls' }, { ...workbookInput(normal), fileBase64: Buffer.alloc(512 * 1024 + 1).toString('base64') }]) assert.throws(() => investorFileInput(args))
})
