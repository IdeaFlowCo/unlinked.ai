import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { existsSync } from 'node:fs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'

const sdkInstalled = existsSync(new URL('../mcp-server/node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url))
test('staging setup executes owner approval, scope download and host/origin/expiry gates', { skip: !sdkInstalled }, async t => {
  const { createScopedSetupHandler, createPrivateHostedHandler } = await import('../mcp-server/private-hosted.mjs')
  const id = 'a'.repeat(64), ownerId = 'fixture-owner'
  let deleted = false, issued = 0, setup, hosted
  const server = createServer((req, res) => req.url === '/setup' ? setup(req, res) : hosted(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = `127.0.0.1:${server.address().port}`, endpoint = `http://${host}/mcp`
  const readResource = async () => ({ sourceOwnerId: ownerId, deleted, sourceRevision: 1,
    payload: deleted ? null : { id, status: 'partial', assertionIds: [] } })
  setup = createScopedSetupHandler({ endpoint, allowLoopbackStaging: true, allowedHosts: [host], allowedOrigins: ['https://approved.invalid'],
    // This unit uses an explicit fixture verifier. The cross-repo graph test proves signed auth.
    authenticateOwner: async req => req.headers.authorization === 'Bearer fixture-owner' ? { ownerId } : null,
    issueGrant: async (owner, scope) => {
      assert.equal(owner.ownerId, ownerId); assert.deepEqual(scope, { importIds: [id], tools: ['unlinked_read_import'] })
      issued++; return 'synthetic-scoped-grant'
    }, readResource })
  hosted = createPrivateHostedHandler({ allowedHosts: [host], authenticateGrant: async () => ({ ownerId, importIds: [id], tools: ['unlinked_read_import'], expiresAt: Date.now() - 1 }), readResource })
  const post = (body, extra = {}, bearer = 'fixture-owner') => fetch(`http://${host}/setup`, { method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...extra }, body })
  assert.equal((await post(JSON.stringify({ importId: id }), {}, 'other-owner')).status, 401)
  assert.equal((await post(JSON.stringify({ importId: id }), { Origin: 'https://unapproved.invalid' })).status, 403)
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(`http://${host}/setup`, { method: 'POST', headers: { Host: 'unexpected.invalid', Authorization: 'Bearer fixture-owner' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode))
    })
    req.once('error', reject); req.end(JSON.stringify({ importId: id }))
  })
  assert.equal(wrongHost, 403)
  assert.equal((await post('{invalid')).status, 400)
  assert.equal((await post(JSON.stringify({ importId: id, ownerId: 'other' }))).status, 400)
  assert.equal((await post(JSON.stringify({ importId: id, extra: 'x'.repeat(3000) }))).status, 413)
  const response = await post(JSON.stringify({ importId: id }))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).mcpServers['unlinked-private'].headers.Authorization, 'Bearer synthetic-scoped-grant')
  assert.equal(issued, 1)
  deleted = true
  assert.equal((await post(JSON.stringify({ importId: id }))).status, 404); assert.equal(issued, 1)
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(endpoint)).status, 405)
  await assert.rejects(createScopedImportReader({ grant: { ownerId, importIds: [id] }, readResource }) (id), /private_import_not_found/)
})
