import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture } from './helpers/investor-fixture.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION, effectiveAccountGrant } from '../mcp-server/account-grants.mjs'
import { INVESTOR_TOOLS } from '../mcp-server/investor-tools.mjs'
import { investorCatalogId, investorReceiptId } from '../src/utils/private-import/investor-job.mjs'
import { exportAccountData, deleteAccountData } from '../src/utils/private-import/account-data.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const grant = (ownerId = 'alice', privateNotes = true) => ({ ownerId, userId: ownerId, agent: 'test-agent', version: CURRENT_ACCOUNT_GRANT_VERSION,
  scope: privateNotes ? 'owner_network_and_private_notes' : 'owner_network', tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, privateNotes ? 'owner_network_and_private_notes' : 'owner_network')] })
const input = { csv: 'Name,LinkedIn,Comment\nMaya,https://www.linkedin.com/in/synthetic-maya,Met last year\nMaya,,Private fundraising notes\nMaya,,A different person\n', mapping: { name: 'Name', linkedinUrl: 'LinkedIn', notes: ['Comment'] }, listName: 'Previous investors' }

test('private CSV survives restart and lost receipt, keeps names separate and no connection edges', async () => {
  const f = fixture(), owner = grant(), tools = f.tools()
  const staged = await tools.unlinked_stage_investor_csv(owner, input)
  assert.equal(staged.status, 'staged'); assert.equal(staged.preview.valid, 3)
  assert.equal(f.state('alice').entities.size, 0)
  assert.equal((await tools.unlinked_stage_investor_csv(owner, { ...input, mapping: { notes: ['Comment'], linkedinUrl: 'LinkedIn', name: 'Name' } })).importId, staged.importId)
  f.failReceipt()
  await assert.rejects(tools.unlinked_resume_investor_import(owner, { importId: staged.importId, batchSize: 1 }), /synthetic_receipt_outage/)
  assert.equal(f.state('alice').links.size, 1)
  const replay = await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId, batchSize: 1 })
  assert.equal(replay.processed, 1); assert.equal(f.state('alice').links.size, 1)
  const complete = await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId })
  assert.equal(complete.status, 'complete'); assert.equal(complete.imported, 3)
  assert.equal(f.state('alice').entities.size, 4); assert.equal(f.state('alice').links.size, 3)
  assert.equal([...f.state('alice').notes.values()].filter(n => n.text.includes('Met last year')).length, 1)
  assert.ok([...f.state('alice').notes.values()].every(n => n.provenance.author === 'agent:test-agent'))
  let offset = 0, receipts = []
  do { const page = await tools.unlinked_get_investor_import(owner, { importId: staged.importId, offset, limit: 1 }); receipts.push(...page.receipts); offset = page.nextOffset } while (offset !== null)
  assert.equal(receipts.length, 3); assert.equal(receipts[0].fields.Comment, 'Met last year')
  assert.equal(new Set(receipts.map(r => r.result.entityId)).size, 3)
  await assert.rejects(tools.unlinked_get_investor_import(grant('bob'), { importId: staged.importId }), e => e.code === 'not_found')
  await assert.rejects(tools.unlinked_resume_investor_import(grant('bob'), { importId: staged.importId }), e => e.code === 'not_found')
  assert.equal(f.state('bob').entities.size, 0)
  const once = f.state('alice').entities.size
  await tools.unlinked_resume_investor_import(owner, { importId: staged.importId })
  assert.equal(f.state('alice').entities.size, once)
})

