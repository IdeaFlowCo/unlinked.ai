import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { createAccountHostedHandler, typedToolFailure } from '../mcp-server/account-hosted.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))

// The hosted account MCP endpoint must never collapse every inner failure into
// one revocation-sounding sentence: a provider outage told the agent (and its
// human) to "sign in again" while the grant was perfectly valid. Failures now
// carry sanitized typed causes; revocation stays clearly distinguished.

const importId = '1'.repeat(64), rowId = '2'.repeat(64)

function fixture(owner) {
  const resources = new Map()
  resources.set(importId, { type: 'import', sourceId: importId, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false,
    payload: { id: importId, ownerId: owner.ownerId, status: 'indexed', assertionIds: [rowId],
      counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } })
  resources.set(rowId, { type: 'assertion', sourceId: rowId, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false,
    payload: { id: rowId, ownerId: owner.ownerId, importId, sourceId: importId, rowId: 'Connections.csv#record=2', category: 'connections',
      subject: 'https://www.linkedin.com/in/synthetic-ada', fields: { 'first name': 'Ada', position: 'Engineer' } } })
  const getBackend = async caller => {
    assert.equal(caller.ownerId, owner.ownerId)
    return {
      readResource: async (_type, id) => { const value = resources.get(id); return value?.sourceOwnerId === caller.ownerId ? structuredClone(value) : null },
      writeResource: async value => { resources.set(value.sourceId, structuredClone(value)) },
      listImportIds: async () => [importId],
      listAccountGrantIds: async () => [...resources.values()].filter(x => x.sourceOwnerId === caller.ownerId && !x.deleted && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
    }
  }
  return { resources, getBackend }
}

test('hosted search failures are typed and sanitized: provider outage is upstream_unavailable with its internal cause, revocation is grant_revoked, missing anchor is degree_unproven', async t => {
  const owner = { ownerId: 'synthetic-typed-owner', userId: 'synthetic-typed-user' }
  const f = fixture(owner)
  const grants = createAccountGrantService({ issuer: 'https://synthetic-typed.invalid', signingKey: randomBytes(32), getBackend: f.getBackend, publicSearchEnabled: true })
  let completeError = null, revokeDuringModel = null
  const complete = async ({ candidateIds }) => {
    if (completeError) throw new Error(completeError)
    if (revokeDuringModel) { await revokeDuringModel(); revokeDuringModel = null }
    return { matches: [{ id: candidateIds[0], reason: 'Observed engineer' }] }
  }
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'typed-fixture-v1', profiles: [{ id: 'p1', name: 'Public Graph Engineer', positions: [], education: [], skills: [] }], connections: [] })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = `https://127.0.0.1:${server.address().port}`
  handler = createAccountHostedHandler({ origin, authenticateGrant: grants.authenticateGrant, getBackend: f.getBackend, complete, readPublishedSnapshot })
  const issued = await grants.issueGrant(owner)
  const client = new Client({ name: 'synthetic-typed-errors', version: '1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.accessToken}` } } })
  try {
    await client.connect(transport)
    const typed = async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      assert.equal(result.isError, true)
      return JSON.parse(result.content[0].text).error
    }

    // Working baseline: the same grant and import succeed.
    const ok = await client.callTool({ name: 'unlinked_search_network', arguments: { query: 'Engineer' } })
    assert.ok(!ok.isError)
    assert.equal(JSON.parse(ok.content[0].text).scope, 'owner_network')

    // Provider outage: typed upstream failure naming the internal cause —
    // explicitly NOT a revocation message, and no raw exception text.
    completeError = 'private_search_provider_http_503'
    const outage = await typed('unlinked_search_network', { query: 'Engineer' })
    assert.equal(outage.code, 'upstream_unavailable')
    assert.equal(outage.cause, 'private_search_provider_http_503')
    assert.doesNotMatch(outage.message, /revoked|sign in/i)
    const everyoneOutage = await typed('unlinked_search_everyone', { query: 'engineer' })
    assert.equal(everyoneOutage.code, 'upstream_unavailable')
    completeError = null

    // No confirmed legacy anchor: second degree is typed degree_unproven.
    const unproven = await typed('unlinked_search_network', { query: 'my second-degree connections' })
    assert.equal(unproven.code, 'degree_unproven')

    // Revocation mid-call stays clearly a revocation, never an upstream error.
    const authenticated = await grants.authenticateGrant({ headers: { authorization: `Bearer ${issued.accessToken}` } })
    revokeDuringModel = () => grants.revoke(owner, authenticated.grantId)
    const revoked = await typed('unlinked_search_network', { query: 'Engineer' })
    assert.equal(revoked.code, 'grant_revoked')
    assert.match(revoked.message, /revoked/)
    // After revocation the gate itself denies the whole request.
    await assert.rejects(client.callTool({ name: 'unlinked_search_network', arguments: { query: 'Engineer' } }))
  } finally { await client.close() }
})

test('typedToolFailure never leaks free-form exception text', () => {
  const leak = typedToolFailure(new Error('Secret token xyz: Bearer abc.def'))
  const parsed = JSON.parse(leak.content[0].text)
  assert.equal(parsed.error.code, 'upstream_unavailable')
  assert.equal(parsed.error.cause, 'internal_error')
  assert.ok(!leak.content[0].text.includes('Bearer'))
  const known = JSON.parse(typedToolFailure(new Error('account_tool_result_limit')).content[0].text)
  assert.equal(known.error.code, 'result_too_large')
  const identifier = JSON.parse(typedToolFailure(new Error('legacy_storage_binding_changed')).content[0].text)
  assert.equal(identifier.error.cause, 'legacy_storage_binding_changed')
})
