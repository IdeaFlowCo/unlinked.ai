import { createHash } from 'node:crypto'

// Test profiles: a tiny, separately sourced set of clearly fake people that
// /find-me can find and an account can claim, so the claim lane can be checked
// end to end without touching a real person or the recovered legacy dataset
// (whose bytes and provenance hash stay exactly as published).
//
// - Found only by their exact made-up LinkedIn address, never by name.
// - Never part of the shared People snapshot, so never in the directory,
//   search, public profile pages, the agent API or account exports. A claim of
//   one is visible only on the claimer's own /profile page, labelled as a test.
// - A claim writes the ordinary self-asserted UnlinkedLegacyAccount row, marked
//   testProfile:true, so the real uniqueness rules are exercised. Every reader
//   that turns a claim into membership, a public profile or a network anchor
//   ignores marked rows.
// - test-profile-claims-operator.mjs release <profileId> deletes claims on test
//   profiles only, so the same profile and account can claim again.
export const TEST_PROFILE_PROVENANCE = 'unlinked-test-profile-v1'
const TEST_ID = /^test-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

export const TEST_PROFILES = freeze([
  {
    id: 'test-profile-9a4a2f33-9a33-4cfb-9e87-a0ffcf137baf',
    name: 'Ideaflow test profile',
    headline: 'Test profile for checking the claim flow. Not a real person.',
    linkedinSlug: 'ideaflow-test-profile-b8052ec5d075',
    provenance: { kind: TEST_PROFILE_PROVENANCE, test: true, ticket: 'unlinked-ovs', addedAt: '2026-10-02', purpose: 'isolated claim-flow test for ideaflowmail@gmail.com' },
  },
])

// Recorded on each test claim as its sourceSha256, like a legacy claim records
// the legacy source it was made against.
export const TEST_PROFILES_SHA256 = createHash('sha256').update(JSON.stringify(TEST_PROFILES)).digest('hex')

export function validateTestProfiles(profiles = TEST_PROFILES) {
  const ids = new Set(), slugs = new Set()
  for (const profile of profiles) {
    if (!TEST_ID.test(profile.id) || ids.has(profile.id)) throw Error('test_profile_id_invalid')
    if (!/^[a-z0-9-]{8,100}$/.test(profile.linkedinSlug) || slugs.has(profile.linkedinSlug)) throw Error('test_profile_slug_invalid')
    if (profile.provenance?.kind !== TEST_PROFILE_PROVENANCE || profile.provenance.test !== true) throw Error('test_profile_provenance_invalid')
    if (typeof profile.name !== 'string' || !/\btest\b/i.test(profile.name)) throw Error('test_profile_name_invalid')
    ids.add(profile.id); slugs.add(profile.linkedinSlug)
  }
  return true
}
validateTestProfiles()

// Exact membership in the shipped set; the id shape alone never qualifies.
export const isTestProfileId = id => typeof id === 'string' && TEST_ID.test(id) && TEST_PROFILES.some(profile => profile.id === id)
export const testProfile = id => (isTestProfileId(id) ? TEST_PROFILES.find(profile => profile.id === id) : null)
export const testProfileBySlug = slug => {
  const wanted = typeof slug === 'string' ? slug.trim().toLowerCase() : ''
  return wanted ? TEST_PROFILES.find(profile => profile.linkedinSlug === wanted) ?? null : null
}
export const testProfileIds = () => TEST_PROFILES.map(profile => profile.id)
// Neo4j integers arrive as driver Integer objects.
const plain = value => (value && typeof value.toNumber === 'function' ? value.toNumber() : value)

// The claim readers that turn a confirmed claim into membership, a public
// profile or a profile's account. Each one skips test-profile claims, so a
// test claim never reaches the shared People snapshot, Connect, notifications
// or the agent API. Shared with private-composition.mjs so tests run the same text.
export const CLAIMED_PROFILE_FOR_OWNER = `MATCH (a:UnlinkedLegacyAccount {ownerId: $ownerId, userId: $userId}) WHERE a.revoked = false AND coalesce(a.testProfile, false) = false
  MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId}) WHERE coalesce(b.active, true) = true RETURN a.profileId AS id LIMIT 2`
export const OWNER_FOR_CLAIMED_PROFILE = `MATCH (a:UnlinkedLegacyAccount {profileId: $id}) WHERE a.revoked = false AND a.ownerId IS NOT NULL AND coalesce(a.testProfile, false) = false
  MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: a.ownerId, userId: a.userId}) WHERE coalesce(b.active, true) = true
  RETURN DISTINCT a.ownerId AS ownerId, a.userId AS userId LIMIT 2`
export const CLAIMED_MEMBER_PROFILES = `MATCH (a:UnlinkedLegacyAccount) WHERE a.ownerId IS NOT NULL AND a.revoked = false AND coalesce(a.testProfile, false) = false
  MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: a.ownerId, userId: a.userId}) WHERE coalesce(b.active, true) = true
  RETURN DISTINCT a.profileId AS id ORDER BY id LIMIT 20001`

// Operator core, run inside the runtime container (see the operator file).
// `list` shows claims on test profiles; `release <profileId>` deletes them.
// Release fails closed: the id must be a shipped test profile, and every claim
// row on it must itself be marked as a test claim, or nothing is deleted.
export async function operateTestProfileClaims({ args, session, now = () => new Date().toISOString() }) {
  const [action, ...rest] = args
  if (action === 'list' && rest.length === 0) {
    const result = await session.executeRead(tx => tx.run(`UNWIND $ids AS id MATCH (a:UnlinkedLegacyAccount {profileId: id})
      RETURN a.profileId AS profileId, a.ownerId AS ownerId, a.userId AS userId, a.receiptId AS receiptId, a.confirmedAt AS confirmedAt, a.revoked AS revoked, coalesce(a.testProfile, false) AS testProfile ORDER BY profileId LIMIT 100`, { ids: testProfileIds() }))
    return { action, claims: result.records.map(record => Object.fromEntries(['profileId', 'ownerId', 'userId', 'receiptId', 'confirmedAt', 'revoked', 'testProfile'].map(key => [key, plain(record.get(key))]))) }
  }
  if (action === 'release' && rest.length === 1) {
    const [profileId] = rest
    if (!isTestProfileId(profileId)) throw Error('test_profile_required')
    const released = await session.executeWrite(async tx => {
      const rows = (await tx.run('MATCH (a:UnlinkedLegacyAccount {profileId: $profileId}) RETURN a.testProfile = true AND a.selfAsserted = true AS test, a.receiptId AS receiptId, a.ownerId AS ownerId LIMIT 10', { profileId })).records
      if (rows.some(record => record.get('test') !== true)) throw Error('test_profile_claim_unmarked')
      if (!rows.length) return []
      const deleted = await tx.run('MATCH (a:UnlinkedLegacyAccount {profileId: $profileId}) WHERE a.testProfile = true AND a.selfAsserted = true DETACH DELETE a RETURN count(*) AS deleted', { profileId })
      if (plain(deleted.records[0].get('deleted')) !== rows.length) throw Error('test_profile_release_incomplete')
      return rows.map(record => ({ receiptId: record.get('receiptId'), ownerId: record.get('ownerId') }))
    })
    return { action, profileId, released: released.length, receipts: released, at: now() }
  }
  throw Error('test_profile_operator_arguments_invalid')
}
