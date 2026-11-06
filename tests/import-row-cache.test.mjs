import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createImportRowCache } from '../src/utils/private-import/import-row-cache.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { deleteAccountData } from '../src/utils/private-import/account-data.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

// Every observation row is its own operational resource (one loopback HTTP +
// graph read each), so an uncached 4,416-row owner network cost 42-85 s per
// list_connections / ai_search call. These pin the cache's speedup and,
// above all, that it never serves rows a fresh read would refuse.
const sha = value => createHash('sha256').update(String(value)).digest('hex')
const owner = { ownerId: 'cache-owner', userId: 'cache-user' }

function fixture({ rows = 50, status = 'indexed', importSeed = 'import', ownerId = owner.ownerId, delayMs = 0 } = {}) {
  const importId = sha(`${ownerId}:${importSeed}`)
  const ids = Array.from({ length: rows }, (_, n) => sha(`${importId}:${n}`))
  const resources = new Map(ids.map((id, n) => [id, { sourceOwnerId: ownerId, deleted: false, payload: { id, ownerId, importId, category: 'connections', fields: { 'first name': `P${n}`, company: 'Example', position: 'Investor' } } }]))
  resources.set(importId, { sourceOwnerId: ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, status, assertionIds: ids, counts: { accepted: rows, indexed: rows, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } })
  const reads = { import: 0, assertion: 0 }
  const backend = {
    async listImportIds() { return [importId] },
    async readResource(type, id) {
      reads[type] = (reads[type] ?? 0) + 1
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      const value = resources.get(id)
      return value ? structuredClone(value) : null
    },
    async writeBatch(items) { for (const item of items) resources.set(item.sourceId, { ...resources.get(item.sourceId), deleted: true, payload: null }); return items.map(() => ({ status: 'updated' })) },
  }
  return { importId, ids, resources, reads, backend }
}
const network = (f, rowCache, ownerArg = owner) => createAccountNetwork({ owner: ownerArg, getBackend: async () => f.backend, rowCache })

test('a warm owner network read skips every per-row round trip and returns identical rows', async () => {
  const f = fixture({ rows: 300 }), cache = createImportRowCache()
  const cold = await network(f, cache).readNetwork()
  assert.equal(f.reads.assertion, 300)
  const before = { ...f.reads }
  const warm = await network(f, cache).readNetwork()
  assert.equal(f.reads.assertion, before.assertion, 'no row reads when warm')
  assert.equal(f.reads.import - before.import, 2, 'the import is still re-read before and after')
  assert.deepEqual(warm.assertions, cold.assertions)
  // Callers get their own array: mutating one result cannot corrupt the cache.
  warm.assertions.length = 0
  assert.equal((await network(f, cache).readNetwork()).assertions.length, 300)
})

test('a republished import (new sourceRevision) is read fresh', async () => {
  const f = fixture({ rows: 20 }), cache = createImportRowCache()
  await network(f, cache).readNetwork()
  const rec = f.resources.get(f.importId); rec.sourceRevision = 2
  const before = f.reads.assertion
  await network(f, cache).readNetwork()
  assert.equal(f.reads.assertion - before, 20)
})

test('a tombstoned import is never served from the cache', async () => {
  const f = fixture({ rows: 20 }), cache = createImportRowCache()
  await network(f, cache).readNetwork()
  f.resources.set(f.importId, { ...f.resources.get(f.importId), deleted: true, payload: null })
  await assert.rejects(network(f, cache).readNetwork(), /private_import_not_found/)
})

test('partial (still publishing) imports are not cached', async () => {
  const f = fixture({ rows: 10, status: 'partial' }), cache = createImportRowCache()
  await network(f, cache).readNetwork(); await network(f, cache).readNetwork()
  assert.equal(f.reads.assertion, 20)
  assert.equal(cache.stats().entries, 0)
})

