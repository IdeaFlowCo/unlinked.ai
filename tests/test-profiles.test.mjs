import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { TEST_PROFILES, TEST_PROFILES_SHA256, TEST_PROFILE_PROVENANCE, isTestProfileId, testProfileBySlug, validateTestProfiles, operateTestProfileClaims } from '../mcp-server/test-profiles.mjs'

const TEST = TEST_PROFILES[0]
const LEGACY_ID = '11111111-2222-4333-8444-555555555555'
const legacySnapshot = { state: 'published', complete: true, revision: 'legacy-public-v1:' + 'a'.repeat(64), profiles: [{ id: LEGACY_ID, name: 'Real Person', headline: 'Real job', positions: [], education: [], skills: [] }], connections: [] }
const sharedSnapshot = { state: 'published', complete: true, revision: 'shared-public-v1:x', profiles: legacySnapshot.profiles, connections: [] }
const emailHash = createHash('sha256').update('tester@example.invalid').digest('hex')

// An in-memory UnlinkedLegacyAccount table with the production uniqueness
// constraints. It answers exactly the statements self-claims.mjs and the test
// operator send, and fails any statement whose $parameters are not all supplied
// (Neo4j does the same), so a missing parameter can never pass here unnoticed.
function graph() {
  const rows = []
  const unique = ['profileId', 'ownerId', 'userId', 'emailHash', 'legacyUserId']
  const record = value => ({ get: key => value[key] })
  const run = async (query, params = {}) => {
    for (const [, name] of query.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) assert.ok(Object.hasOwn(params, name), `missing parameter $${name}`)
    if (/^\s*OPTIONAL MATCH \(p:UnlinkedLegacyAccount/.test(query)) {
      if (rows.some(row => row.profileId === params.profileId || row.ownerId === params.ownerId || row.userId === params.userId || row.emailHash === params.emailHash)) return { records: [] }
      const row = { legacyUserId: params.legacyUserId, profileId: params.profileId, emailHash: params.emailHash, sourceSha256: params.sourceSha256, selfAsserted: true, claimEvidence: params.evidence, revoked: false,
        ownerId: params.ownerId, userId: params.userId, issuer: params.issuer, subject: params.subject, receiptId: params.receiptId, confirmedAt: params.now, ...(params.test ? { testProfile: true } : {}) }
      for (const key of unique) if (rows.some(other => other[key] === row[key])) throw Object.assign(new Error('constraint'), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' })
      rows.push(row); return { records: [record(row)] }
    }
    if (/^MATCH \(a:UnlinkedLegacyAccount \{profileId:\$profileId\}\) RETURN a LIMIT 1$/.test(query)) return { records: rows.filter(row => row.profileId === params.profileId).slice(0, 1).map(record) }
    if (/^UNWIND \$ids AS id MATCH \(a:UnlinkedLegacyAccount \{profileId: id\}\)/.test(query)) return { records: rows.filter(row => params.ids.includes(row.profileId)).map(row => record({ ...row, testProfile: row.testProfile ?? false })) }
    if (/RETURN a\.testProfile = true AND a\.selfAsserted = true AS test/.test(query)) return { records: rows.filter(row => row.profileId === params.profileId).map(row => record({ ...row, test: row.testProfile === true && row.selfAsserted === true })) }
    if (/DETACH DELETE a RETURN count\(\*\) AS deleted$/.test(query)) {
      const doomed = rows.filter(row => row.profileId === params.profileId && row.testProfile === true && row.selfAsserted === true)
      for (const row of doomed) rows.splice(rows.indexOf(row), 1)
      return { records: [record({ deleted: { toNumber: () => doomed.length } })] }
    }
    throw new Error(`unexpected statement: ${query.slice(0, 80)}`)
  }
  const session = { close: async () => {}, executeRead: work => work({ run }), executeWrite: work => work({ run }) }
  return { rows, session, driver: { session: () => session } }
}

const claims = store => createSelfClaims({ driver: store.driver, publicPeople: { read: async () => legacySnapshot }, slugIndex: async () => new Map([['real-person-1', LEGACY_ID]]) })
const tester = { ownerId: 'owner-test', userId: 'user-test' }
const claimRequest = (profileId, change = {}) => ({ owner: tester, issuer: 'https://idp.invalid', subject: 'subject-test', emailHash, profileId, evidence: 'self-asserted-linkedin-url-v1', ...change })

test('the shipped test profile set is one clearly marked fake person, separate from legacy ids', () => {
  assert.equal(TEST_PROFILES.length, 1)
  assert.equal(TEST.name, 'Ideaflow test profile')
  assert.match(TEST.id, /^test-profile-[0-9a-f-]{36}$/)
  assert.match(TEST.linkedinSlug, /^ideaflow-test-profile-[0-9a-f]{12}$/)
  assert.deepEqual({ kind: TEST.provenance.kind, test: TEST.provenance.test }, { kind: TEST_PROFILE_PROVENANCE, test: true })
  assert.match(TEST_PROFILES_SHA256, /^[a-f0-9]{64}$/)
  assert.ok(Object.isFrozen(TEST_PROFILES) && Object.isFrozen(TEST) && Object.isFrozen(TEST.provenance))
  assert.ok(isTestProfileId(TEST.id))
  // Only the shipped ids qualify, never a legacy UUID or another test-shaped id.
  for (const id of [LEGACY_ID, 'test-profile-00000000-0000-4000-8000-000000000000', `${TEST.id} `, '', null]) assert.equal(isTestProfileId(id), false)
  assert.throws(() => validateTestProfiles([{ ...TEST, provenance: { kind: TEST_PROFILE_PROVENANCE, test: false } }]), /provenance/)
  assert.throws(() => validateTestProfiles([{ ...TEST, name: 'Real Person' }]), /name/)
  assert.throws(() => validateTestProfiles([{ ...TEST, id: LEGACY_ID }]), /id/)
})

test('find-me finds the test profile only by its exact address; names never find it', async () => {
  const lane = claims(graph())
  assert.equal(await lane.lookupSlug(TEST.linkedinSlug), TEST.id)
  assert.equal(await lane.lookupSlug(TEST.linkedinSlug.toUpperCase()), TEST.id)
  assert.equal(await lane.lookupSlug(TEST.linkedinSlug + 'x'), null)
  assert.equal(await lane.lookupSlug('ideaflow-test-profile'), null)
  assert.equal(await lane.lookupSlug('real-person-1'), LEGACY_ID)
  assert.equal(await lane.lookupName('Ideaflow test profile'), null)
  assert.equal(testProfileBySlug(''), null)
  assert.deepEqual(await lane.preview(TEST.id), { test: true, profile: { name: TEST.name, headline: TEST.headline, connections: [] } })
  assert.equal(await lane.preview(LEGACY_ID), null)
})

test('claiming a test profile writes a marked claim with its own source hash and the signed-in identity', async () => {
  const store = graph(), lane = claims(store)
  assert.equal(await lane.claimable(TEST.id), true)
  const claimed = await lane.claim(claimRequest(TEST.id))
  assert.equal(claimed.test, true); assert.equal(claimed.profileId, TEST.id); assert.match(claimed.receiptId, /^[a-f0-9]{64}$/)
  const [row] = store.rows
  assert.equal(row.testProfile, true); assert.equal(row.sourceSha256, TEST_PROFILES_SHA256)
  assert.equal(row.issuer, 'https://idp.invalid'); assert.equal(row.subject, 'subject-test')
  assert.deepEqual([row.ownerId, row.userId, row.emailHash], [tester.ownerId, tester.userId, emailHash])
  assert.equal(await lane.claimable(TEST.id), false)
  // One claim per account: the same account cannot also take a real profile.
  await assert.rejects(lane.claim(claimRequest(LEGACY_ID)), /self_claim_conflict/)
  // A test profile is never claimed by a display-name match.
  await assert.rejects(claims(graph()).claim(claimRequest(TEST.id, { evidence: 'self-asserted-display-name-v1' })), /self_claim_input_invalid/)
})

test('a real legacy claim still records its legacy source, the identity, and no test mark', async () => {
  const store = graph()
  const claimed = await claims(store).claim(claimRequest(LEGACY_ID))
  assert.equal(claimed.test, undefined)
  const [row] = store.rows
  assert.equal(row.testProfile, undefined); assert.equal(row.sourceSha256, 'a'.repeat(64))
  assert.equal(row.subject, 'subject-test'); assert.equal(row.issuer, 'https://idp.invalid')
})

test('release refuses real profiles, unknown ids and unmarked claims, deleting nothing', async () => {
  const store = graph(), lane = claims(store)
  await lane.claim(claimRequest(LEGACY_ID))
  for (const id of [LEGACY_ID, 'test-profile-00000000-0000-4000-8000-000000000000', 'anything']) {
    await assert.rejects(operateTestProfileClaims({ args: ['release', id], session: store.session }), /test_profile_required/)
  }
  assert.equal(store.rows.length, 1); assert.equal(store.rows[0].profileId, LEGACY_ID)
  // A claim on the test profile that is not itself marked as a test claim is refused whole.
  store.rows.push({ profileId: TEST.id, ownerId: 'o2', userId: 'u2', emailHash: 'b'.repeat(64), legacyUserId: 'l2', selfAsserted: true, revoked: false })
  await assert.rejects(operateTestProfileClaims({ args: ['release', TEST.id], session: store.session }), /test_profile_claim_unmarked/)
  assert.equal(store.rows.length, 2)
  await assert.rejects(operateTestProfileClaims({ args: ['release'], session: store.session }), /arguments_invalid/)
  await assert.rejects(operateTestProfileClaims({ args: ['delete', TEST.id], session: store.session }), /arguments_invalid/)
})

test('release removes the test claim fully, and the same profile and account can claim again', async () => {
  const store = graph(), lane = claims(store)
  const first = await lane.claim(claimRequest(TEST.id))
  const listed = await operateTestProfileClaims({ args: ['list'], session: store.session })
  assert.deepEqual(listed.claims.map(value => [value.profileId, value.ownerId, value.receiptId, value.testProfile]), [[TEST.id, tester.ownerId, first.receiptId, true]])
  // Revoked is still blocking; release clears it too.
  store.rows[0].revoked = true
  const released = await operateTestProfileClaims({ args: ['release', TEST.id], session: store.session, now: () => 'now' })
  assert.deepEqual(released, { action: 'release', profileId: TEST.id, released: 1, receipts: [{ receiptId: first.receiptId, ownerId: tester.ownerId }], at: 'now' })
  assert.equal(store.rows.length, 0)
  assert.equal(await lane.claimable(TEST.id), true)
  const again = await lane.claim(claimRequest(TEST.id))
  assert.equal(again.test, true); assert.equal(store.rows.length, 1)
  // Releasing an unclaimed test profile is a no-op, not an error.
  await operateTestProfileClaims({ args: ['release', TEST.id], session: store.session })
  assert.equal((await operateTestProfileClaims({ args: ['release', TEST.id], session: store.session })).released, 0)
})

test('signed in, the test profile is found by its address, shown as a test, claimed, and stays off public surfaces', async t => {
  const store = graph(), audits = [], notified = []
  const selfClaims = claims(store)
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  let provisioned = false
  const readTestProfileClaim = async () => {
    const row = store.rows.find(value => value.ownerId === 'owner-a' && !value.revoked)
    return row?.testProfile ? { profileId: row.profileId, name: TEST.name, headline: TEST.headline, receiptId: row.receiptId } : null
  }
  handler = createPrivateBrowserHandler({
    baseUrl: origin,
    login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a', clientId: 'client', verifiedAt: Date.now(), verifiedEmail: 'tester@example.invalid', displayName: 'Ideaflow Mail' }) },
    resolveOwner: async () => provisioned ? { ownerId: 'owner-a', userId: 'user-a' } : null,
    signup: async () => { provisioned = true; return { ownerId: 'owner-a', userId: 'user-a' } },
    issueAccountGrant: async () => ({ token: 'grant' }), revokeAccountGrant: async () => {},
    selfClaims,
    notifyProfileClaimed: async (profileId, owner) => { notified.push(profileId); return 0 },
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], readLegacyProfile: async () => null, readTestProfileClaim }),
    readPublishedSnapshot: async () => sharedSnapshot,
    complete: async () => ({ matches: [] }),
    audit: async event => { audits.push(event) },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const begin = await request('/login')
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
  assert.equal(callback.headers.get('location'), '/find-me')
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const signed = (path, options = {}) => request(path, { ...options, headers: { Cookie: cookie, ...(options.headers ?? {}) } })
  const post = (path, fields) => signed(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams(fields) })
  const csrf = (await (await signed('/find-me')).text()).match(/name="csrf" value="([^"]+)"/)[1]

  // A near miss finds nothing; the exact address finds the labelled test card.
  assert.ok((await (await post('/find-me', { csrf, linkedinUrl: 'https://www.linkedin.com/in/ideaflow-test-profile/' })).text()).includes('LinkedIn profile lookup is not available right now'))
  const card = await (await post('/find-me', { csrf, linkedinUrl: `https://www.linkedin.com/in/${TEST.linkedinSlug}/` })).text()
  assert.ok(card.includes('Is this you?')); assert.ok(card.includes('Ideaflow test profile')); assert.ok(card.includes('Test profile.')); assert.ok(card.includes('Not a real person'))
  assert.ok(card.includes("Yes, that's me")); assert.ok(!card.includes('Listed by 0 members'))
  const candidate = card.match(/name="candidate" value="([^"]+)"/)[1]
  const claimed = await post('/claim-me', { csrf, candidate })
  assert.equal(claimed.status, 303); assert.equal(claimed.headers.get('location'), '/profile')
  assert.equal(store.rows.length, 1); assert.equal(store.rows[0].testProfile, true); assert.equal(store.rows[0].subject, 'subject-a')
  assert.ok(audits.some(event => event.event === 'test_profile_self_claimed' && event.profileId === TEST.id))
  assert.ok(!audits.some(event => event.event === 'legacy_profile_self_claimed'))

  // The claimer's own profile says what happened, marked as a test.
  const own = await (await signed('/profile')).text()
  assert.ok(own.includes('Test profile claimed:')); assert.ok(own.includes('Ideaflow test profile'))

  // Public surfaces never carry it: no public page, no search hit, signed in or
  // not, while the same routes serve a real profile.
  assert.equal((await request(`/people/${LEGACY_ID}`)).status, 200)
  assert.ok((await (await request('/api/people?q=Real%20Person')).text()).includes(LEGACY_ID))
  assert.equal((await request(`/people/${TEST.id}`)).status, 404)
  assert.equal((await signed(`/people/${TEST.id}`)).status, 404)
  for (const fetcher of [request, signed]) {
    const found = await fetcher('/api/people?q=Ideaflow%20test%20profile')
    assert.equal(found.status, 200)
    const body = await found.text()
    assert.ok(!body.includes(TEST.id) && !body.includes('Ideaflow test profile'))
  }
})
