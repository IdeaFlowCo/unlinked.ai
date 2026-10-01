import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, cp, readdir, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createNoosImportAdapter, createScopedImportReader, createNoosOwnerBackend } from '../src/utils/private-import/noos-adapter.mjs'

const checkout = process.env.UNLINKED_NOOS_TEST_CHECKOUT
const uri = process.env.NOOS_OPERATIONAL_TEST_URI
const remoteApi = process.env.UNLINKED_NOOS_TEST_API
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
  const root = await mkdtemp(join(process.cwd(), '.unlinked-auth-receipt-'))
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', 'synthetic-contract-only'))
  let api, toolServer, client, searchClient, setupHandler
  t.after(async () => {
    await searchClient?.close()
    await client?.close()
    if (toolServer) await new Promise(resolve => toolServer.close(resolve))
    if (api) await new Promise(resolve => api.close(resolve))
    await driver.close(); await rm(root, { recursive: true, force: true })
  })
  const store = new OperationalStore(driver, 'neo4j'); await store.initialize()
  const owner = 'synthetic-retained-unlinked-a', otherOwner = 'synthetic-retained-unlinked-b'
  await store.bindOwner('unlinked', owner, 'synthetic-noos-a')
  await store.bindOwner('unlinked', otherOwner, 'synthetic-noos-b')
  const keys = remoteApi ? (() => {
    const privateKey = createPrivateKey(process.env.UNLINKED_NOOS_TEST_SIGNING_KEY)
    return { privateKey, publicKey: createPublicKey(privateKey) }
  })() : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const issuer = 'https://disposable.identity.invalid', revoked = new Set()
  const mapped = async (iss, sub) => iss === issuer && ['signed-a', 'signed-b'].includes(sub) ?
    { userId: sub === 'signed-a' ? 'synthetic-noos-a' : 'synthetic-noos-b', namespaces: ['unlinked'] } : null
  const auth = audience => createAccessTokenAuthenticator({ issuer, audience,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    resolveSubject: mapped, isRevoked: async (_issuer, jti) => revoked.has(jti) })
  const opsAuth = auth('noos-operations-staging'), toolAuth = auth('unlinked-private-tools-staging')
  const token = (sub, audience, scope, jti) => {
    const iat = Math.floor(Date.now() / 1000)
    return jwt.sign({ iss: issuer, aud: audience, sub, scope, jti, token_use: 'access', iat, exp: iat + (remoteApi ? 900 : 300) }, keys.privateKey,
      { algorithm: 'RS256', header: { alg: 'RS256', typ: 'at+jwt' } })
  }
  const alice = token('signed-a', 'noos-operations-staging', 'unlinked:read unlinked:write', 'ops-a')
  const bob = token('signed-b', 'noos-operations-staging', 'unlinked:read unlinked:write', 'ops-b')
  const app = express()
  const assets = new StagingFileAssets(join(root, 'assets'))
  app.use('/v1', createPrivateAssetRouter(store, assets, opsAuth))
  if (remoteApi) {
    assert.match(remoteApi, /^http:\/\/127\.0\.0\.1:\d+$/)
    // Only the private Noos API is remote; assets and the app remain local.
    app.use(async (req, res, next) => {
      try {
        const response = await fetch(`${remoteApi}${req.originalUrl}`, { method: req.method,
          headers: { authorization: req.headers.authorization, 'content-type': req.headers['content-type'] ?? 'application/json' },
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }), signal: AbortSignal.timeout(30000) })
        res.status(response.status).type(response.headers.get('content-type') ?? 'application/json').send(Buffer.from(await response.arrayBuffer()))
      } catch (error) { next(error) }
    })
  } else app.use('/v1', createOperationalRouter(store, opsAuth))
  api = app.listen(0, '127.0.0.1'); await new Promise(resolve => api.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${api.address().port}/v1`
  const observed = []
  const recordingFetch = async (url, init) => {
    const started = performance.now()
    const response = await fetch(url, init)
    observed.push({ method: init.method, path: new URL(url).pathname, status: response.status, elapsedMs: Math.round(performance.now() - started) })
    return response
  }
  const adapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice, fetchImpl: recordingFetch })
  let control
  if (remoteApi) {
    const controlZip = new JSZip()
    controlZip.file('Connections.csv', 'First Name,Last Name,URL,Company,Position\n' + Array.from({ length: 200 }, (_, i) =>
      `Control${i},Example,https://www.linkedin.com/in/synthetic-control-${i},Synthetic,Engineer\n`).join(''))
    const started = performance.now(), offset = observed.length
    const receipt = await ingestArchive({ consent: COMBINED_UPLOAD_CONSENT, ownerId: owner, filename: 'synthetic-control-200.zip',
      bytes: await controlZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), adapter })
    assert.equal(receipt.status, 'indexed'); assert.equal(receipt.counts.indexed, 200)
    control = { accepted: receipt.counts.accepted, indexed: receipt.counts.indexed, elapsedMs: Math.round(performance.now() - started), requests: observed.slice(offset), requestTimeoutMs: 30000 }
    if (process.env.UNLINKED_NOOS_CONTROL_RECEIPT) await writeFile(process.env.UNLINKED_NOOS_CONTROL_RECEIPT, JSON.stringify(control, null, 2))
    // Reset only this disposable owner's control data before the acceptance.
    const session = driver.session({ database: 'neo4j' })
    try { await session.executeWrite(tx => tx.run('MATCH (r:OperationalResource {userId: $id}) DELETE r', { id: 'synthetic-noos-a' })) }
    finally { await session.close() }
    await rm(join(root, 'assets'), { recursive: true, force: true })
  }
  const zip = new JSZip()
  zip.file('Connections.csv', 'Notes:\nSynthetic archive\n\nFirst Name,Last Name,URL,Company,Position\nAda,Example,https://www.linkedin.com/in/synthetic-ada,Synthetic,Engineer\n')
  zip.file('Skills.csv', 'Name\nSynthetic systems\n')
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const input = { consent: COMBINED_UPLOAD_CONSENT, ownerId: owner, filename: 'synthetic.zip', bytes, adapter }
  const result = await ingestArchive(input)
  assert.equal(result.status, 'indexed'); assert.equal(result.indexGate, null)
  assert.equal(result.counts.accepted, 2); assert.equal(result.counts.indexed, 2)
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
      if (!lost && new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(r => r.type === 'import' && r.payload?.assertionChunks)) { lost = true; throw new Error('synthetic_lost_response') }
      return response
    } })
  await assert.rejects(ingestArchive({ ...input, filename: 'lost-response.zip', adapter: lostResponseAdapter }), /synthetic_lost_response/)
  const recovered = await ingestArchive({ ...input, filename: 'lost-response.zip', adapter: lostResponseAdapter })
  assert.equal(recovered.counts.accepted, 2); assert.equal(recovered.status, 'indexed')
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
  assert.equal(assetRecovered.status, 'indexed'); assert.equal(assetRecovered.counts.accepted, 2)
  let publishInterrupted = false
  const interruptedPublishAdapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice,
    fetchImpl: async (url, init) => {
      if (!publishInterrupted && new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(r => r.type === 'import' && r.payload?.assertionChunks)) {
        publishInterrupted = true; throw new Error('synthetic_before_publication_commit')
      }
      return fetch(url, init)
    } })
  await assert.rejects(ingestArchive({ ...input, filename: 'publish-interrupted.zip', adapter: interruptedPublishAdapter }), /synthetic_before_publication_commit/)
  const publicationRecovered = await ingestArchive({ ...input, filename: 'publish-interrupted.zip', adapter })
  assert.equal(publicationRecovered.counts.accepted, 2); assert.equal(publicationRecovered.status, 'indexed')
  const parallel = await Promise.all([ingestArchive({ ...input, filename: 'parallel.zip', adapter }), ingestArchive({ ...input, filename: 'parallel.zip', adapter })])
  assert.deepEqual(parallel[0], parallel[1])
  const scaledZip = new JSZip()
  scaledZip.file('Connections.csv', 'First Name,Last Name,URL,Company,Position\n' + Array.from({ length: 1001 }, (_, i) =>
    `Synthetic${i},Example,https://www.linkedin.com/in/synthetic-scale-${i},Synthetic company ${i},${i === 1000 ? 'Quantum compiler engineer' : 'Bakery manager'}\n`).join(''))
  const scaledBytes = await scaledZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const scaledInput = { consent: COMBINED_UPLOAD_CONSENT, ownerId: owner, filename: 'synthetic-1001-connections.zip', bytes: scaledBytes }
  let chunkCommits = 0
  const interruptedJournal = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice, fetchImpl: async (url, init) => {
    const response = await fetch(url, init)
    if (new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(item => item.type === 'assertion') && ++chunkCommits === 2) throw new Error('synthetic_mid_journal_response_lost')
    return response
  } })
  await assert.rejects(ingestArchive({ ...scaledInput, adapter: interruptedJournal }), /synthetic_mid_journal_response_lost/)
  const { privateId } = await import('../src/utils/private-import/job.mjs')
  const { PARSER_VERSION } = await import('../src/utils/private-import/archive.mjs')
  const scaledId = privateId(owner, 'import', createHash('sha256').update(scaledBytes).digest('hex'), scaledInput.filename, PARSER_VERSION)
  const provisionalReader = createScopedImportReader({ grant: { ownerId: owner, importIds: [scaledId] }, readResource: async (type, id) => {
    const response = await fetch(`${baseUrl}/unlinked/${type}/${id}`, { headers: { Authorization: `Bearer ${alice}` } })
    return response.status === 404 ? null : response.json()
  } })
  await assert.rejects(provisionalReader(scaledId), /private_import_not_found/)
  const scaled = await ingestArchive({ ...scaledInput, adapter })
  assert.equal(scaled.status, 'indexed'); assert.equal(scaled.counts.accepted, 1001); assert.equal(scaled.counts.indexed, 1001)
  assert.equal(scaled.assertionChunks.length, 6)
  assert.deepEqual(await ingestArchive({ ownerId: owner, filename: 'synthetic-1001-connections.zip', bytes: scaledBytes, adapter }), scaled)
  assert.equal((await fetch(`${baseUrl}/unlinked/import/${scaled.id}`, { headers: { Authorization: `Bearer ${bob}` } })).status, 404)
  // Deletion wins even after immutable journal chunks are committed and a
  // delayed publisher is about to make its final CAS-fenced publication.
  let releasePublisher, notifyPublisher
  const paused = new Promise(resolve => { notifyPublisher = resolve })
  const release = new Promise(resolve => { releasePublisher = resolve })
  const racingAdapter = createNoosImportAdapter({ baseUrl, ownerId: owner, accessToken: alice, fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith('/batch') && JSON.parse(init.body).some(item => item.payload?.assertionChunks)) { notifyPublisher(); await release }
    return fetch(url, init)
  } })
  const racingInput = { ...input, filename: 'synthetic-deletion-race.zip', adapter: racingAdapter }
  const publishing = ingestArchive(racingInput)
  const rejectedPublishing = assert.rejects(publishing, /private_noos_409/)
  await paused
  const racingId = privateId(owner, 'import', createHash('sha256').update(bytes).digest('hex'), racingInput.filename, PARSER_VERSION)
  const actor = { userId: 'synthetic-noos-a', namespaces: ['unlinked'] }
  const pendingPublication = await store.get(actor, { namespace: 'unlinked', type: 'import', sourceId: racingId })
  await store.put(actor, { ...pendingPublication, sourceRevision: pendingPublication.sourceRevision + 1,
    expectedRevision: pendingPublication.sourceRevision, deleted: true, payload: null })
  releasePublisher(); await rejectedPublishing
  const deletedJournalReader = createScopedImportReader({ grant: { ownerId: owner, importIds: [racingId] }, readResource: async (type, sourceId) => store.get(actor, { namespace: 'unlinked', type, sourceId }) })
  await assert.rejects(deletedJournalReader(racingId), /private_import_not_found/)
  await assert.rejects(ingestArchive(racingInput), /private_import_deleted/)
  const modelReceipts = [], considered = new Set()
  let complete
  if (process.env.UNLINKED_PRIVATE_AI_REMOTE === '1') {
    const { createRemoteCompletion } = await import('../scripts/private-remote-completion.mjs')
    const remote = createRemoteCompletion({ sshHost: 'm5', credentialFile: '/Users/jacobcole/.config/openai/openai.env', onReceipt: receipt => modelReceipts.push(receipt) })
    complete = async input => { input.candidateIds.forEach(id => considered.add(id)); return remote(input) }
  }
  const grantToken = token('signed-a', 'unlinked-private-tools-staging', 'unlinked:read', 'grant-a')
  const grant = { ownerId: owner, userId: 'synthetic-noos-a', importIds: [result.id, scaled.id], tools: ['unlinked_read_import', ...(complete ? ['unlinked_search_import'] : [])], expiresAt: Date.now() + (remoteApi ? 900000 : 300000) }
  const readResource = async (_grant, type, id) => {
    const response = await fetch(`${baseUrl}/unlinked/${type}/${id}`, { headers: { Authorization: `Bearer ${alice}` } })
    if (response.status === 404) return null
    assert.equal(response.status, 200)
    return response.json()
  }
  const { createPrivateGrantService } = await import('../mcp-server/private-grants.mjs')
  const ownerBackend = createNoosOwnerBackend({ baseUrl, ownerId: owner, accessToken: alice })
  const privateGrants = createPrivateGrantService({ issuer: 'https://disposable-private-tools.invalid', ...keys,
    getBackend: async verified => {
      if (verified.ownerId !== owner || verified.userId !== 'synthetic-noos-a') throw new Error('private_owner_mismatch')
      return ownerBackend
    } })
  const scopedSearchToken = await privateGrants.issueGrant({ ownerId: owner, userId: 'synthetic-noos-a' }, { importIds: [scaled.id], tools: ['unlinked_search_import'] })
  const scopedGrantId = JSON.parse(Buffer.from(scopedSearchToken.split('.')[1], 'base64url')).grantId
  let allowedHost
  // Recreate handler after selecting the actual private test host.
  toolServer = createServer((req, res) => req.url === '/setup' ? setupHandler(req, res) : allowedHost(req, res))
  await new Promise(resolve => toolServer.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${toolServer.address().port}/mcp`
  allowedHost = createPrivateHostedHandler({ allowedHosts: [`127.0.0.1:${toolServer.address().port}`],
    authenticateGrant: async req => {
      const privateGrant = await privateGrants.authenticateGrant(req)
      if (privateGrant) return privateGrant
      const principal = await toolAuth({ headers: req.headers, method: 'GET', params: { namespace: 'unlinked' } })
      return principal?.userId === grant.userId && req.headers.authorization === `Bearer ${grantToken}` ? grant : null
    }, readResource, complete })
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
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['unlinked_read_import', ...(complete ? ['unlinked_search_import'] : [])])
  const receipt = await client.callTool({ name: 'unlinked_read_import', arguments: { importId: result.id } })
  assert.equal(receipt.isError, undefined); assert.equal(JSON.parse(receipt.content[0].text).assertions.length, 2)
  const sdkOptions = remoteApi ? { timeout: 600000 } : undefined
  const scaledReceipt = await client.callTool({ name: 'unlinked_read_import', arguments: { importId: scaled.id } }, undefined, sdkOptions)
  assert.equal(scaledReceipt.isError, undefined)
  const indexedRows = JSON.parse(scaledReceipt.content[0].text)
  assert.equal(indexedRows.assertions.length, 1001); assert.equal(indexedRows.indexed, 1001)
  assert.equal(new Set(indexedRows.assertions.map(row => row.id)).size, 1001)
  assert.ok(indexedRows.assertions.every(row => row.privateIndex.version === 'observation-v1'))
  let searchReceipt
  if (complete) {
    searchClient = new Client({ name: 'real-private-search-grant', version: '1.0.0' })
    await searchClient.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${scopedSearchToken}` } } }))
    assert.deepEqual((await searchClient.listTools()).tools.map(tool => tool.name), ['unlinked_search_import'])
    searchReceipt = await searchClient.callTool({ name: 'unlinked_search_import', arguments: { importId: scaled.id, query: 'Who is a quantum compiler engineer?' } }, undefined, sdkOptions)
    assert.equal(searchReceipt.isError, undefined)
    const matches = JSON.parse(searchReceipt.content[0].text).matches
    assert.ok(matches.some(match => match.subject === 'https://www.linkedin.com/in/synthetic-scale-1000'))
    assert.equal(considered.size, 1001)
    assert.equal((await fetch(archivePath, { headers: { Authorization: `Bearer ${scopedSearchToken}` } })).status, 401)
    assert.equal((await searchClient.callTool({ name: 'unlinked_search_import', arguments: { importId: result.id, query: 'engineer' } })).isError, true)
  }
  await privateGrants.revoke({ ownerId: owner, userId: 'synthetic-noos-a' }, scopedGrantId)
  if (searchClient) await assert.rejects(searchClient.listTools())
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
  // Quiesced synthetic rehearsal: snapshot graph and blobs as one private
  // pair, remove ONLY this harness's owner data, restore journal rows before
  // final manifests, and prove full dataset/provenance/recovery parity.
  const backupRoot = join(root, 'paired-backup')
  await mkdir(backupRoot, { mode: 0o700 })
  const snapshotSession = driver.session({ database: 'neo4j' })
  const ids = ['synthetic-noos-a', 'synthetic-noos-b']
  let snapshot
  try {
    snapshot = await snapshotSession.executeRead(async tx => ({
      resources: (await tx.run('MATCH (r:OperationalResource) WHERE r.userId IN $ids RETURN properties(r) AS item', { ids })).records.map(record => record.get('item')),
      bindings: (await tx.run('MATCH (b:OperationalOwner) WHERE b.userId IN $ids RETURN properties(b) AS item', { ids })).records.map(record => record.get('item')),
    }))
    await cp(join(root, 'assets'), join(backupRoot, 'assets'), { recursive: true, errorOnExist: true, force: false })
    const blobs = []
    for (const bucket of await readdir(join(backupRoot, 'assets'))) {
      assert.match(bucket, /^[a-f0-9]{64}$/)
      for (const hash of await readdir(join(backupRoot, 'assets', bucket))) {
        const blob = await readFile(join(backupRoot, 'assets', bucket, hash))
        assert.equal(createHash('sha256').update(blob).digest('hex'), hash)
        blobs.push({ bucket, sha256: hash, bytes: blob.length })
      }
    }
    await writeFile(join(backupRoot, 'graph-and-assets.json'), JSON.stringify({ ...snapshot, blobs }), { mode: 0o600 })
    await snapshotSession.executeWrite(async tx => {
      await tx.run('MATCH (r:OperationalResource) WHERE r.userId IN $ids DELETE r', { ids })
      await tx.run('MATCH (b:OperationalOwner) WHERE b.userId IN $ids DELETE b', { ids })
    })
    await rm(join(root, 'assets'), { recursive: true, force: true })
    await cp(join(backupRoot, 'assets'), join(root, 'assets'), { recursive: true, errorOnExist: true, force: false })
    await snapshotSession.executeWrite(tx => tx.run('UNWIND $rows AS item CREATE (b:OperationalOwner) SET b = item', { rows: snapshot.bindings }))
    const final = [], staged = []
    for (const resource of snapshot.resources) {
      const document = JSON.parse(resource.document)
      ;(document.payload?.assertionChunks ? final : staged).push(resource)
    }
    for (const group of [staged, final]) for (let start = 0; start < group.length; start += 200) {
      await snapshotSession.executeWrite(tx => tx.run('UNWIND $rows AS item CREATE (r:OperationalResource) SET r = item', { rows: group.slice(start, start + 200) }))
    }
    const restored = await provisionalReader(scaled.id)
    assert.equal(restored.indexed, 1001); assert.deepEqual(restored.assertions, indexedRows.assertions)
    const recoveredBytes = await fetch(archivePath, { headers: { Authorization: `Bearer ${alice}` } })
    assert.deepEqual(Buffer.from(await recoveredBytes.arrayBuffer()), bytes)
    assert.equal((await fetch(archivePath, { headers: { Authorization: `Bearer ${bob}` } })).status, 404)
    await assert.rejects(reader(result.id), /private_import_not_found/)
    assert.equal(await privateGrants.authenticateGrant({ headers: { authorization: `Bearer ${scopedSearchToken}` } }), null)
    snapshot = { restored: true, graphResources: snapshot.resources.length, assetBlobs: blobs.length,
      accepted: 1001, indexed: restored.indexed, preservedPublicationTombstone: result.id, preservedGrantTombstone: scopedGrantId,
      boundary: 'Quiesced owned synthetic graph/blob pair only; no production power-loss/fsync/retention or historical-data cutover claim.' }
  } finally { await snapshotSession.close() }
  if (process.env.UNLINKED_NOOS_RECEIPT) await writeFile(process.env.UNLINKED_NOOS_RECEIPT, JSON.stringify({
    boundary: 'Real synthetic ZIP, RS256 access verification, offline disposable issuer/subject mapping, dedicated temporary Neo4j, private asset bytes and actual MCP SDK client. No real provider login/consent, production mount, production deployment or live personal data. Optional explicitly configured existing-key synthetic AI receipt is recorded separately.',
    archiveSha256: createHash('sha256').update(bytes).digest('hex'), import: result,
    control, observed, toolReceipt: receipt, lostResponseRecovery: recovered.id, assetInterruptionRecovery: assetRecovered.id, publicationInterruptionRecovery: publicationRecovered.id, simultaneousReplay: parallel[0].id, scaledImport: scaled, scaledToolReceipt: { indexed: indexedRows.indexed, assertionCount: indexedRows.assertions.length }, searchReceipt, modelReceipts, consideredConnections: considered.size, midJournalLostResponseCommits: chunkCommits, durableSearchGrant: scopedGrantId, pairedRestore: snapshot,
    verified: ['other owner cannot read import/raw asset', 'different tool audience cannot read raw asset', 'ungranted import denied', 'tombstone denies retained assertions', 'revoked token denies next SDK request', 'single authenticated setup action returns download configuration for only the approved import', 'deleted publication denies new setup', '1001 connections indexed and scoped SDK-readable'], indexed: scaled.counts.indexed,
    cleanup: 'owned server connections, private filesystem root and disposable container removed by finally hooks',
  }, null, 2))
})