test('exact addresses match across imports; append retains independent source notes; rejected rows remain visible', async () => {
  const f = fixture(), tools = f.tools(), owner = grant()
  const first = await tools.unlinked_stage_investor_csv(owner, input)
  const done = await tools.unlinked_resume_investor_import(owner, { importId: first.importId })
  const next = await tools.unlinked_stage_investor_csv(owner, { ...input, listId: done.listId, csv: 'Name,LinkedIn,Comment\nAnother spelling,https://linkedin.com/in/SYNTHETIC-MAYA,New meeting\n,,No name\n' })
  const appended = await tools.unlinked_resume_investor_import(owner, { importId: next.importId })
  assert.equal(appended.status, 'partial'); assert.equal(appended.imported, 1); assert.equal(appended.rejected, 1)
  assert.equal(f.state('alice').entities.size, 4); assert.equal(f.state('alice').links.size, 3)
  assert.equal([...f.state('alice').entities.values()].find(e => e.refs.includes(`linkedin:in:${sha('synthetic-maya')}`)).name, 'Maya')
  assert.ok([...f.state('alice').notes.values()].some(n => n.text.includes('New meeting')))
  const page = await tools.unlinked_get_investor_import(owner, { importId: next.importId })
  assert.equal(page.receipts[1].result.reason, 'missing_name')
  assert.deepEqual(page.receipts[1].fields, { Name: '', LinkedIn: '', Comment: 'No name' })
  await assert.rejects(tools.unlinked_stage_investor_csv(grant('bob'), { ...input, listId: done.listId }), e => e.code === 'not_found')
})

test('rejected rows retain all source values in status', async () => {
  const tools = fixture().tools(), owner = grant(), oversized = 'x'.repeat(32769)
  const staged = await tools.unlinked_stage_investor_csv(owner, { csv: `Name,Notes\n,missing\nShort\nExtra,value,overflow\nLarge,${oversized}`, mapping: { name: 'Name' }, listName: 'Review' })
  await tools.unlinked_resume_investor_import(owner, { importId: staged.importId })
  const { receipts } = await tools.unlinked_get_investor_import(owner, { importId: staged.importId })
  assert.deepEqual(receipts.map(row => row.result.reason), ['missing_name', 'csv_column_count', 'csv_column_count', 'csv_field_size_limit'])
  assert.deepEqual(receipts.map(row => row.sourceValues), [['', 'missing'], ['Short'], ['Extra', 'value', 'overflow'], ['Large', oversized]])
  assert.deepEqual(receipts[2].fields, { Name: 'Extra', Notes: 'value' })
})

test('oversized metadata is rejected without storing a catalog or asset', async () => {
  const f = fixture(), first = 'a'.repeat(31000), second = 'b'.repeat(31000)
  await assert.rejects(f.tools().unlinked_stage_investor_csv(grant(), { csv: `${first},${second}\nAlice,note`, mapping: { name: first, notes: [second] }, listName: 'Review' }), e => e.code === 'invalid_input' && /metadata limit/.test(e.message))
  assert.equal(f.resources.size, 0)
  assert.equal(f.assets.size, 0)
})

test('source chunks preserve Unicode characters and UTF-16 offsets', async () => {
  const tools = fixture().tools(), owner = grant()
  const csv = `Name,Comment\nAlice,${'x'.repeat(32768 - 'Name,Comment\nAlice,'.length - 1)}😀end`
  const staged = await tools.unlinked_stage_investor_csv(owner, { csv, mapping: { name: 'Name' }, listName: 'Unicode' })
  const first = (await tools.unlinked_get_investor_import(owner, { importId: staged.importId, sourceOffset: 0 })).source
  assert.equal(first.nextOffset, 32767)
  const second = (await tools.unlinked_get_investor_import(owner, { importId: staged.importId, sourceOffset: first.nextOffset })).source
  assert.equal(first.text + second.text, csv)
  assert.ok(second.text.startsWith('😀'))
  assert.equal(second.nextOffset, null)
  await assert.rejects(tools.unlinked_get_investor_import(owner, { importId: staged.importId, sourceOffset: 32768 }), e => e.code === 'invalid_input')
})

test('private note chunks preserve Unicode characters at size boundaries', async () => {
  const f = fixture(), tools = f.tools(), owner = grant()
  const headerLength = `CSV ${'a'.repeat(64)} row 2 field 1\npart 1\n`.length
  const note = `${'x'.repeat(4000 - headerLength - 'Comment\n'.length - 1)}😀end`
  const staged = await tools.unlinked_stage_investor_csv(owner, { csv: `Name,Comment\nAlice,${note}`, mapping: { name: 'Name', notes: ['Comment'] }, listName: 'Unicode' })
  await tools.unlinked_resume_investor_import(owner, { importId: staged.importId })
  const chunks = [...f.state('alice').notes.values()].map(n => n.text)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every(text => text.length <= 4000 && !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(text)))
  assert.equal(chunks.map(text => text.replace(/^CSV [^\n]+\npart \d+\n/, '')).join(''), `Comment\n${note}`)
  assert.ok(chunks[1].includes('😀'))
})

