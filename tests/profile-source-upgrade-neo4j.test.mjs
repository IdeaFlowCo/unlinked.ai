import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createLegacyProfileBoundary } from '../mcp-server/profile-source-boundary.mjs'
import { createNeo4jSignupProfileStore, createSignupProfileLookup } from '../mcp-server/signup-profile-lookup.mjs'
import { testLookupSettings } from './helpers/signup-profile-store.mjs'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER

test('real Neo4j two-session HTTP race: legacy wins atomically, signup stays retired, and a failed recovered confirmation rolls back', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const run = async (query, params = {}) => { const session = driver.session(); try { return await session.run(query, params) } finally { await session.close() } }
  const tag = randomUUID(), owner = { ownerId: randomUUID(), userId: 'user-' + tag }, legacyId = randomUUID(), standinSlug = 'standin-' + tag, legacySlug = 'legacy-' + tag
  const keys = []
  t.after(async () => {
    await run('MATCH (a:UnlinkedLegacyAccount {ownerId:$ownerId}) DETACH DELETE a', owner)
    await run('MATCH (s:UnlinkedSignupProfile {ownerId:$ownerId}) DETACH DELETE s', owner)
    await run('MATCH (a:UnlinkedSignupLookup) WHERE a.key IN $keys DETACH DELETE a', { keys })
    await run('MATCH (c:UnlinkedSignupCache {slug:$slug}) DETACH DELETE c', { slug: standinSlug })
    await run('MATCH (g:UnlinkedSignupGate {id:$tag}) DETACH DELETE g', { tag })
    await run('MATCH (b:OperationalOwner {sourceOwnerId:$ownerId}) DETACH DELETE b', owner)
    await driver.close()
  })
  await run("CREATE (:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId, active:true})", owner)
  const boundary = createLegacyProfileBoundary(driver), store = createNeo4jSignupProfileStore(driver, 'neo4j', tag)
  await store.initialize()
  let reads = 0
  const signupLookup = createSignupProfileLookup({ store: { ...store, reserve: args => { keys.push(args.key); return store.reserve(args) } },
    settings: testLookupSettings(),
    adapter: { lookup: async () => { reads++; return { name: 'New Person', headline: 'Day one stand-in' } } } })
  const listOwned = async () => (await signupLookup.list()).filter(source => source.owner.ownerId === owner.ownerId)
  const legacy = { state: 'published', complete: true, revision: 'legacy-public-v1:' + 'a'.repeat(64), profiles: [{ id: legacyId, name: 'Legacy Person', headline: 'Legacy history wins', positions: [], education: [], skills: [] }], connections: [] }
  const selfClaims = boundary.wrapSelfClaims(createSelfClaims({ driver: boundary.driver, publicPeople: { read: async () => legacy }, slugIndex: async () => new Map([[legacySlug, legacyId]]) }))
  const readMembers = async () => (await run('MATCH (a:UnlinkedLegacyAccount {ownerId:$ownerId, revoked:false}) RETURN a.profileId AS id', owner)).records.map(row => row.get('id'))
  const read = createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => [], getBackend: async () => ({}), publicPeople: { read: async () => null }, readMembers, readSignupProfiles: listOwned })
  let handler, provisioned = false
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = 'http://127.0.0.1:' + server.address().port, origin = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl: origin,
    login: { begin: async () => ({ location: 'https://idp.invalid', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'same-person', clientId: 'client', verifiedAt: Date.now(), displayName: 'New Person' }) },
    resolveOwner: async () => provisioned ? owner : null, signup: async () => { provisioned = true; return owner }, issueAccountGrant: async () => ({ token: 'test-grant' }), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], readLegacyProfile: async () => null }), complete: async () => ({ matches: [] }),
    readPublishedSnapshot: read, selfClaims, signupLookup })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const session = async slug => {
    const begin = await request('/login'), loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    assert.equal(callback.status, 303, await callback.clone().text())
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await request('/find-me', { headers: { Cookie: cookie } })).text()
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
    const post = (path, fields) => request(path, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf, ...fields }) })
    const card = await (await post('/find-me', { linkedinUrl: 'https://linkedin.com/in/' + slug })).text()
    return { confirm: () => post('/claim-me', { candidate: card.match(/name="candidate" value="([^"]+)"/)[1] }) }
  }
  const signupSession = await session(standinSlug), legacySession = await session(legacySlug)
  assert.equal((await signupSession.confirm()).status, 303)
  const [signupSource] = await listOwned()
  assert.ok(signupSource); assert.equal((await read()).members.length, 1)
  // Both candidates were previewed before the first confirmation. A fresh
  // signup tab then races its cached reconfirmation against the legacy tab.
  const staleSignupSession = await session(standinSlug)
  const responses = await Promise.all([legacySession.confirm(), staleSignupSession.confirm()])
  assert.equal(responses[0].status, 303); assert.ok([200, 303].includes(responses[1].status))
  assert.equal(reads, 1)
  assert.deepEqual(await listOwned(), [])
  const after = await read(); assert.deepEqual(after.members, [legacyId]); assert.ok(!after.profiles.some(row => row.id === signupSource.profile.id))
  assert.equal(after.profiles.find(row => row.id === legacyId).headline, 'Legacy history wins')
  const retained = await signupLookup.readForExport(owner)
  assert.equal(retained.retired, true); assert.equal(retained.retiredByProfileId, legacyId); assert.equal(retained.profile.headline, 'Day one stand-in')
  const raceEvidence = { adapter: 'fake', lookups: reads, concurrentConfirmationStatuses: responses.map(response => response.status),
    publicMembers: after.members, publicProfiles: after.profiles, retiredSourceInOwnerExport: retained }
  await assert.rejects(signupLookup.confirm({ owner, slug: standinSlug }), /self_claim_conflict/)
  // Recovered Noos confirmation uses the same wrapped managed transaction.
  // Simulate a failing native callback: the legacy write and retirement undo together.
  await run('MATCH (a:UnlinkedLegacyAccount {ownerId:$ownerId}) DETACH DELETE a', owner)
  await run('MATCH (s:UnlinkedSignupProfile {ownerId:$ownerId}) SET s.retired=false', owner)
  const recovered = { confirm: () => {
    const s = boundary.driver.session()
    return s.executeWrite(async tx => {
      await tx.run('CREATE (:UnlinkedLegacyAccount {ownerId:$ownerId, userId:$userId, profileId:$legacyId, receiptId:$receiptId, revoked:false})', { ...owner, legacyId, receiptId: createHash('sha256').update(tag).digest('hex') })
      throw Error('native confirmation failed')
    }).finally(() => s.close())
  } }
  await assert.rejects(boundary.confirm(owner, legacyId, () => recovered.confirm()), /native confirmation failed/)
  assert.equal((await readMembers()).length, 0); assert.equal((await listOwned()).length, 1)
  const nativeFailureState = { legacyMembers: await readMembers(), signupSources: await listOwned() }
  // A failure in the retirement extension must also undo the native claim.
  const faultyDriver = new Proxy(driver, { get(target, key) {
    if (key !== 'session') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
    return options => {
      const session = target.session(options)
      return new Proxy(session, { get(targetSession, key) {
        if (key !== 'executeWrite') { const value = Reflect.get(targetSession, key); return typeof value === 'function' ? value.bind(targetSession) : value }
        return work => targetSession.executeWrite(tx => work({ run: (query, params) => {
          if (query.includes('MATCH (s:UnlinkedSignupProfile')) throw Error('retirement write failed')
          return tx.run(query, params)
        } }))
      } })
    }
  } })
  const faultBoundary = createLegacyProfileBoundary(faultyDriver)
  await assert.rejects(faultBoundary.confirm(owner, legacyId, async () => {
    const session = faultBoundary.driver.session()
    try { await session.executeWrite(tx => tx.run('CREATE (:UnlinkedLegacyAccount {ownerId:$ownerId, userId:$userId, profileId:$legacyId, receiptId:$receiptId, revoked:false})', { ...owner, legacyId, receiptId: createHash('sha256').update(tag).digest('hex') })) } finally { await session.close() }
  }), /retirement write failed/)
  assert.equal((await readMembers()).length, 0); assert.equal((await listOwned()).length, 1)
  const retirementFailureState = { legacyMembers: await readMembers(), signupSources: await listOwned() }
  await boundary.confirm(owner, legacyId, async () => {
    const s = boundary.driver.session()
    try { await s.executeWrite(tx => tx.run('CREATE (:UnlinkedLegacyAccount {ownerId:$ownerId, userId:$userId, profileId:$legacyId, receiptId:$receiptId, revoked:false})', { ...owner, legacyId, receiptId: createHash('sha256').update(tag).digest('hex') })) } finally { await s.close() }
  })
  assert.deepEqual(await listOwned(), []); assert.equal((await readMembers())[0], legacyId)
  if (process.env.UNLINKED_TEST_EVIDENCE_DIR) {
    await mkdir(process.env.UNLINKED_TEST_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.UNLINKED_TEST_EVIDENCE_DIR, 'neo4j-legacy-upgrade.json'), JSON.stringify({ ...raceEvidence,
      rollbackChecks: { nativeConfirmationFailure: nativeFailureState, retirementFailure: retirementFailureState },
      recoveredConfirmation: { publicLegacyId: (await readMembers())[0], activeSignupSources: await listOwned() },
    }, null, 2))
  }
})
