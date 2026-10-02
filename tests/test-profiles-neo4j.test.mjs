import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { TEST_PROFILES, TEST_PROFILES_SHA256, operateTestProfileClaims, CLAIMED_PROFILE_FOR_OWNER, OWNER_FOR_CLAIMED_PROFILE, CLAIMED_MEMBER_PROFILES } from '../mcp-server/test-profiles.mjs'

// Real Neo4j evidence for the test-profile lane: the production claim Cypher,
// the production uniqueness constraints (copied from Noos legacy-links), the
// operator release, and the claim readers behind public membership. Opt-in and
// loopback-only, so it can never reach a shared or production graph:
//   UNLINKED_TEST_NEO4J_URI=bolt://127.0.0.1:<port> UNLINKED_TEST_NEO4J_PASSWORD=... \
//   UNLINKED_TEST_NEO4J_DRIVER=/path/to/node_modules/neo4j-driver node --test tests/test-profiles-neo4j.test.mjs
const uri = process.env.UNLINKED_TEST_NEO4J_URI
const loopback = typeof uri === 'string' && /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri)
const TEST = TEST_PROFILES[0]

test('real Neo4j: test claims are marked, invisible to membership readers, and released for a fresh claim', { skip: !loopback || !process.env.UNLINKED_TEST_NEO4J_DRIVER }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD ?? ''))
  // One ordered teardown: the operator session, this run's nodes, then the driver.
  let session = null
  const run = async (query, params = {}) => { const session = driver.session({ database: 'neo4j' }); try { return await session.run(query, params) } finally { await session.close() } }
  for (const property of ['legacyUserId', 'profileId', 'emailHash', 'ownerId', 'userId']) await run(`CREATE CONSTRAINT unlinked_legacy_${property} IF NOT EXISTS FOR (n:UnlinkedLegacyAccount) REQUIRE n.${property} IS UNIQUE`)
  const tag = randomUUID()
  const cleanup = () => run('MATCH (n) WHERE n.testRun = $tag OR n.profileId = $test DETACH DELETE n', { tag, test: TEST.id })
  await cleanup()
  t.after(async () => { await session?.close(); await cleanup(); await driver.close() })

  const realProfile = randomUUID(), real = { ownerId: randomUUID(), userId: 'user-' + tag }, tester = { ownerId: randomUUID(), userId: 'tester-' + tag }
  for (const owner of [real, tester]) await run(`CREATE (:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId, active: true, testRun: $tag})`, { ...owner, tag })
  const legacy = { revision: 'legacy-public-v1:' + 'c'.repeat(64), profiles: [{ id: realProfile, name: 'Real Person' }] }
  const lane = createSelfClaims({ driver, publicPeople: { read: async () => legacy }, slugIndex: async () => new Map() })
  const hash = value => createHash('sha256').update(value + tag).digest('hex')
  const request = (owner, profileId, email) => ({ owner, issuer: 'https://idp.invalid', subject: 'subject-' + owner.ownerId, emailHash: hash(email), profileId, evidence: 'self-asserted-linkedin-url-v1' })

  await lane.claim(request(real, realProfile, 'real'))
  await run('MATCH (a:UnlinkedLegacyAccount {profileId: $id}) SET a.testRun = $tag', { id: realProfile, tag })
  const first = await lane.claim(request(tester, TEST.id, 'tester'))
  const [row] = (await run('MATCH (a:UnlinkedLegacyAccount {profileId: $id}) RETURN properties(a) AS a', { id: TEST.id })).records.map(record => record.get('a'))
  assert.equal(row.testProfile, true); assert.equal(row.sourceSha256, TEST_PROFILES_SHA256); assert.equal(row.subject, 'subject-' + tester.ownerId); assert.equal(row.receiptId, first.receiptId)

  // The readers behind membership, Connect, notifications and the agent API skip the test claim only.
  const ids = (await run(CLAIMED_MEMBER_PROFILES)).records.map(record => record.get('id'))
  assert.ok(ids.includes(realProfile)); assert.ok(!ids.includes(TEST.id))
  assert.equal((await run(OWNER_FOR_CLAIMED_PROFILE, { id: TEST.id })).records.length, 0)
  assert.equal((await run(OWNER_FOR_CLAIMED_PROFILE, { id: realProfile })).records[0].get('ownerId'), real.ownerId)
  assert.equal((await run(CLAIMED_PROFILE_FOR_OWNER, tester)).records.length, 0)
  assert.equal((await run(CLAIMED_PROFILE_FOR_OWNER, real)).records[0].get('id'), realProfile)

  // The database enforces one claim per profile, account and address.
  await assert.rejects(lane.claim(request(tester, realProfile, 'tester')), /self_claim_conflict/)
  await assert.rejects(lane.claim(request(real, TEST.id, 'real')), /self_claim_conflict/)

  session = driver.session({ database: 'neo4j' })
  await assert.rejects(operateTestProfileClaims({ args: ['release', realProfile], session }), /test_profile_required/)
  assert.equal((await run('MATCH (a:UnlinkedLegacyAccount {profileId: $id}) RETURN count(a) AS n', { id: realProfile })).records[0].get('n').toNumber(), 1)
  const listed = await operateTestProfileClaims({ args: ['list'], session })
  assert.deepEqual(listed.claims.map(value => [value.profileId, value.ownerId, value.testProfile]), [[TEST.id, tester.ownerId, true]])
  assert.equal(typeof listed.claims[0].confirmedAt, 'number')
  const released = await operateTestProfileClaims({ args: ['release', TEST.id], session })
  assert.equal(released.released, 1); assert.equal(released.receipts[0].receiptId, first.receiptId)
  assert.equal((await run('MATCH (a:UnlinkedLegacyAccount {profileId: $id}) RETURN count(a) AS n', { id: TEST.id })).records[0].get('n').toNumber(), 0)

  // Same profile, same account, same address: claimable again.
  assert.equal(await lane.claimable(TEST.id), true)
  assert.equal((await lane.claim(request(tester, TEST.id, 'tester'))).test, true)

  // An unmarked row on the test profile is refused whole.
  await operateTestProfileClaims({ args: ['release', TEST.id], session })
  await run('CREATE (:UnlinkedLegacyAccount {profileId: $id, ownerId: $owner, userId: $user, emailHash: $email, legacyUserId: $legacy, selfAsserted: true, revoked: false, testRun: $tag})', { id: TEST.id, owner: randomUUID(), user: 'u-' + tag, email: hash('unmarked'), legacy: randomUUID(), tag })
  await assert.rejects(operateTestProfileClaims({ args: ['release', TEST.id], session }), /test_profile_claim_unmarked/)
  assert.equal((await run('MATCH (a:UnlinkedLegacyAccount {profileId: $id}) RETURN count(a) AS n', { id: TEST.id })).records[0].get('n').toNumber(), 1)
})
