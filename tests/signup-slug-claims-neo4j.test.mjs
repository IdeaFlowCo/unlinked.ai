import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createLegacyProfileBoundary } from '../mcp-server/profile-source-boundary.mjs'
import { createNeo4jSignupLinkedinStore, createSignupLinkedin, signupProfileId, unipileConfig } from '../mcp-server/signup-linkedin.mjs'

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER

test('real Neo4j: unique active slug fences concurrent accounts, releases on delete/legacy retirement, and backfills old sources', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const run = async (query, params = {}) => { const s = driver.session(); try { return await s.run(query, params) } finally { await s.close() } }
  const tag = randomUUID(), slug = 'slug-' + tag, legacyId = randomUUID()
  const owners = Array.from({ length: 4 }, () => ({ ownerId: randomUUID(), userId: randomUUID() }))
  const gates = [tag + '-a', tag + '-b'], keys = owners.map(owner => signupProfileId(owner).slice('member-linkedin-'.length))
  t.after(async () => {
    await run('MATCH (s:UnlinkedSignupProfile) WHERE s.ownerId IN $ids DETACH DELETE s', { ids: owners.map(row => row.ownerId) })
    await run('MATCH (a:UnlinkedSignupLookup) WHERE a.key IN $keys DETACH DELETE a', { keys })
    await run('MATCH (c:UnlinkedSignupCache {slug:$slug}) DETACH DELETE c', { slug })
    await run('MATCH (g:UnlinkedSignupGate) WHERE g.id IN $gates DETACH DELETE g', { gates })
    await run('MATCH (a:UnlinkedLegacyAccount {profileId:$legacyId}) DETACH DELETE a', { legacyId })
    await run('MATCH (b:OperationalOwner {testRun:$tag}) DETACH DELETE b', { tag })
    await driver.close()
  })
  for (const owner of owners) await run("CREATE (:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId, active:true, testRun:$tag})", { ...owner, tag })
  let racing = false, checked = 0, release
  const bothChecked = new Promise(resolve => { release = resolve })
  const racingDriver = new Proxy(driver, { get(target, key) {
    if (key !== 'session') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
    return options => {
      const session = target.session(options)
      return new Proxy(session, { get(targetSession, key) {
        if (key !== 'executeWrite') { const value = Reflect.get(targetSession, key); return typeof value === 'function' ? value.bind(targetSession) : value }
        return work => targetSession.executeWrite(tx => work({ run: async (query, params) => {
          const result = await tx.run(query, params)
          // Hold both transactions after they see an unclaimed slug, before
          // either writes. A separate gate makes the constraint the arbiter.
          if (racing && checked < 2 && query.includes('RETURN s.key AS key LIMIT 1')) {
            assert.equal(result.records.length, 0)
            if (++checked === 2) release()
            await bothChecked
          }
          return result
        } }))
      } })
    }
  } })
  const stores = gates.map(gate => createNeo4jSignupLinkedinStore(racingDriver, 'neo4j', gate))
  for (const store of stores) await store.initialize()
  let reads = 0
  const config = unipileConfig({ UNLINKED_UNIPILE_BASE: 'https://unipile.invalid', UNLINKED_UNIPILE_KEY: 'test-only', UNLINKED_UNIPILE_ACCOUNT_ID: 'test-account' })
  const services = stores.map(store => createSignupLinkedin({ store, config, fetchImpl: async () => { reads++; return Response.json({ first_name: 'Public', last_name: 'Person' }) } }))
  const lookup = (owner, service = services[0]) => service.lookup({ owner, address: 'https://linkedin.com/in/' + slug })
  assert.equal((await lookup(owners[0])).status, 'found')
  assert.equal((await lookup(owners[1], services[1])).status, 'found')
  // Distinct reservation gates exercise the unique constraint as well as the
  // normal shared-gate lock: neither account can commit a duplicate slug.
  racing = true
  const results = await Promise.allSettled(owners.slice(0, 2).map((owner, i) => services[i].confirm({ owner, slug })))
  racing = false; assert.equal(checked, 2)
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  const rejected = results.find(row => row.status === 'rejected'); assert.match(rejected.reason.message, /self_claim_conflict/)
  const winner = results.findIndex(row => row.status === 'fulfilled'), loser = 1 - winner
  const claimed = async () => (await run('MATCH (s:UnlinkedSignupProfile {activeSlug:$slug}) RETURN s.ownerId AS ownerId', { slug })).records.map(row => row.get('ownerId'))
  assert.deepEqual(await claimed(), [owners[winner].ownerId])
  assert.equal((await lookup(owners[loser])).code, 'slug_claimed')
  await assert.rejects(services[loser].confirm({ owner: owners[loser], slug }), /self_claim_conflict/)
  // Same-owner reconfirmation is idempotent; it does not create a second row.
  await services[winner].confirm({ owner: owners[winner], slug })
  await services[winner].removeOwner(owners[winner])
  assert.deepEqual(await claimed(), [])
  assert.equal((await lookup(owners[loser])).status, 'found')
  await services[loser].confirm({ owner: owners[loser], slug })
  const boundary = createLegacyProfileBoundary(driver)
  await boundary.confirm(owners[loser], legacyId, async () => {
    const session = boundary.driver.session()
    try { await session.executeWrite(tx => tx.run('CREATE (:UnlinkedLegacyAccount {ownerId:$ownerId,userId:$userId,profileId:$legacyId,receiptId:$tag,revoked:false})', { ...owners[loser], legacyId, tag })) } finally { await session.close() }
  })
  assert.deepEqual(await claimed(), [])
  const retired = await services[loser].readForExport(owners[loser])
  assert.equal(retired.retired, true); assert.equal(retired.retiredByProfileId, legacyId)
  assert.equal((await lookup(owners[2])).status, 'found')
  await services[0].confirm({ owner: owners[2], slug })
  assert.deepEqual(await claimed(), [owners[2].ownerId]); assert.equal(reads, 1)
  // A direct durable write also cannot bypass uniqueness.
  await assert.rejects(run('CREATE (:UnlinkedSignupProfile {key:$key,activeSlug:$slug})', { key: 'duplicate-' + tag, slug }), error => error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed')
  // Sources created before this change acquire the claim on initialization;
  // retained retired rows with the same slug never acquire it.
  await run('MATCH (s:UnlinkedSignupProfile {ownerId:$ownerId}) REMOVE s.activeSlug', owners[2])
  await stores[0].initialize()
  assert.deepEqual(await claimed(), [owners[2].ownerId])
  await assert.rejects(services[loser].confirm({ owner: owners[loser], slug }), /self_claim_conflict/)
  // Only ACTIVE owners hold a claim. Reusing a revoked binding's slug retires
  // its old source, so later reactivation cannot publish duplicate identities.
  assert.equal((await lookup(owners[3])).code, 'slug_claimed')
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=false', owners[2])
  assert.equal((await lookup(owners[3])).status, 'found')
  await services[0].confirm({ owner: owners[3], slug })
  await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) SET b.active=true', owners[2])
  assert.equal(await services[0].read(owners[2]), null)
  assert.equal((await services[0].readForExport(owners[2])).retired, true)
  await assert.rejects(services[0].confirm({ owner: owners[2], slug }), /self_claim_conflict/)
  assert.deepEqual(await claimed(), [owners[3].ownerId]); assert.equal(reads, 1)
})
