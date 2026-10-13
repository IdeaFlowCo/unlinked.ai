import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createPersonLookup, createNeo4jPersonLookupStore } from '../mcp-server/person-lookup.mjs'
import { createNeo4jProfileLinkStore } from '../mcp-server/profile-social-links.mjs'
import { createNeo4jSignupProfileStore } from '../mcp-server/signup-profile-lookup.mjs'

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
if (process.env.UNLINKED_TEST_NEO4J_REQUIRED === '1') {
  assert.ok(enabled && process.env.UNLINKED_TEST_NEO4J_PASSWORD, 'Required disposable Neo4j fixture must configure a loopback Bolt URI, driver and password')
}
test('durable person lookup shares reservations across processes, caps owners, expires caches and fences removed owners', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const run = async (q, p = {}) => { const s = driver.session(); try { return await s.run(q, p) } finally { await s.close() } }
  const tag = randomUUID(), owner = { ownerId: `lookup-owner-${tag}`, userId: `lookup-user-${tag}` }, other = { ownerId: `lookup-other-${tag}`, userId: `lookup-other-user-${tag}` }
  const prefix = `lookup-${tag}-`
  t.after(async () => {
    await run('MATCH (n:UnlinkedPersonLookup) WHERE n.ownerId IN $owners DETACH DELETE n', { owners: [owner.ownerId, other.ownerId] })
    await run('MATCH (n:UnlinkedProfileLinks) WHERE n.ownerId IN $owners DETACH DELETE n', { owners: [owner.ownerId, other.ownerId] })
    await run('MATCH (n:UnlinkedSignupCache) WHERE n.slug STARTS WITH $prefix DETACH DELETE n', { prefix })
    await run('MATCH (n:UnlinkedSignupGate {id:$tag}) DETACH DELETE n', { tag })
    await run('MATCH (n:OperationalOwner {testRun:$tag}) DETACH DELETE n', { tag })
    await driver.close()
  })
  for (const who of [owner, other]) await run("CREATE (:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId,active:true,testRun:$tag})", { ...who, tag })
  // Match composition startup: the shared gate/cache constraints belong to signup.
  await createNeo4jSignupProfileStore(driver, 'neo4j', tag).initialize()
  const store = createNeo4jPersonLookupStore(driver, 'neo4j', tag); await store.initialize()
  let time = Date.now() + 120000, reads = 0, successful = false
  const settings = { dailyCap: 50, pacingMs: 4000, timeoutMs: 1000 }
  const adapter = { lookup: async () => { reads++; return successful ? { name: 'Public Person' } : null } }
  const service = () => createPersonLookup({ store: createNeo4jPersonLookupStore(driver, 'neo4j', tag), settings, adapter, now: () => time })
  const lookup = (client, who = owner, suffix = 'target') => client.lookup({ owner: who, address: `https://linkedin.com/in/${prefix}${suffix}` })
  const a = service(), b = service()
  const concurrent = await Promise.all([lookup(a), lookup(b)])
  assert.deepEqual(concurrent.map(r => r.code).sort(), ['not_found', 'paced']); assert.equal(reads, 1)
  // New processes and new sessions cannot reset the per-owner daily allowance.
  for (let i = 1; i < 20; i++) { time += 4000; assert.equal((await lookup(service(), owner, 'target-' + i)).code, 'not_found') }
  time += 4000; assert.equal((await lookup(service())).code, 'owner_limit'); assert.equal(reads, 20)
  // A different owner has a separate allowance but the same global pacing gate.
  successful = true
  assert.equal((await lookup(b, other)).status, 'found'); assert.equal(reads, 21)
  assert.equal((await lookup(service(), owner)).cached, true); assert.equal(reads, 21)
  time += 86400000 + 4000
  assert.equal((await lookup(service(), owner)).cached, false); assert.equal(reads, 22)
  const links = createNeo4jProfileLinkStore(driver)
  await links.initialize()
  const profileId = `profile-${tag}`
  await links.set(owner, { profileId, links: ['https://x.com/fictional_person'] })
  assert.deepEqual(await links.forProfile(profileId), [{ kind: 'x', label: 'X', url: 'https://x.com/fictional_person' }])
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.userId=$differentUser', { ownerId: owner.ownerId, differentUser: `different-${tag}` })
  assert.equal(await links.forProfile(profileId), null, 'a mismatched owner binding hides public links')
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.userId=$userId', owner)
  assert.equal((await links.forProfile(profileId)).length, 1)
  await run("MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=false", owner)
  assert.equal(await links.forProfile(profileId), null, 'an inactive owner hides public links')
  assert.equal((await lookup(service(), owner)).code, 'unavailable'); assert.equal(reads, 22)
  await store.removeOwner(owner)
  assert.equal((await run('MATCH (n:UnlinkedPersonLookup {ownerId:$ownerId}) RETURN count(n) AS count', owner)).records[0].get('count').toNumber(), 0)
})
