import test from 'node:test'
import assert from 'node:assert/strict'
import { cachePublicPeopleReads } from '../src/utils/public-people/cached-store.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

const snapshot = (revision, name = 'Ada Lovelace') => ({ state: 'published', complete: true, revision, profiles: [{ id: 'a', name, positions: [], education: [], skills: [] }], connections: [] })

test('a dataset read is reused only while the published pointer names the same revision and digest', async () => {
  let pointer = { revision: 'r1', digest: 'd1' }, reads = 0, current = snapshot('r1')
  const store = cachePublicPeopleReads({ read: async () => { reads++; return structuredClone(current) }, publish: async () => 'published' }, async () => pointer)
  const first = await store.read('legacy')
  assert.equal(await store.read('legacy'), first)
  assert.equal(reads, 1)
  assert.ok(Object.isFrozen(first.profiles[0]))
  assert.equal(await store.publish(), 'published')
  // A new publication is read in full on the very next request.
  pointer = { revision: 'r2', digest: 'd2' }; current = snapshot('r2', 'Ada King')
  assert.equal((await store.read('legacy')).profiles[0].name, 'Ada King')
  assert.equal(reads, 2)
  // A revoked dataset (no published pointer) is never served from the cache.
  pointer = null; current = null
  assert.equal(await store.read('legacy'), null)
  assert.equal(reads, 3)
})

test('a pointer failure or a publication racing the read is never cached', async () => {
  let reads = 0, failing = true
  const store = cachePublicPeopleReads({ read: async () => { reads++; return snapshot('r2') } }, async () => { if (failing) throw Error('graph down'); return { revision: 'r1', digest: 'd1' } })
  await store.read('legacy'); await store.read('legacy')
  assert.equal(reads, 2)
  failing = false
  await store.read('legacy'); await store.read('legacy')
  assert.equal(reads, 4)
})

test('the default dataset cache evicts inactive imports and rereads them fresh', async () => {
  const reads = new Map(), pointers = new Map()
  const store = cachePublicPeopleReads({ read: async dataset => {
    reads.set(dataset, (reads.get(dataset) ?? 0) + 1)
    return snapshot('r1', `${dataset} read ${reads.get(dataset)}`)
  } }, async dataset => {
    pointers.set(dataset, (pointers.get(dataset) ?? 0) + 1)
    return { revision: 'r1', digest: 'd1' }
  })
  for (let i = 0; i < 64; i++) await store.read(`import-${i}`)
  const recent = await store.read('import-0')
  await store.read('import-64')
  assert.equal(await store.read('import-0'), recent)
  assert.equal(reads.get('import-0'), 1)
  assert.equal((await store.read('import-1')).profiles[0].name, 'import-1 read 2')
  assert.equal(reads.get('import-1'), 2)
  assert.equal(pointers.get('import-0'), 3)
  assert.equal(pointers.get('import-1'), 2)
})

test('the byte budget evicts snapshots before the entry limit and skips oversized data', async () => {
  const reads = new Map()
  const store = cachePublicPeopleReads({ read: async dataset => {
    reads.set(dataset, (reads.get(dataset) ?? 0) + 1)
    return snapshot('r1', (dataset === 'oversized' ? 'x'.repeat(10000) : 'x'.repeat(700)) + reads.get(dataset))
  } }, async () => ({ revision: 'r1', digest: 'd1' }), { maxEntries: 64, maxBytes: 4096 })
  await store.read('a')
  const second = await store.read('b')
  assert.equal(await store.read('b'), second)
  assert.equal(reads.get('b'), 1)
  assert.ok((await store.read('a')).profiles[0].name.endsWith('2'))
  assert.equal(reads.get('a'), 2)
  const held = await store.read('a')
  const oversized = await store.read('oversized')
  assert.equal(oversized.profiles[0].name.length, 10001)
  assert.notEqual(await store.read('oversized'), oversized)
  assert.equal(reads.get('oversized'), 2)
  assert.equal(await store.read('a'), held)
})

test('replacement and failed reads release retention before caching another dataset', async () => {
  let revision = 'r1', failing = false
  const reads = new Map()
  const store = cachePublicPeopleReads({ read: async dataset => {
    reads.set(dataset, (reads.get(dataset) ?? 0) + 1)
    if (failing && dataset === 'a') throw Error('unavailable')
    return snapshot(revision, 'x'.repeat(700))
  } }, async () => ({ revision, digest: revision }), { maxBytes: 4096 })
  await store.read('a')
  revision = 'r2'
  const replacement = await store.read('a')
  assert.equal(await store.read('a'), replacement)
  assert.equal(reads.get('a'), 2)
  revision = 'r3'; failing = true
  await assert.rejects(store.read('a'), /unavailable/)
  const second = await store.read('b')
  assert.equal(await store.read('b'), second)
  assert.equal(reads.get('b'), 1)
  failing = false
  assert.equal((await store.read('a')).revision, 'r3')
  assert.equal(reads.get('a'), 4)
})

