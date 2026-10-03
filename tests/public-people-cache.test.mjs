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
