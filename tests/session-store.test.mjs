import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createMemorySessionStore, createNeo4jSessionStore } from '../mcp-server/session-store.mjs'

test('session store: put, get, expiry, delete, deleteOwner, prune', async () => {
  const store = createMemorySessionStore()
  
  // Nothing exists yet
  assert.equal(await store.get('hash1', 1000), null)

  const record1 = { ownerId: 'o1', userId: 'u1', accountLabel: 'a', displayName: 'A', csrf: 'csrf1', expiresAt: 2000, createdAt: 1000 }
  await store.put('hash1', record1)

  // Get works before expiry
  const retrieved1 = await store.get('hash1', 1500)
  assert.deepEqual(retrieved1, record1)

  // Get after expiry returns null and deletes
  assert.equal(await store.get('hash1', 2001), null)
  assert.equal(await store.get('hash1', 1500), null) // It was deleted

  await store.put('hash2', { ...record1, expiresAt: 3000 })
  await store.delete('hash2')
  assert.equal(await store.get('hash2', 1500), null) // Deleted

  // Owner deletion
  await store.put('hash3', { ownerId: 'o1', userId: 'u1', accountLabel: 'a', displayName: 'A', csrf: 'csrf1', expiresAt: 3000, createdAt: 1000 })
  await store.put('hash4', { ownerId: 'o2', userId: 'u2', accountLabel: 'b', displayName: 'B', csrf: 'csrf2', expiresAt: 3000, createdAt: 1000 })
  await store.deleteOwner('o1')
  assert.equal(await store.get('hash3', 1500), null)
  assert.ok(await store.get('hash4', 1500))

  // Prune
  await store.put('hash5', { ownerId: 'o2', userId: 'u2', accountLabel: 'b', displayName: 'B', csrf: 'csrf2', expiresAt: 4000, createdAt: 1000 })
  await store.prune(3000)
  assert.equal(await store.get('hash4', 1500), null) // expired at 3000
  assert.ok(await store.get('hash5', 1500)) // expires at 4000
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const loopback = typeof uri === 'string' && /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri)

test('real Neo4j session store', { skip: !loopback || !process.env.UNLINKED_TEST_NEO4J_DRIVER }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD ?? ''))
  
  const store = createNeo4jSessionStore(driver)
  await store.initialize()
  
  const tag = randomUUID()
  const cleanup = async () => {
    const session = driver.session({ database: 'neo4j' })
    try {
      await session.run('MATCH (s:UnlinkedSession) WHERE s.ownerId CONTAINS $tag DETACH DELETE s', { tag })
    } finally {
      await session.close()
    }
  }
  await cleanup()
  t.after(async () => { await cleanup(); await driver.close() })
  
  const ownerId1 = 'neo-o1-' + tag
  const ownerId2 = 'neo-o2-' + tag
  
  assert.equal(await store.get('hash1', 1000), null)

  const record1 = { ownerId: ownerId1, userId: 'u1', accountLabel: 'a', displayName: 'A', csrf: 'csrf1', expiresAt: 2000, createdAt: 1000 }
  await store.put('hash1', record1)

  const retrieved1 = await store.get('hash1', 1500)
  assert.deepEqual(retrieved1, record1)

  assert.equal(await store.get('hash1', 2001), null)
  assert.equal(await store.get('hash1', 1500), null)

  await store.put('hash2', { ...record1, expiresAt: 3000 })
  await store.delete('hash2')
  assert.equal(await store.get('hash2', 1500), null)

  await store.put('hash3', { ownerId: ownerId1, userId: 'u1', accountLabel: 'a', displayName: 'A', csrf: 'csrf1', expiresAt: 3000, createdAt: 1000 })
  await store.put('hash4', { ownerId: ownerId2, userId: 'u2', accountLabel: 'b', displayName: 'B', csrf: 'csrf2', expiresAt: 3000, createdAt: 1000 })
  await store.deleteOwner(ownerId1)
  assert.equal(await store.get('hash3', 1500), null)
  assert.ok(await store.get('hash4', 1500))

  await store.put('hash5', { ownerId: ownerId2, userId: 'u2', accountLabel: 'b', displayName: 'B', csrf: 'csrf2', expiresAt: 4000, createdAt: 1000 })
  await store.prune(3000)
  assert.equal(await store.get('hash4', 1500), null)
  assert.ok(await store.get('hash5', 1500))
})