import { createHash, randomUUID } from 'node:crypto'
import { isTestProfileId, testProfile, testProfileBySlug, TEST_PROFILES_SHA256 } from './test-profiles.mjs'

// Self-serve claims for legacy profiles outside the seeded manifest: a lookup
// hint (LinkedIn address, or the signed-in display name) selects an unclaimed
// legacy profile, and an explicit confirmation writes a self-asserted
// UnlinkedLegacyAccount row. The uniqueness constraints on
// profileId/ownerId/userId/emailHash make first-claim-wins and
// one-claim-per-account database-enforced; readBound/candidate/confirm treat
// the row like a seeded one. Operator rollback:
// legacy-account-operator.mjs revoke <profileId> <receiptId>.
//
// Test profiles (test-profiles.mjs) take the same lane by their exact address
// only. Their claim rows carry testProfile:true and are removed with
// test-profile-claims-operator.mjs release <profileId>.
const normalizedName = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : ''
const EVIDENCE = ['self-asserted-linkedin-url-v1', 'self-asserted-display-name-v1']

export function createSelfClaims({ driver, publicPeople, slugIndex, database = 'neo4j' }) {
  if (!driver || typeof publicPeople?.read !== 'function' || typeof slugIndex !== 'function') throw Error('self_claims_configuration_required')
  return {
    lookupSlug: async slug => {
      const test = testProfileBySlug(slug)
      if (test) return test.id
      try { return (await slugIndex()).get(String(slug).toLowerCase()) ?? null } catch { return null }
    },
    // Names resolve only against the recovered legacy dataset, never the
    // merged shared snapshot — a member-imported contact with the same
    // name must not shadow or displace a claimable legacy profile. Test
    // profiles are never found by name.
    lookupName: async name => {
      const wanted = normalizedName(name)
      if (!wanted) return null
      const snapshot = await publicPeople.read('recovered-legacy-public-v1')
      if (!snapshot) return null
      const matches = snapshot.profiles.filter(profile => normalizedName(profile.name) === wanted)
      return matches.length === 1 ? matches[0].id : null
    },
    // The "Is this you?" card for a test profile, which no public reader has.
    preview: async profileId => {
      const test = testProfile(profileId)
      return test ? { test: true, profile: { name: test.name, headline: test.headline, connections: [] } } : null
    },
    claimable: async profileId => {
      const session = driver.session({ database, defaultAccessMode: 'READ' })
      try { return !(await session.executeRead(tx => tx.run('MATCH (a:UnlinkedLegacyAccount {profileId:$profileId}) RETURN a LIMIT 1', { profileId }))).records.length }
      finally { await session.close() }
    },
    claim: async ({ owner, issuer, subject, emailHash, profileId, evidence }) => {
      if (!owner?.ownerId || !owner.userId || typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject || !/^[a-f0-9]{64}$/.test(emailHash ?? '') || typeof profileId !== 'string' || !profileId || !EVIDENCE.includes(evidence)) throw new Error('self_claim_input_invalid')
      const test = isTestProfileId(profileId)
      // A test profile is only ever found by its exact address.
      if (test && evidence !== 'self-asserted-linkedin-url-v1') throw new Error('self_claim_input_invalid')
      let sourceSha256 = TEST_PROFILES_SHA256
      if (!test) {
        const snapshot = await publicPeople.read('recovered-legacy-public-v1')
        if (!snapshot || !snapshot.revision.startsWith('legacy-public-v1:')) throw new Error('legacy_profile_source_unavailable')
        if (!snapshot.profiles.some(profile => profile.id === profileId)) throw new Error('self_claim_profile_unknown')
        sourceSha256 = snapshot.revision.slice('legacy-public-v1:'.length)
      }
      const legacyUserId = randomUUID()
      const receiptId = createHash('sha256').update(JSON.stringify({ kind: test ? 'self-asserted-test-claim-v1' : 'self-asserted-claim-v1', profileId, legacyUserId, ownerId: owner.ownerId, userId: owner.userId, issuer, subject, evidence })).digest('hex')
      const session = driver.session({ database })
      try {
        const result = await session.executeWrite(tx => tx.run(`
          OPTIONAL MATCH (p:UnlinkedLegacyAccount {profileId:$profileId})
          OPTIONAL MATCH (o:UnlinkedLegacyAccount {ownerId:$ownerId})
          OPTIONAL MATCH (u:UnlinkedLegacyAccount {userId:$userId})
          OPTIONAL MATCH (e:UnlinkedLegacyAccount {emailHash:$emailHash})
          WITH p, o, u, e WHERE p IS NULL AND o IS NULL AND u IS NULL AND e IS NULL
          CREATE (a:UnlinkedLegacyAccount {legacyUserId:$legacyUserId, profileId:$profileId, emailHash:$emailHash,
            sourceSha256:$sourceSha256, selfAsserted:true, claimEvidence:$evidence, revoked:false,
            ownerId:$ownerId, userId:$userId, issuer:$issuer, subject:$subject,
            receiptId:$receiptId, confirmedAt:$now, confirmedBy:'unlinked-private-browser'})
          FOREACH (_ IN CASE WHEN $test THEN [1] ELSE [] END | SET a.testProfile = true)
          RETURN a.receiptId AS receiptId`,
        { profileId, ownerId: owner.ownerId, userId: owner.userId, emailHash, legacyUserId, sourceSha256, evidence, receiptId, test, issuer, subject, now: Date.now() }))
        if (!result.records.length) throw new Error('self_claim_conflict')
        return { profileId, receiptId: result.records[0].get('receiptId'), ...(test ? { test: true } : {}) }
      } catch (error) {
        // A race that slips past the guard reads lands on the uniqueness
        // constraints; losing one is the same conflict, not an outage.
        if (String(error.code ?? '').includes('ConstraintValidationFailed')) throw new Error('self_claim_conflict')
        throw error
      } finally { await session.close() }
    },
  }
}