test('account erase drops cached rows, and an in-flight fill cannot re-insert them', async () => {
  const f = fixture({ rows: 40, delayMs: 2 }), cache = createImportRowCache()
  await network(f, cache).readNetwork()
  assert.equal(cache.stats().rows, 40)
  // Start a fill for a new revision, then erase while it is running.
  f.resources.get(f.importId).sourceRevision = 2
  const filling = network(f, cache).readNetwork().catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 10))
  cache.forgetOwner(owner.ownerId)
  await filling
  assert.equal(cache.stats().rows, 0, 'the fill that raced the erase was discarded')
  await network(f, cache).readNetwork()
  await deleteAccountData({ owner, backend: f.backend, jobs: [{ id: f.importId, assertionIds: f.ids, sources: [], revision: 0 }], rowCache: cache })
  assert.equal(cache.stats().rows, 0)
})

test('a caller that hits its deadline still leaves a warm cache for the retry', async () => {
  const f = fixture({ rows: 80, delayMs: 3 }), cache = createImportRowCache()
  const reader = createScopedImportReader({ readResource: f.backend.readResource, grant: { ownerId: owner.ownerId, importIds: [f.importId] }, rowCache: cache })
  await assert.rejects(reader(f.importId, { signal: AbortSignal.timeout(15) }), error => error.name === 'TimeoutError')
  // The fill keeps going in the background.
  for (let i = 0; i < 200 && cache.stats().rows === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cache.stats().rows, 80)
  const before = f.reads.assertion
  const started = Date.now()
  assert.equal((await reader(f.importId, { signal: AbortSignal.timeout(1000) })).assertions.length, 80)
  assert.equal(f.reads.assertion, before)
  assert.ok(Date.now() - started < 200)
})

test('concurrent cold reads share one fill', async () => {
  const f = fixture({ rows: 30, delayMs: 1 }), cache = createImportRowCache()
  await Promise.all([network(f, cache).readNetwork(), network(f, cache).readNetwork(), network(f, cache).readNetwork()])
  assert.equal(f.reads.assertion, 30)
})

test('entries are owner-scoped', async () => {
  const cache = createImportRowCache()
  const a = fixture({ rows: 5 }), other = { ownerId: 'cache-other', userId: 'cache-other-user' }
  const b = fixture({ rows: 7, ownerId: other.ownerId })
  await network(a, cache).readNetwork()
  assert.equal((await network(b, cache, other).readNetwork()).assertions.length, 7)
  assert.equal(b.reads.assertion, 7, 'another owner never reads the first owner\'s rows')
  assert.equal((await network(a, cache).readNetwork()).assertions.length, 5)
  assert.equal(a.reads.assertion, 5)
})

test('a changed manifest at the same revision is read fresh', async () => {
  const f = fixture({ rows: 10 }), cache = createImportRowCache()
  await network(f, cache).readNetwork()
  const extra = sha('extra-row'), rec = f.resources.get(f.importId)
  rec.payload.assertionIds.push(extra); Object.assign(rec.payload.counts, { accepted: 11, indexed: 11 })
  f.resources.set(extra, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: extra, ownerId: owner.ownerId, importId: f.importId, category: 'connections', fields: { 'first name': 'New' } } })
  assert.equal((await network(f, cache).readNetwork()).assertions.length, 11)
})

test('the cache is bounded by total rows (LRU) and by age', async () => {
  let clock = 0
  const cache = createImportRowCache({ maxRows: 100, ttlMs: 1000, now: () => clock })
  const one = fixture({ rows: 60, importSeed: 'one' }), two = fixture({ rows: 60, importSeed: 'two' })
  await network(one, cache).readNetwork(); await network(two, cache).readNetwork()
  assert.deepEqual(cache.stats(), { entries: 1, rows: 60, inflight: 0 })
  await network(one, cache).readNetwork()
  assert.equal(one.reads.assertion, 120, 'least recently used was evicted and re-read')
  await network(one, cache).readNetwork()
  assert.equal(one.reads.assertion, 120, 'and is warm again')
  clock = 2000
  await network(one, cache).readNetwork()
  assert.equal(one.reads.assertion, 180, 'expired entries are re-read')
})

test('the per-caller row limit still applies to cached rows', async () => {
  const f = fixture({ rows: 30 }), cache = createImportRowCache()
  await network(f, cache).readNetwork()
  await assert.rejects(createAccountNetwork({ owner, getBackend: async () => f.backend, rowCache: cache, observationLimit: 10 }).readNetwork(), /account_observation_limit/)
})
