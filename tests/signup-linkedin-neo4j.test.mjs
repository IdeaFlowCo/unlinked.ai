import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createNeo4jSignupLinkedinStore, createSignupLinkedin, unipileConfig } from '../mcp-server/signup-linkedin.mjs'

// Optional real-store evidence, only against a disposable loopback graph.
// Uses the same explicit test-driver boundary as test-profiles-neo4j.test.mjs.
const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER

test('real Neo4j: concurrent durable quotas, retry cap, cache, confirmation and active-owner projection', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const run = async (query, params = {}) => { const s = driver.session(); try { return await s.run(query, params) } finally { await s.close() } }
  const tag = randomUUID(), slug = 'signup-' + tag, owner = { ownerId: 'owner-' + tag, userId: 'user-' + tag }, other = { ownerId: 'other-' + tag, userId: 'other-user-' + tag }
  const keys = []
  t.after(async () => {
    await run('MATCH (s:UnlinkedSignupProfile) WHERE s.ownerId IN $ids DETACH DELETE s', { ids: [owner.ownerId, other.ownerId] })
    await run('MATCH (a:UnlinkedSignupLookup) WHERE a.key IN $keys DETACH DELETE a', { keys })
    await run('MATCH (c:UnlinkedSignupCache {slug:$slug}) DETACH DELETE c', { slug })
    await run('MATCH (b:OperationalOwner {testRun:$tag}) DETACH DELETE b', { tag })
    await run('MATCH (g:UnlinkedSignupGate {id:$tag}) DETACH DELETE g', { tag })
    await driver.close()
  })
  const store = createNeo4jSignupLinkedinStore(driver, 'neo4j', tag)
  await store.initialize()
  for (const who of [owner, other]) await run("CREATE (:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId, active:true, testRun:$tag})", { ...who, tag })
  let time = Date.now() + 120000, reads = 0, response = () => new Response('', { status: 503 })
  const settings = unipileConfig({ UNLINKED_UNIPILE_BASE: 'https://unipile.invalid/api/v1', UNLINKED_UNIPILE_KEY: 'test-key-must-never-be-stored', UNLINKED_UNIPILE_ACCOUNT_ID: 'test-account', UNLINKED_UNIPILE_DAILY_CAP: '10' })
  const service = createSignupLinkedin({ store: { ...store, reserve: args => { keys.push(args.key); assert.ok(!Object.values(args).includes(settings.key)); return store.reserve(args) } }, config: settings, now: () => time,
    fetchImpl: async () => { reads++; return response() } })
  const lookup = (who = owner, addressSlug = slug) => service.lookup({ owner: who, address: 'https://linkedin.com/in/' + addressSlug })
  const first = await Promise.all([lookup(), lookup()])
  assert.deepEqual(first.map(row => row.code).sort(), ['paced', 'provider_unavailable']); assert.equal(reads, 1)
  time += 3999; assert.equal((await lookup(other, 'other-' + slug)).code, 'paced'); assert.equal(reads, 1)
  time += 1; assert.equal((await lookup()).code, 'provider_unavailable')
  time += 4000; response = () => Response.json({ first_name: 'Signup', last_name: 'Person', headline: 'Public headline' })
  assert.equal((await lookup()).status, 'found'); assert.equal(reads, 3)
  // A fresh process shares both the successful account limit and slug cache.
  const fresh = createSignupLinkedin({ store: createNeo4jSignupLinkedinStore(driver, 'neo4j', tag), config: settings, now: () => time, fetchImpl: async () => { throw Error('cache must not fetch') } })
  assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/' + slug })).status, 'found')
  assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/another' })).code, 'account_limit')
  assert.equal((await lookup(other)).status, 'found'); assert.equal(reads, 3)
  assert.equal(await fresh.read(owner), null)
  await assert.rejects(fresh.confirm({ owner, slug: 'wrong' }), /self_claim_conflict/)
  const receipt = await fresh.confirm({ owner, slug })
  assert.equal((await fresh.read(owner)).profile.id, receipt.profileId)
  assert.ok((await fresh.list()).some(row => row.profile.id === receipt.profileId))
  const [stored] = (await run('MATCH (s:UnlinkedSignupProfile {profileId:$id}) RETURN properties(s) AS s', { id: receipt.profileId })).records
  assert.equal(stored.get('s').source, 'self-asserted-public-linkedin-v1')
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=false', owner)
  assert.equal(await fresh.read(owner), null); assert.ok(!(await fresh.list()).some(row => row.profile.id === receipt.profileId))
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=true', owner)
  await fresh.removeOwner(owner)
  assert.equal(await fresh.read(owner), null)
  assert.ok(!(await fresh.list()).some(row => row.profile.id === receipt.profileId))
  const quota = (await run('MATCH (a:UnlinkedSignupLookup {key:$key}) RETURN properties(a) AS a', { key: keys[0] })).records[0].get('a')
  assert.deepEqual(Object.keys(quota).sort(), ['attempts', 'key', 'succeeded'])
  assert.equal(Number(quota.attempts), 3); assert.equal(quota.succeeded, true)
  assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/' + slug })).code, 'account_limit')
  await assert.rejects(fresh.confirm({ owner, slug }), /self_claim_conflict/)
  assert.equal(await fresh.read(other), null)
  // Failures consume the three-attempt account budget permanently, including next day.
  const failKey = 'fail-' + tag; keys.push(failKey)
  for (let i = 0; i < 3; i++) {
    time += 4000
    const args = { key: failKey, slug: 'failure-' + slug, attempt: randomUUID(), now: time, day: Math.floor(time / 86400000), dailyCap: 10, pacingMs: 4000, timeoutMs: 12000 }
    assert.equal((await store.reserve(args)).allowed, true)
    assert.equal(await store.finish({ ...args, code: 'provider_unavailable' }), true)
  }
  time += 86400000
  assert.equal((await store.reserve({ key: failKey, slug: 'failure-' + slug, attempt: randomUUID(), now: time, day: Math.floor(time / 86400000), dailyCap: 10, pacingMs: 4000, timeoutMs: 12000 })).code, 'account_limit')
  await store.removeOwner(owner)
  assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/another' })).code, 'account_limit')
  const capKey = 'cap-' + tag; keys.push(capKey)
  assert.equal((await store.reserve({ key: capKey, slug: 'cap-' + slug, attempt: randomUUID(), now: time, day: Math.floor(time / 86400000), dailyCap: 0, pacingMs: 4000, timeoutMs: 12000 })).code, 'daily_cap')
})
