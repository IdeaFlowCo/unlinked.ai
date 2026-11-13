import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { createOwnerResourceBatchReader } from '../mcp-server/owner-resource-batch.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createImportRowCache } from '../src/utils/private-import/import-row-cache.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
const sha = text => createHash('sha256').update(text).digest('hex')
const owner = { ownerId: 'cold-owner', userId: 'cold-user' }
function fixture(count = 3140) {
  const importId = sha('cold-' + count), ids = Array.from({ length: count }, (_, n) => sha(importId + n))
  const resources = new Map(ids.map((id, n) => [id, { namespace: 'unlinked', type: 'assertion', sourceId: id, sourceOwnerId: owner.ownerId, deleted: false, payload: { id, ownerId: owner.ownerId, importId, category: 'connections', fields: { 'first name': 'Cold', 'last name': String(n), url: 'https://linkedin.com/in/cold-' + n } } }]))
  resources.set(importId, { sourceOwnerId: owner.ownerId, sourceRevision: 21, deleted: false, payload: { id: importId, status: 'partial', phase: 'private_observation_index_ready', indexGate: null, indexVersion: 'observation-v1', assertionIds: ids, counts: { accepted: count, indexed: count, rejected: 54, skippedFiles: 35, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } })
  const calls = { single: 0, batch: 0, largest: 0 }
  const backend = { adapter: {}, listImportIds: async () => [importId], listImportJobIds: async () => [],
    readResource: async (type, id) => { if (type === 'assertion') calls.single++; return structuredClone(resources.get(id) ?? null) },
    readResources: async (type, batch) => { assert.equal(type, 'assertion'); calls.batch++; calls.largest = Math.max(calls.largest, batch.length); return batch.map(id => structuredClone(resources.get(id) ?? null)) } }
  return { importId, ids, resources, calls, backend }
}

test('cold account hydration uses 25 bounded reads for 3,140 rows and preserves manifest order', async () => {
  const f = fixture(), start = performance.now()
  const network = await createAccountNetwork({ owner, getBackend: async () => f.backend, rowCache: null }).readNetwork()
  assert.equal(f.calls.single, 0, 'no per-row graph/HTTP calls on the batch capability')
  assert.equal(f.calls.batch, 25); assert.equal(f.calls.largest, 128)
  assert.deepEqual(network.assertions.map(row => row.id), f.ids)
  console.log(JSON.stringify({ kind: 'cold-account-synthetic', rows: network.assertions.length, calls: f.calls, ms: Math.round(performance.now() - start) }))
})

test('actual signed-in directory route cold-loads the batched owner network and renders the matching private person', async t => {
  const f = fixture(3141); let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'),
    login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'cold' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'cold' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'cold-v1', profiles: [], members: [], connections: [] }),
    getBackend: async () => f.backend })
  const go = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const login = await go('/login'), transaction = login.headers.getSetCookie()[0].split(';')[0]
  const callback = await go('/auth/callback/ideaflow?state=cold&code=cold', transaction)
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const start = performance.now(), response = await go('/network?connected=1&q=Cold%203140&mode=exact', cookie), html = await response.text()
  assert.equal(response.status, 200); assert.match(html, /Cold 3140/)
  assert.equal(f.calls.single, 0, 'signed-in directory must receive the batch capability')
  assert.equal(f.calls.batch, 25); assert.equal(f.calls.largest, 128)
  assert.match(html, /<title>[^<]*People[^<]*Unlinked/)
  console.log(JSON.stringify({ kind: 'cold-signed-directory-synthetic', rows: 3141, calls: f.calls, ms: Math.round(performance.now() - start) }))
  const anonymous = await go('/network?q=Cold%203140&mode=exact')
  assert.equal(anonymous.status, 200); assert.doesNotMatch(await anonymous.text(), /href="\/network\/contacts\//)
})

test('batch publication checks reject missing, reordered, foreign, tombstoned and revised observations', async () => {
  for (const corrupt of [rows => rows.slice(1), rows => rows.reverse(), rows => { rows[0].sourceOwnerId = 'foreign'; return rows }, rows => { rows[0].deleted = true; return rows }, rows => { rows[0].payload.importId = 'foreign'; return rows }]) {
    const f = fixture(2), original = f.backend.readResources
    f.backend.readResources = async (...args) => corrupt(await original(...args))
    await assert.rejects(createAccountNetwork({ owner, getBackend: async () => f.backend, rowCache: null }).readNetwork(), /private_publication_incomplete/)
  }
  const f = fixture(2), original = f.backend.readResources
  f.backend.readResources = async (...args) => { const rows = await original(...args); f.resources.get(f.importId).sourceRevision++; return rows }
  await assert.rejects(createAccountNetwork({ owner, getBackend: async () => f.backend, rowCache: null }).readNetwork(), /private_import_not_found/)
})

test('batch rows retain full-asset validation and no more than eight concurrent asset hydrations', async () => {
  const f = fixture(130), assets = new Map(); let active = 0, maximum = 0
  for (const id of f.ids) {
    const row = f.resources.get(id).payload; row.sourceId = sha('source')
    const bytes = Buffer.from(JSON.stringify(row)), digest = sha(bytes)
    assets.set(digest, bytes); f.resources.get(id).payload = { ...row, fullObservationAsset: digest }
  }
  const reader = createScopedImportReader({ ...f.backend, grant: { ownerId: owner.ownerId, importIds: [f.importId] },
    readAsset: async digest => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; return assets.get(digest) } })
  assert.equal((await reader(f.importId)).assertions.length, 130); assert.equal(maximum, 8)
  assets.set(f.resources.get(f.ids[0]).payload.fullObservationAsset, Buffer.from(JSON.stringify({ id: f.ids[0], ownerId: 'foreign' })))
  await assert.rejects(reader(f.importId), /private_publication_incomplete/)
})