test('zero retention limits still check pointers and return fresh plain data', async () => {
  for (const limits of [{ maxEntries: 0 }, { maxBytes: 0 }]) {
    let reads = 0, pointers = 0
    const store = cachePublicPeopleReads({ read: async () => { reads++; return snapshot('r1') } }, async () => {
      pointers++
      return { revision: 'r1', digest: 'd1' }
    }, limits)
    const first = await store.read('a'), second = await store.read('a')
    assert.deepEqual(second, first)
    assert.notEqual(second, first)
    assert.equal(reads, 2)
    assert.equal(pointers, 2)
    assert.equal(Object.getPrototypeOf(second), Object.prototype)
  }
})

test('the compiled index is reused across readers only for content-addressed sources', async () => {
  let builds = 0, revision = 'shared-1'
  const source = async () => { builds++; return snapshot(revision) }
  source.revisionIdentifiesContent = true
  const first = await createPublicPeopleReader({ readPublishedSnapshot: source }).list({ query: 'ada' })
  const second = await createPublicPeopleReader({ readPublishedSnapshot: source }).list({ query: 'ada' })
  assert.deepEqual(second, first)
  assert.equal(builds, 2)
  assert.ok(Object.isFrozen(first.profiles[0]))
  // Rows handed to one request cannot change what the next one sees.
  assert.throws(() => { 'use strict'; first.profiles[0].name = 'Changed' })
  revision = 'shared-2'
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list()).profiles[0].name, 'Ada Lovelace')

  // A source that does not promise content-addressed revisions is rebuilt every time.
  let name = 'Ada Lovelace'
  const plain = async () => snapshot('same', name)
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: plain }).list()).profiles[0].name, 'Ada Lovelace')
  name = 'Grace Hopper'
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: plain }).list()).profiles[0].name, 'Grace Hopper')
})

test('warm readers skip profile compilation and rebuild immediately for a changed revision', async () => {
  let inspections = 0, revision = 'r1', name = 'Ada Lovelace'
  const source = async () => {
    const value = snapshot(revision, name)
    Object.defineProperty(value.profiles[0], 'positions', { enumerable: true, get() { inspections++; return [] } })
    return value
  }
  source.revisionIdentifiesContent = true
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list()).profiles[0].name, name)
  const cold = inspections
  await createPublicPeopleReader({ readPublishedSnapshot: source }).list()
  assert.equal(inspections, cold)
  revision = 'r2'; name = 'Grace Hopper'
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list()).profiles[0].name, name)
  assert.ok(inspections > cold)
})

test('a nonpublished or incomplete source never returns its previously cached profiles', async () => {
  let value = snapshot('r1')
  const source = async () => value
  source.revisionIdentifiesContent = true
  await createPublicPeopleReader({ readPublishedSnapshot: source }).list()
  for (const change of [{ state: 'revoked' }, { complete: false }]) {
    value = { ...snapshot('r1'), ...change }
    await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: source }).list(), { status: 503 })
  }
})

test('photos refresh independently of the cached People revision on all profile surfaces', async () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const other = '87654321-4321-4321-4321-cba987654321'
  const value = snapshot('r1')
  value.profiles[0].id = id
  value.profiles.push({ ...value.profiles[0], id: other, name: 'Grace Hopper' })
  value.connections = [{ fromId: id, toId: other }]
  const source = async () => value
  source.revisionIdentifiesContent = true
  let photo = `/people/${id}/photo?v=1234567890abcdef`
  const photoFor = key => key === id ? photo : null
  const reader = () => createPublicPeopleReader({ readPublishedSnapshot: source, photoFor })
  assert.equal((await reader().list()).profiles[0].photo, photo)
  photo = `/people/${id}/photo?v=abcdef1234567890`
  assert.equal((await reader().list()).profiles[0].photo, photo)
  assert.equal((await reader().profile({ id })).profile.photo, photo)
  assert.equal((await reader().lookup({ ids: [id] })).get(id).photo, photo)
  assert.equal((await reader().neighbors({ id: other }))[0].photo, photo)
  photo = null
  assert.equal((await reader().list()).profiles[0].photo, undefined)
  assert.equal((await reader().profile({ id })).profile.photo, undefined)
  // A reader without a photo provider cannot inherit another reader's photos.
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list()).profiles[0].photo, undefined)
})
