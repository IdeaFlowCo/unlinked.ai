import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createNoosImportAdapter, createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'

const checkout = process.env.UNLINKED_NOOS_TEST_CHECKOUT
const uri = process.env.NOOS_OPERATIONAL_TEST_URI
test('real archive -> signed private Noos/assets -> per-import hosted MCP receipt', { skip: !checkout || !uri }, async t => {
  const { createPrivateHostedHandler, scopedSetupConfiguration, createScopedSetupHandler } = await import('../mcp-server/private-hosted.mjs')
  const { Client } = await import('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')
  const { StreamableHTTPClientTransport } = await import('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')
  assert.match(checkout, /^\/Volumes\/External_SSD\//)
  assert.match(uri, /^bolt:\/\/127\.0\.0\.1:\d+$/)
  const require = createRequire(join(checkout, 'package.json'))
  const express = require('express'), jwt = require('jsonwebtoken'), neo4j = require('neo4j-driver')
  const load = name => import(pathToFileURL(join(checkout, `src/operational/${name}.ts`)).href)
  const { OperationalStore } = await load('store')
  const { createOperationalRouter } = await load('router')
  const { createAccessTokenAuthenticator } = await load('access-token')
  const { StagingFileAssets, createPrivateAssetRouter } = await load('assets')
  const root = await mkdtemp('/Volumes/External_SSD/code-overflow/unlinked-auth-receipt-')
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', 'synthetic-contract-only'))
  let api, toolServer, client, setupHandler
  t.after(async () => {
    await client?.close()
    if (toolServer) await new Promise(resolve => toolServer.close(resolve))
    if (api) await new Promise(resolve => api.close(resolve))
    await driver.close(); await rm(root, { recursive: true, force: true })
  })
  const store = new OperationalStore(driver, 'neo4j'); await store.initialize()
  const owner = 'synthetic-retained-unlinked-a', otherOwner = 'synthetic-retained-unlinked-b'
  await store.bindOwner('unlinked', owner, 'synthetic-noos-a')
  await store.bindOwner('unlinked', otherOwner, 'synthetic-noos-b')
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const issuer = 'https://disposable.identity.invalid', revoked = new Set()
  const mapped = async (iss, sub) => iss === issuer && ['signed-a', 'signed-b'].includes(sub) ?
    { userId: sub === 'signed-a' ? 'synthetic-noos-a' : 'synthetic-noos-b', namespaces: ['unlinked'] } : null
  const auth = audience => createAccessTokenAuthenticator({ issuer, audience,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    resolveSubject: mapped, isRevoked: async (_issuer, jti) => revoked.has(jti) })
  const opsAuth = auth('noos-operations-staging'), toolAuth = auth('unlinked-private-tools-staging')
  const token = (sub, audience, scope, jti) => {
    const iat = Math.floor(Date.now() / 1000)
    return jwt.sign({ iss: issuer, aud: audience, sub, scope, jti, token_use: 'access', iat, exp: iat + 300 }, keys.privateKey,
      { algorithm: 'RS256', header: { alg: 'RS256', typ: 'at+jwt' } })
  }
  const alice = token('signed-a', 'noos-operations-staging', 'unlinked:read unlinked:write', 'ops-a')
  const bob = token('signed-b', 'noos-operations-staging', 'unlinked:read unlinked:write', 'ops-b')
  const app = express()
  const assets = new StagingFileAssets(join(root, 'assets'))
  app.use('/v1', createPrivateAssetRouter(store, assets, opsAuth))
  app.use('/v1', createOperationalRouter(store, opsAuth))
  api = app.listen(0, '127.0.0.1'); await new Promise(resolve => api.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${api.address().port}/v1`
  const observed = []
  const recordingFetch = async (url, init) => {
    const response = await fetch(url, init)
    observed.push({ method: init.method, path: new URL(url).pathname, status: response.status })
    return response
  }
  const adapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice, fetchImpl: recordingFetch })
  const zip = new JSZip()
  zip.file('Connections.csv', 'Notes:\nSynthetic archive\n\nFirst Name,Last Name,URL,Company,Position\nAda,Example,https://www.linkedin.com/in/synthetic-ada,Synthetic,Engineer\n')
  zip.file('Skills.csv', 'Name\nSynthetic systems\n')
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const input = { ownerId: owner, filename: 'synthetic.zip', bytes, adapter }
  const result = await ingestArchive(input)
  assert.equal(result.status, 'partial'); assert.equal(result.indexGate, 'ai_search_not_connected')
  assert.equal(result.counts.accepted, 2); assert.equal(result.counts.indexed, 0)
  assert.deepEqual(await ingestArchive(input), result)
  const archivePath = `${baseUrl}/unlinked/assets/${owner}/${result.archiveSha256}`
  const raw = await fetch(archivePath, { headers: { Authorization: `Bearer ${alice}` } })
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes)
  assert.equal((await fetch(archivePath, { headers: { Authorization: `Bearer ${bob}` } })).status, 404)
  assert.equal((await fetch(`${baseUrl}/unlinked/import/${result.id}`, { headers: { Authorization: `Bearer ${bob}` } })).status, 404)
  // A lost publication response cannot duplicate observations; the exact durable receipt wins on retry.
  let lost = false
  const lostResponseAdapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init)
      if (!lost && new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(r => r.type === 'assertion')) { lost = true; throw new Error('synthetic_lost_response') }
      return response
    } })
  await assert.rejects(ingestArchive({ ...input, filename: 'lost-response.zip', adapter: lostResponseAdapter }), /synthetic_lost_response/)
  const recovered = await ingestArchive({ ...input, filename: 'lost-response.zip', adapter: lostResponseAdapter })
  assert.equal(recovered.counts.accepted, 2); assert.equal(recovered.status, 'partial')
  // Crash after authenticated raw upload and before any graph receipt: orphan
  // bytes stay private and immutable, and a fresh adapter can complete the same import.
  let assetInterrupted = false
  const interruptedAssetAdapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init)
      if (!assetInterrupted && new URL(url).pathname.includes('/assets/') && init.method === 'PUT') {
        assetInterrupted = true; throw new Error('synthetic_asset_response_lost')
      }
      return response
    } })
  await assert.rejects(ingestArchive({ ...input, filename: 'asset-interrupted.zip', adapter: interruptedAssetAdapter }), /synthetic_asset_response_lost/)
  const assetRecovered = await ingestArchive({ ...input, filename: 'asset-interrupted.zip', adapter })
  assert.equal(assetRecovered.status, 'partial'); assert.equal(assetRecovered.counts.accepted, 2)
  let publishInterrupted = false
  const interruptedPublishAdapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice,
    fetchImpl: async (url, init) => {
      if (!publishInterrupted && new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(r => r.type === 'assertion')) {
        publishInterrupted = true; throw new Error('synthetic_before_publication_commit')
      }
      return fetch(url, init)
    } })
  await assert.rejects(ingestArchive({ ...input, filename: 'publish-interrupted.zip', adapter: interruptedPublishAdapter }), /synthetic_before_publication_commit/)
  const publicationRecovered = await ingestArchive({ ...input, filename: 'publish-interrupted.zip', adapter })
  assert.equal(publicationRecovered.counts.accepted, 2); assert.equal(publicationRecovered.status, 'partial')
  const parallel = await Promise.all([ingestArchive({ ...input, filename: 'parallel.zip', adapter }), ingestArchive({ ...input, filename: 'parallel.zip', adapter })])
  assert.deepEqual(parallel[0], parallel[1])
  const large = Buffer.from('Name\n' + Array.from({ length: 501 }, (_, i) => `Synthetic skill ${i}\n`).join(''))
  const unsupported = await ingestArchive({ ownerId: owner, filename: 'Skills.csv', bytes: large, adapter })
  assert.equal(unsupported.status, 'failed'); assert.equal(unsupported.phase, 'unsupported_private_publication')
  assert.equal(unsupported.error, 'private_publication_support_limit'); assert.equal(unsupported.counts.indexed, 0)
  assert.equal(unsupported.assertionIds, undefined)
  const verification = driver.session({ database: 'neo4j' })
  try {
    const count = await verification.run('MATCH (r:OperationalResource {namespace: "unlinked", type: "assertion"}) WHERE r.document CONTAINS $importId RETURN count(r) AS count', { importId: unsupported.id })
    assert.equal(count.records[0].get('count').toNumber(), 0)
  } finally { await verification.close() }
  const grantToken = token('signed-a', 'unlinked-private-tools-staging', 'unlinked:read', 'grant-a')
  const grant = { ownerId: owner, userId: 'synthetic-noos-a', importIds: [result.id], tools: ['unlinked_read_import'], expiresAt: Date.now() + 300000 }
  const readResource = async (_grant, type, id) => {
    const response = await fetch(`${baseUrl}/unlinked/${type}/${id}`, { headers: { Authorization: `Bearer ${alice}` } })
    if (response.status === 404) return null
    assert.equal(response.status, 200)
    return response.json()
  }
  let allowedHost
  // Recreate handler after selecting the actual private test host.
  toolServer = createServer((req, res) => req.url === '/setup' ? setupHandler(req, res) : allowedHost(req, res))
  await new Promise(resolve => toolServer.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${toolServer.address().port}/mcp`
  allowedHost = createPrivateHostedHandler({ allowedHosts: [`127.0.0.1:${toolServer.address().port}`],
    authenticateGrant: async req => {
      const principal = await toolAuth({ headers: req.headers, method: 'GET', params: { namespace: 'unlinked' } })
      return principal?.userId === grant.userId && req.headers.authorization === `Bearer ${grantToken}` ? grant : null
    }, readResource })
  setupHandler = createScopedSetupHandler({ endpoint, allowLoopbackStaging: true,
    allowedHosts: [`127.0.0.1:${toolServer.address().port}`],
    authenticateOwner: async req => {
      const principal = await opsAuth({ headers: req.headers, method: 'POST', params: { namespace: 'unlinked' } })
      return principal?.userId === grant.userId ? { userId: grant.userId, ownerId: owner } : null
    },
    readResource,
    issueGrant: async (principal, scope) => {
      assert.equal(principal.ownerId, owner); assert.deepEqual(scope, { importIds: [result.id], tools: ['unlinked_read_import'] })
      return grantToken
    },
  })
  const setup = await fetch(endpoint.replace('/mcp', '/setup'), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: result.id }) })
  assert.equal(setup.status, 200); assert.equal(setup.headers.get('cache-control'), 'no-store')
  assert.match(setup.headers.get('content-disposition'), /attachment/)
  const setupConfig = await setup.json()
  assert.equal(setupConfig.mcpServers['unlinked-private'].url, endpoint)
  assert.equal((await fetch(endpoint.replace('/mcp', '/setup'), { method: 'POST',
    headers: { Authorization: `Bearer ${bob}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: result.id }) })).status, 401)
  client = new Client({ name: 'disposable-private-import-receipt', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${grantToken}` } } })

  await client.connect(transport)
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['unlinked_read_import'])
  const receipt = await client.callTool({ name: 'unlinked_read_import', arguments: { importId: result.id } })
  assert.equal(receipt.isError, undefined); assert.equal(JSON.parse(receipt.content[0].text).assertions.length, 2)
  assert.equal((await client.callTool({ name: 'unlinked_read_import', arguments: { importId: recovered.id } })).isError, true)
  assert.equal((await fetch(archivePath, { headers: { Authorization: `Bearer ${grantToken}` } })).status, 401)
  // Publication tombstone blocks retained source/assertions through the actual SDK client.
  const publication = await readResource(grant, 'import', result.id)
  await store.put({ userId: grant.userId, namespaces: ['unlinked'] }, { ...publication,
    sourceRevision: publication.sourceRevision + 1, expectedRevision: publication.sourceRevision, deleted: true, payload: null })
  assert.equal((await client.callTool({ name: 'unlinked_read_import', arguments: { importId: result.id } })).isError, true)
  revoked.add('grant-a')
  await assert.rejects(client.listTools())
  assert.equal((await fetch(endpoint.replace('/mcp', '/setup'), { method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: result.id }) })).status, 404)
  const config = scopedSetupConfiguration({ endpoint: 'https://staging.invalid/mcp', accessToken: grantToken })
  assert.equal(config.mcpServers['unlinked-private'].url, 'https://staging.invalid/mcp')
  const reader = createScopedImportReader({ grant, readResource: (type, id) => readResource(grant, type, id) })
  await assert.rejects(reader(result.id), /private_import_not_found/)
  if (process.env.UNLINKED_NOOS_RECEIPT) await writeFile(process.env.UNLINKED_NOOS_RECEIPT, JSON.stringify({
    boundary: 'Real synthetic ZIP, RS256 access verification, offline disposable issuer/subject mapping, dedicated temporary Neo4j, private asset bytes and actual MCP SDK client. No real provider login/consent, production mount, AI search, paid call or live personal data.',
    archiveSha256: createHash('sha256').update(bytes).digest('hex'), import: result,
    observed, toolReceipt: receipt, lostResponseRecovery: recovered.id, assetInterruptionRecovery: assetRecovered.id, publicationInterruptionRecovery: publicationRecovered.id, simultaneousReplay: parallel[0].id, unsupportedArchive: unsupported,
    verified: ['other owner cannot read import/raw asset', 'different tool audience cannot read raw asset', 'ungranted import denied', 'tombstone denies retained assertions', 'revoked token denies next SDK request', 'single authenticated setup action returns download configuration for only the approved import', 'deleted publication denies new setup'], indexed: 0,
    cleanup: 'owned server connections, private filesystem root and disposable container removed by finally hooks',
  }, null, 2))
})