test('process capability bounds keys and documents, reorders database results, and rechecks live authority', async () => {
  const f = fixture(3); let active = true, closed = false, reads = 0, sessionsClosed = 0, afterRead
  const mutableOwner = { ...owner }
  const authorizeOwner = async (principal, namespace, ownerId) => { assert.equal(principal.userId, owner.userId); assert.equal(namespace, 'unlinked'); assert.equal(ownerId, owner.ownerId); if (!active) throw Error('owner_denied') }
  const driver = { session: () => ({ executeRead: async work => work({ run: async (_query, args) => {
    reads++; assert.equal(args.ownerId, owner.ownerId); assert.equal(args.userId, owner.userId)
    const records = args.ids.map(id => ({ id, document: JSON.stringify(f.resources.get(id)) })).reverse().map(row => ({ get: key => row[key] }))
    afterRead?.(); return { records }
  } }), close: async () => { sessionsClosed++ } }) }
  const read = createOwnerResourceBatchReader({ driver, authorizeOwner, owner: mutableOwner, isClosed: () => closed })
  mutableOwner.ownerId = 'mutated'
  assert.deepEqual((await read('assertion', f.ids)).map(row => row.sourceId), f.ids)
  for (const [type, ids] of [['import', f.ids], ['assertion', []], ['assertion', [f.ids[0], f.ids[0]]], ['assertion', Array(2)], ['assertion', Array.from({ length: 129 }, (_, n) => sha(String(n)))]]) await assert.rejects(read(type, ids), /private_resource_key_invalid/)
  assert.equal(reads, 1)
  f.resources.get(f.ids[0]).payload.large = 'x'.repeat(65536)
  await assert.rejects(read('assertion', f.ids), /private_publication_incomplete/); delete f.resources.get(f.ids[0]).payload.large
  afterRead = () => { active = false }
  await assert.rejects(read('assertion', f.ids), /owner_denied/)
  assert.equal(sessionsClosed, 3)
  closed = true; await assert.rejects(read('assertion', f.ids), /private_owner_recovery_required/)
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
test('real Neo4j: batch matches exact namespace/user/active binding, isolates owners and refuses oversized documents', { skip: !uri || !process.env.UNLINKED_TEST_NEO4J_DRIVER }, async t => {
  assert.match(uri, /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER), driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const tag = sha('batch-test-' + Date.now()), own = { ownerId: tag, userId: tag + '-user' }
  const run = async (query, args) => { const s = driver.session(); try { return await s.run(query, args) } finally { await s.close() } }
  t.after(async () => { await run('MATCH (r {coldBatchTest:$tag}) DETACH DELETE r', { tag }); await driver.close() })
  await run("CREATE (:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId,active:true,coldBatchTest:$tag})", { ...own, tag })
  const ids = Array.from({ length: 4 }, (_, i) => sha(tag + i))
  for (const [i, sourceId] of ids.entries()) {
    const row = { namespace: 'unlinked', type: 'assertion', sourceId, sourceOwnerId: i === 1 ? 'foreign-owner' : own.ownerId, deleted: i === 2, payload: { private: 'synthetic' } }
    if (i === 3) row.payload.large = 'x'.repeat(65537)
    await run("CREATE (:OperationalResource {namespace:'unlinked',type:'assertion',sourceId:$sourceId,userId:$userId,document:$document,coldBatchTest:$tag})", { sourceId, userId: own.userId, document: JSON.stringify(row), tag })
  }
  const authorizeOwner = async () => { const result = await run("MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId}) WHERE coalesce(b.active,true)=true RETURN b", own); if (!result.records.length) throw Error('owner_denied') }
  const read = createOwnerResourceBatchReader({ driver, authorizeOwner, owner: own })
  assert.equal((await read('assertion', [ids[0]]))[0].sourceId, ids[0])
  assert.deepEqual(await read('assertion', [sha('missing')]), [null])
  await assert.rejects(read('assertion', [ids[1]]), /private_publication_incomplete/)
  assert.equal((await read('assertion', [ids[2]]))[0].deleted, true, 'tombstone retained for publication validator')
  await assert.rejects(read('assertion', [ids[3]]), /private_publication_incomplete/)
  const wrongUser = createOwnerResourceBatchReader({ driver, authorizeOwner: async () => {}, owner: { ...own, userId: 'foreign-user' } })
  assert.deepEqual(await wrongUser('assertion', [ids[0]]), [null], 'query itself joins active owner and user')
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=false', own)
  await assert.rejects(read('assertion', [ids[0]]), /owner_denied/)
})

test('erasure racing a detached batch fill cannot repopulate the immutable row cache', async () => {
  const f = fixture(256), cache = createImportRowCache()
  let release, started
  const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { started = resolve })
  const original = f.backend.readResources
  f.backend.readResources = async (...args) => { started(); await gate; return original(...args) }
  const network = createAccountNetwork({ owner, getBackend: async () => f.backend, rowCache: cache })
  const pending = network.readNetwork().catch(error => error)
  await entered; cache.forgetOwner(owner.ownerId); release(); await pending
  assert.equal(cache.stats().rows, 0)
  f.resources.get(f.importId).deleted = true
  await assert.rejects(network.readNetwork(), /private_import_not_found/)
})
