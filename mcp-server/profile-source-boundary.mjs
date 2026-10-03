import { AsyncLocalStorage } from 'node:async_hooks'

// Every profile confirmation locks the same active owner row before touching
// either source. Reads remain ordinary owner-fenced reads. This also serializes
// a signup confirmation against legacy confirmation in another browser session.
export async function lockProfileOwner(tx, owner, { requireActive = true } = {}) {
  if (!owner?.ownerId || !owner.userId) throw Error('self_claim_conflict')
  const result = await tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId})
    WHERE ($requireActive=false OR coalesce(b.active,true)=true) SET b._profileSourceLock=true REMOVE b._profileSourceLock RETURN b.sourceOwnerId AS id`, { ownerId: owner.ownerId, userId: owner.userId, requireActive })
  if (result.records.length !== 1) throw Error('self_claim_conflict')
}

// The Noos legacy capability owns proof validation and the legacy write. Its
// managed executeWrite transaction is extended here, rather than confirming
// first and retiring a signup source in a second transaction. Any failure rolls
// both writes back; Noos retains its normal transaction retries and guarantees.
export function createLegacyProfileBoundary(driver, { now = Date.now } = {}) {
  const context = new AsyncLocalStorage()
  const wrappedDriver = new Proxy(driver, {
    get(target, property) {
      if (property !== 'session') {
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return options => {
        const session = target.session(options)
        return new Proxy(session, {
          get(targetSession, property) {
            if (property !== 'executeWrite') {
              const value = Reflect.get(targetSession, property)
              return typeof value === 'function' ? value.bind(targetSession) : value
            }
            return (work, ...options) => targetSession.executeWrite(async tx => {
              const confirmation = context.getStore()
              if (!confirmation) return work(tx)
              await lockProfileOwner(tx, confirmation.owner)
              const result = await work(tx)
              await tx.run(`MATCH (a:UnlinkedLegacyAccount {ownerId:$ownerId, userId:$userId, profileId:$profileId, revoked:false})
                WHERE coalesce(a.testProfile,false)=false AND a.receiptId IS NOT NULL
                MATCH (s:UnlinkedSignupProfile {ownerId:$ownerId, userId:$userId}) WHERE coalesce(s.retired,false)=false
                SET s.retired=true, s.retiredAt=$now, s.retiredByProfileId=a.profileId, s.retiredByReceiptId=a.receiptId,
                  s.retiredReason='legacy-profile-upgrade-v1'`, { ...confirmation.owner, profileId: confirmation.profileId, now: now() })
              return result
            }, ...options)
          },
        })
      }
    },
  })
  const confirm = (owner, profileId, work) => context.run({ owner: { ownerId: owner?.ownerId, userId: owner?.userId }, profileId }, work)
  return {
    driver: wrappedDriver,
    confirm,
    wrapSelfClaims: claims => ({ ...claims, claim: request => confirm(request.owner, request.profileId, () => claims.claim(request)) }),
  }
}
