import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { investorFileInput, parseInvestorFile } from '../src/utils/private-import/investor-file.mjs'
import { fixture } from './helpers/investor-fixture.mjs'
import { workbook, workbookInput, worksheet, inline, XMLNS } from './helpers/investor-xlsx-fixture.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { exportAccountData, deleteAccountData } from '../src/utils/private-import/account-data.mjs'
const grant = (ownerId = 'alice', scope = 'owner_network_and_private_notes') => ({ ownerId, userId: ownerId, scope, agent: 'synthetic-xlsx',
  version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] })
const parse = (bytes, options = {}) => { const input = { ...workbookInput(bytes), ...options }; const file = investorFileInput(input); return parseInvestorFile(file.bytes, file.source, input.mapping, { inspectOnly: input.inspectOnly }) }

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
