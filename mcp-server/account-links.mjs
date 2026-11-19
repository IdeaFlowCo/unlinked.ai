import { randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LINKS = 8
export const sameAccount = (left, right) => Boolean(left && right && left.ownerId === right.ownerId && left.userId === right.userId)
export const verifiedLinkEmail = identity => identity?.providerEmailVerified === true &&
  typeof identity.verifiedEmail === 'string' && /^[^\s\x00-\x1f\x7f@]+@[^\s\x00-\x1f\x7f@]+$/.test(identity.verifiedEmail) &&
  identity.verifiedEmail.length <= 254 ? identity.verifiedEmail : null
const deny = () => new Error('account_link_not_allowed')

const loadAccount = `MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId})
  WHERE coalesce(b.active,true)
  MATCH (i:OperationalIdentity {namespace:'unlinked', issuer:b.identityIssuer, subject:b.identitySubject})
  WHERE i.sourceOwnerId=b.sourceOwnerId AND i.userId=b.userId
  RETURN b.sourceOwnerId AS ownerId, b.userId AS userId, i.issuer AS issuer, i.subject AS subject,
    b.unlinkedPrimaryOwnerId AS primaryOwnerId, b.unlinkedLinkEpoch AS epoch,
    b.unlinkedVerifiedLoginEmail AS email, b.unlinkedLinkId AS linkId`

const value = row => row ? row.toObject() : null
const identityMatches = (account, proof) => Boolean(account && proof && account.issuer === proof.issuer && account.subject === proof.subject)
const load = async (tx, ownerId) => {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return null
  return value((await tx.run(loadAccount, { ownerId })).records[0])
}
const attached = async (tx, ownerId) => (await tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked', unlinkedPrimaryOwnerId:$ownerId})
  RETURN b.sourceOwnerId AS ownerId, b.unlinkedVerifiedLoginEmail AS email, b.unlinkedLinkId AS linkId
  ORDER BY b.sourceOwnerId LIMIT ${MAX_LINKS + 1}`, { ownerId })).records.map(value)

export function createNeo4jAccountLinks(driver, { issuer, database = 'neo4j', adminSubjects = [], manage = false, resolveOwner }) {
  const admins = new Set(adminSubjects)
  const run = async (mode, work) => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(work) : session.executeWrite(work)) }
    finally { await session.close() }
  }
  const isAdmin = identity => identity?.issuer === issuer && admins.has(identity.subject)
  const account = ownerId => run('READ', tx => load(tx, ownerId))
  async function route(identity) {
    if (identity?.issuer !== issuer) return null
    const owner = await resolveOwner(identity)
    if (!owner) return null
    return run('READ', async tx => {
      const source = await load(tx, owner.ownerId)
      if (!sameAccount(source, owner) || !identityMatches(source, identity)) throw deny()
      const primary = source.primaryOwnerId ? await load(tx, source.primaryOwnerId) : source
      if (!primary || primary.primaryOwnerId || primary.issuer !== issuer || (source.primaryOwnerId && isAdmin(primary))) throw deny()
      return { source, primary }
    })
  }
  return {
    initialize: () => run('WRITE', tx => tx.run(`CREATE INDEX unlinked_link_primary IF NOT EXISTS
      FOR (b:OperationalOwner) ON (b.namespace,b.unlinkedPrimaryOwnerId)`)),
    manage,
    isAdmin,
    account,
    async recordVerifiedLogin(owner, identity) {
      const email = verifiedLinkEmail(identity)
      if (!manage || !email || identity.issuer !== issuer) return
      await run('WRITE', tx => tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId})
        WHERE coalesce(b.active,true) AND b.identityIssuer=$issuer AND b.identitySubject=$subject
        SET b.unlinkedVerifiedLoginEmail=$email`, { ...owner, issuer, subject: identity.subject, email }))
    },
    async clearVerifiedLogin(owner) {
      await run('WRITE', tx => tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId})
        REMOVE b.unlinkedVerifiedLoginEmail`, owner))
    },
    routeSubject: subject => typeof subject === 'string' && subject ? route({ issuer, subject }) : null,
    route,
    async list(owner) {
      return run('READ', async tx => {
        const primary = await load(tx, owner.ownerId)
        if (!sameAccount(primary, owner) || primary.primaryOwnerId) throw deny()
        return attached(tx, owner.ownerId)
      })
    },
    async change({ action, primary: expectedPrimary, secondary: expectedSecondary, actor, primaryProof, secondaryProof, expectedLinkId }) {
      if (!manage || !['self', 'admin', 'unlink'].includes(action) || expectedPrimary.ownerId === expectedSecondary.ownerId) throw deny()
      const eventId = randomUUID(), at = Date.now()
      const ids = [...new Set([expectedPrimary.ownerId, expectedSecondary.ownerId, actor.ownerId])].sort()
      return run('WRITE', async tx => {
        // Lock in the same order as other owners' transactions. Re-read every
        // decision after locking. The topology, audit and session fence commit together.
        for (const ownerId of ids) await tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId})
          SET b._lock=true REMOVE b._lock`, { ownerId })
        const primary = await load(tx, expectedPrimary.ownerId)
        const secondary = await load(tx, expectedSecondary.ownerId)
        if (!sameAccount(primary, expectedPrimary) || !sameAccount(secondary, expectedSecondary) ||
            primary.issuer !== issuer || secondary.issuer !== issuer || primary.primaryOwnerId ||
            primary.userId === secondary.userId || isAdmin(primary) || isAdmin(secondary) ||
            primary.epoch !== expectedPrimary.epoch || secondary.epoch !== expectedSecondary.epoch ||
            (!identityMatches(primary, expectedPrimary) || !identityMatches(secondary, expectedSecondary))) throw deny()

        if (action === 'admin') {
          const admin = await load(tx, actor.ownerId)
          if (!sameAccount(admin, actor) || admin.primaryOwnerId || admin.epoch !== actor.epoch ||
              !isAdmin(admin) || !identityMatches(admin, primaryProof) || !verifiedLinkEmail(primaryProof) ||
              !primary.email || primary.email !== expectedPrimary.email || !secondary.email || secondary.email !== expectedSecondary.email) throw deny()
        } else if (!sameAccount(actor, primary) || !identityMatches(primary, primaryProof) || !verifiedLinkEmail(primaryProof)) {
          throw deny()
        }
        if (action === 'self' && (!identityMatches(secondary, secondaryProof) || !verifiedLinkEmail(secondaryProof))) throw deny()

        const unlink = action === 'unlink'
        if (unlink ? (secondary.primaryOwnerId !== primary.ownerId || secondary.linkId !== expectedLinkId) :
          (secondary.primaryOwnerId || (await attached(tx, secondary.ownerId)).length || (await attached(tx, primary.ownerId)).length >= MAX_LINKS)) throw deny()
        await tx.run(`MATCH (p:OperationalOwner {namespace:'unlinked', sourceOwnerId:$primaryId})
          MATCH (s:OperationalOwner {namespace:'unlinked', sourceOwnerId:$secondaryId})
          SET p.unlinkedLinkEpoch=$eventId, s.unlinkedLinkEpoch=$eventId,
              s.unlinkedPrimaryOwnerId=$parent, s.unlinkedLinkId=$link,
              p.unlinkedVerifiedLoginEmail=coalesce($primaryEmail,p.unlinkedVerifiedLoginEmail),
              s.unlinkedVerifiedLoginEmail=coalesce($secondaryEmail,s.unlinkedVerifiedLoginEmail)
          CREATE (:UnlinkedAccountLinkEvent {id:$eventId, at:$at, action:$action, linkId:$auditLink,
            primaryOwnerId:$primaryId, secondaryOwnerId:$secondaryId, actorOwnerId:$actorId})
          WITH p,s
          MATCH (session:UnlinkedSession)
          WHERE session.ownerId IN [$primaryId,$secondaryId]
          DELETE session`, {
          primaryId: primary.ownerId, secondaryId: secondary.ownerId, actorId: actor.ownerId,
          parent: unlink ? null : primary.ownerId, link: unlink ? null : eventId,
          auditLink: unlink ? secondary.linkId : eventId, eventId, at, action,
          primaryEmail: action === 'admin' ? null : verifiedLinkEmail(primaryProof),
          secondaryEmail: action === 'self' ? verifiedLinkEmail(secondaryProof) : null,
        })
        return { eventId, primary, secondary }
      })
    },
  }
}