test('revocation mid-batch and transient failure retain progress without claiming completion', async () => {
  const f = fixture(), tools = f.tools(), owner = grant()
  const staged = await tools.unlinked_stage_investor_csv(owner, input)
  f.failNote()
  await assert.rejects(tools.unlinked_resume_investor_import(owner, { importId: staged.importId }), /synthetic_outage/)
  assert.equal((await tools.unlinked_get_investor_import(owner, { importId: staged.importId })).processed, 0)
  let calls = 0
  await assert.rejects(tools.unlinked_resume_investor_import(owner, { importId: staged.importId }, undefined, async () => { if (++calls === 4) throw new AccountToolError('grant_revoked', 'revoked') }), e => e.code === 'grant_revoked')
  assert.equal((await tools.unlinked_resume_investor_import(owner, { importId: staged.importId })).status, 'complete')
})

test('private permission gates the real service and historical grant catalogs remain unchanged', async () => {
  const f = fixture(), service = createAccountToolService(f.options)
  for (const name of INVESTOR_TOOLS) {
    assert.ok(accountGrantTools(9, 'owner_network_and_private_notes').includes(name))
    assert.ok(!accountGrantTools(8, 'owner_network_and_private_notes').includes(name))
    assert.ok(!accountGrantTools(9, 'owner_network_and_write').includes(name))
    await assert.rejects(service.call({ grant: grant('alice', false), name, input: {} }), e => e.code === 'scope_not_granted')
  }
  const old = { version: 8, scope: 'owner_network_and_private_notes', tools: [...accountGrantTools(8, 'owner_network_and_private_notes')] }
  assert.ok(INVESTOR_TOOLS.every(name => effectiveAccountGrant(old).tools.includes(name)))
  const staged = (await service.call({ grant: grant(), name: 'unlinked_stage_investor_csv', input })).result
  assert.equal(staged.status, 'staged')
})

test('account export includes source and row receipts; deletion tombstones discoverable jobs and catalog', async () => {
  const f = fixture(), tools = f.tools(), owner = grant(), backend = await f.getBackend(owner)
  const staged = await tools.unlinked_stage_investor_csv(owner, input)
  await tools.unlinked_resume_investor_import(owner, { importId: staged.importId })
  const exported = await exportAccountData({ owner, backend, jobs: [] })
  assert.equal(exported.investorImports[0].csv, input.csv)
  assert.equal(exported.investorImports[0].receipts.length, 3)
  await deleteAccountData({ owner, backend, jobs: [] })
  for (const id of [staged.importId, investorCatalogId(owner.ownerId), investorReceiptId(owner.ownerId, staged.importId, 0)]) assert.equal((await backend.readResource('import', id)).deleted, true)
  await assert.rejects(tools.unlinked_resume_investor_import(owner, { importId: staged.importId }), e => e.code === 'not_found')
  await assert.rejects(tools.unlinked_stage_investor_csv(owner, input), e => e.code === 'not_found')
})

test('concurrent runtimes respect the durable lease and cannot double-count a batch', async () => {
  const f = fixture(), tools = f.tools(), owner = grant()
  const staged = await tools.unlinked_stage_investor_csv(owner, input)
  const pause = f.pauseNote()
  const first = tools.unlinked_resume_investor_import(owner, { importId: staged.importId, batchSize: 1 })
  await pause.entered
  await assert.rejects(f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId, batchSize: 1 }), e => e.code === 'import_busy')
  pause.release()
  assert.equal((await first).processed, 1)
  assert.equal(f.state('alice').links.size, 1)
  assert.equal((await f.tools().unlinked_resume_investor_import(owner, { importId: staged.importId })).imported, 3)
})
