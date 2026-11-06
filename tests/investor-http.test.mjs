import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { fixture } from './helpers/investor-fixture.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createIdeaflowConnectorHandler } from '../mcp-server/ideaflow-connector.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { workbook, workbookInput } from './helpers/investor-xlsx-fixture.mjs'

test('escaped CSV crosses REST, direct MCP and signed shared connector within bounded source limits', async t => {
  const f = fixture(), owner = { ownerId: 'alice', userId: 'alice' }, scope = 'owner_network_and_private_notes'
  const grant = { ...owner, grantId: 'synthetic', scope, version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] }
  const service = createAccountToolService({ ...f.options, complete: async () => { throw Error('no AI') } })
  const secret = 'synthetic-connector-boundary-only-'.repeat(2)
  let handlers
  const server = createServer((req, res) => handlers[req.url.startsWith('/api/agent/') ? 'rest' : req.url.slice(1)](req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`, origin = base.replace('http:', 'https:')
  const authenticateGrant = async req => req.headers.authorization === 'Bearer synthetic-direct' ? grant : null
  const options = { origin, service, authenticateGrant, getBackend: f.getBackend, complete: async () => ({}) }
  handlers = {
    rest: createAccountAgentApiHandler({ ...options, authenticateGrantDetailed: async req => ({ grant: await authenticateGrant(req) }) }),
    direct: createAccountHostedHandler(options),
    shared: createIdeaflowConnectorHandler({ ...options, secret, resolveOwner: async () => owner }),
  }
  function signed(body, scopes = 'unlinked:read unlinked:private_notes') {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://www.unlinked.ai/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: 'alice', scope: scopes, iat: now, exp: now + 60, jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url')
    return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
  }
  async function request(surface, input, tool = 'unlinked_stage_investor_csv', scopes) {
    const body = JSON.stringify(surface === 'rest' ? input : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } })
    return fetch(`${base}/${surface === 'rest' ? 'api/agent/v1/private/investor-imports' : surface}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${surface === 'shared' ? signed(body, scopes) : 'synthetic-direct'}` }, body })
  }
  const csv = 'Name,Extra\n' + Array.from({ length: 20 }, (_, i) => `Person ${i},${'\u0001'.repeat(20000)}`).join('\n')
  assert.ok(Buffer.byteLength(csv) < 512 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(csv)) > 1024 * 1024)
  for (const surface of ['rest', 'direct', 'shared']) {
    const response = await request(surface, { csv, mapping: { name: 'Name' }, listName: surface })
    assert.equal(response.status, 200, surface)
    const body = await response.json(), staged = surface === 'rest' ? body : JSON.parse(body.result.content[0].text)
    assert.equal(staged.status, 'staged', surface)
    const status = await service.call({ grant, name: 'unlinked_get_investor_import', input: { importId: staged.importId } })
    assert.ok(Buffer.byteLength(status.text) < 1024 * 1024)
    assert.ok(status.result.receipts.length > 0 && status.result.receipts.length < 20)
    assert.ok(status.result.nextOffset > 0)
    const oversized = await request(surface, { csv: 'x'.repeat(512 * 1024 + 1), mapping: { name: 'Name' }, listName: surface })
    const denied = await oversized.json()
    assert.ok(surface === 'rest' ? denied.error : denied.result?.isError || denied.error)
  }
  assert.equal((await request('shared', { query: '\u0001'.repeat(200000) }, 'unlinked_whoami')).status, 413)
  const xlsx = workbookInput(await workbook())
  for (const surface of ['rest', 'direct', 'shared']) {
    const inspection = await request(surface, { fileBase64: xlsx.fileBase64, filename: xlsx.filename, inspectOnly: true })
    assert.equal(inspection.status, 200)
    const body = await inspection.json(), inventory = surface === 'rest' ? body : JSON.parse(body.result.content[0].text)
    assert.equal(inventory.sheets.length, 2); assert.equal(inventory.retained, false)
    const response = await request(surface, { ...xlsx, listName: `Workbook ${surface}` })
    assert.equal(response.status, 200)
    const data = await response.json(), staged = surface === 'rest' ? data : JSON.parse(data.result.content[0].text)
    assert.equal(staged.status, 'staged'); assert.equal(staged.sourceFile.selectedSheet.name, xlsx.sheet)
  }
  assert.equal((await request('shared', { csv, mapping: { name: 'Name' }, listName: 'denied' }, 'unlinked_stage_investor_csv', 'unlinked:read')).status, 413)
  for (const surface of ['rest', 'shared']) assert.ok((await request(surface, { csv: '\u0001'.repeat(750000) })).status >= 400)
})

test('oversized original rows have exact owner-only chunk recovery through the existing status tool', async () => {
  const f = fixture(), owner = { ownerId: 'alice', userId: 'alice' }, scope = 'owner_network_and_private_notes'
  const grant = { ...owner, scope, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] }
  const service = createAccountToolService({ ...f.options, complete: async () => ({}) })
  const csv = 'Name,Extra\nA,' + '\u0001'.repeat(100000) + '🙂end'
  const staged = (await service.call({ grant, name: 'unlinked_stage_investor_csv', input: { csv, mapping: { name: 'Name' }, listName: 'Oversized rejected row' } })).result
  const status = (await service.call({ grant, name: 'unlinked_get_investor_import', input: { importId: staged.importId } })).result
  assert.equal(status.receipts[0].fields, null)
  assert.equal(status.receipts[0].sourceRecovery.reason, 'encoded_row_limit')
  assert.equal(status.receipts[0].result.status, 'rejected')
  let sourceOffset = 0, recovered = ''
  do {
    const chunk = await service.call({ grant, name: 'unlinked_get_investor_import', input: { importId: staged.importId, sourceOffset } })
    assert.ok(Buffer.byteLength(chunk.text) < 1024 * 1024)
    recovered += chunk.result.source.text; sourceOffset = chunk.result.source.nextOffset
  } while (sourceOffset !== null)
  assert.equal(recovered, csv)
  await assert.rejects(service.call({ grant: { ...grant, ownerId: 'bob', userId: 'bob' }, name: 'unlinked_get_investor_import', input: { importId: staged.importId, sourceOffset: 0 } }), e => e.code === 'not_found')
  await assert.rejects(service.call({ grant, name: 'unlinked_get_investor_import', input: { importId: staged.importId, sourceOffset: csv.length + 1 } }), e => e.code === 'invalid_input')
})
