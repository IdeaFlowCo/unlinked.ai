import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { operatorBoltUrl } from './operator-bolt-url.mjs'
import { OWNER_FOR_CLAIMED_PROFILE } from './test-profiles.mjs'

// Run only through the existing private operator transport. This is never an
// HTTP endpoint or agent tool; an account cannot raise its own tier.
// Tiers: verified (grant/revoke) and approved, shown as "Enhanced access"
// (approve/unapprove, or approve-profiles for a reviewed seed file). Every
// change writes an attributed UnlinkedVerificationEvent carrying its tier.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const id = value => typeof value === 'string' && UUID.test(value)
const text = value => typeof value === 'string' && value.trim() && value.length <= 500
const profileIdValid = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,160}$/.test(value)
const BINDING = `MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId}) WHERE coalesce(b.active,true)=true`
const ACTIVE = `MATCH (b:OperationalOwner {namespace:'unlinked'}) WHERE b.sourceOwnerId = ownerId AND b.userId = userId AND coalesce(b.active,true)=true`
const TIERS = { grant: ['verified', true], revoke: ['verified', false], approve: ['approved', true], unapprove: ['approved', false] }

async function readTier(session, ownerId, userId) {
  const result = await session.executeRead(tx => tx.run(`${BINDING} RETURN b.sourceOwnerId AS ownerId,b.userId AS userId,coalesce(b.unlinkedVerified,false) AS verified,b.unlinkedVerifiedChangedAt AS changedAt,b.unlinkedVerifiedChangedBy AS changedBy,coalesce(b.unlinkedApproved,false) AS approved,b.unlinkedApprovedChangedAt AS approvedChangedAt,b.unlinkedApprovedChangedBy AS approvedChangedBy`, { ownerId, userId }))
  if (result.records.length !== 1) throw Error('verified_access_active_owner_required')
  return result.records[0].toObject()
}

async function writeTier(session, { action, ownerId, userId, actor, reason, at }) {
  const [tier, value] = TIERS[action]
  const set = tier === 'verified' ? 'b.unlinkedVerified=$value,b.unlinkedVerifiedChangedAt=$at,b.unlinkedVerifiedChangedBy=$actor' : 'b.unlinkedApproved=$value,b.unlinkedApprovedChangedAt=$at,b.unlinkedApprovedChangedBy=$actor'
  // Historical verified events carry `verified` and no `tier`; keep that shape for verified changes.
  const event = tier === 'verified' ? '{id:$eventId,ownerId:$ownerId,userId:$userId,verified:$value,at:$at,actor:$actor,reason:$reason}' : '{id:$eventId,ownerId:$ownerId,userId:$userId,tier:$tier,approved:$value,at:$at,actor:$actor,reason:$reason}'
  await session.executeWrite(async tx => {
    const result = await tx.run(`${BINDING}
      SET ${set}
      CREATE (e:UnlinkedVerificationEvent ${event})
      RETURN b.sourceOwnerId AS ownerId`, { ownerId, userId, value, tier, at, actor, reason, eventId: randomUUID() })
    if (result.records.length !== 1) throw Error('verified_access_active_owner_required')
  })
}

// Resolve a published member profile id to its one active account, from live
// source ownership (signup source, public archive import or confirmed claim),
// never from names or email.
export async function resolveProfileAccount(session, profileId) {
  if (!profileIdValid(profileId)) throw Error('verified_access_arguments_invalid')
  const imported = profileId.match(/^member-import-([a-f0-9]{64})$/)
  const query = /^member-signup-[a-f0-9]{64}$/.test(profileId)
    ? `MATCH (s:UnlinkedSignupProfile {profileId:$id}) WHERE coalesce(s.retired,false)=false WITH s.ownerId AS ownerId, s.userId AS userId ${ACTIVE} RETURN DISTINCT b.sourceOwnerId AS ownerId, b.userId AS userId LIMIT 2`
    : imported
      ? `MATCH (r:OperationalResource {namespace:'unlinked', type:'import', sourceId:$id}) WHERE r.publicationOwner IS NOT NULL WITH r.publicationOwner AS ownerId, r.userId AS userId ${ACTIVE} RETURN DISTINCT b.sourceOwnerId AS ownerId, b.userId AS userId LIMIT 2`
      : OWNER_FOR_CLAIMED_PROFILE
  const result = await session.executeRead(tx => tx.run(query, { id: imported ? imported[1] : profileId }))
  return result.records.length === 1 ? { ownerId: result.records[0].get('ownerId'), userId: result.records[0].get('userId') } : null
}

export async function operateVerifiedAccess({ session, args, now = () => new Date().toISOString(), readFile = path => readFileSync(path, 'utf8') }) {
  const [action] = args
  if (action === 'show') {
    const [, ownerId, userId] = args
    if (args.length !== 3 || !id(ownerId) || !id(userId)) throw Error('verified_access_arguments_invalid')
    return readTier(session, ownerId, userId)
  }
  if (action === 'resolve') {
    if (args.length !== 2) throw Error('verified_access_arguments_invalid')
    const owner = await resolveProfileAccount(session, args[1])
    return owner ? { profileId: args[1], ...owner } : { profileId: args[1], resolved: false }
  }
  if (action === 'approve-profiles') {
    // Resolve the whole reviewed seed first; any unresolved profile aborts with no writes.
    const [, path, actor, reason] = args
    if (args.length !== 4 || !text(path) || !text(actor) || !text(reason)) throw Error('verified_access_arguments_invalid')
    const seed = JSON.parse(readFile(path)), ids = seed?.approve?.map(row => row?.profileId)
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(value => !profileIdValid(value)) || new Set(ids).size !== ids.length) throw Error('verified_access_seed_invalid')
    const owners = []
    for (const profileId of ids) owners.push({ profileId, owner: await resolveProfileAccount(session, profileId) })
    const unresolved = owners.filter(row => !row.owner).map(row => row.profileId)
    if (unresolved.length) return { applied: false, unresolved }
    const at = now(), results = []
    for (const { profileId, owner } of owners) {
      await writeTier(session, { action: 'approve', ...owner, actor, reason, at })
      const state = await readTier(session, owner.ownerId, owner.userId)
      results.push({ profileId, approved: state.approved, verified: state.verified })
    }
    return { applied: true, results }
  }
  const [, ownerId, userId, actor, reason] = args
  if (!Object.hasOwn(TIERS, action) || !id(ownerId) || !id(userId) || args.length !== 5 || !text(actor) || !text(reason)) throw Error('verified_access_arguments_invalid')
  await writeTier(session, { action, ownerId, userId, actor, reason, at: now() })
  return readTier(session, ownerId, userId)
}
async function main() {
  const require = createRequire('/srv/unlinked-private-guest-pilot-20261001/runtime/noos/package.json'), neo4j = require('neo4j-driver')
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000 })
  const session = driver.session({ database: 'neo4j' })
  try { console.log(JSON.stringify(await operateVerifiedAccess({ session, args: process.argv.slice(2) }))) }
  finally { await session.close(); await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error('verified_access_operation_failed' + (/^verified_access_[a-z_]+$/.test(error?.message) ? ':' + error.message : '')); process.exitCode = 1 })
