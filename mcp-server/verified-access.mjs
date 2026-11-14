import { ACCESS_TIER } from './access-tiers.mjs'

// Operator-controlled account entitlements. Neither a grant, imported profile,
// email verification nor client input can confer a tier. Verified (priority,
// no core quotas) outranks approved (enhanced access: higher bounded quotas and
// shared-network downloads); everyone else is standard. See docs/verified-access.md.
export function createAccessTier({ driver, now = Date.now, cacheMs = 1000 }) {
  const cache = new Map()
  return async owner => {
    if (!owner?.ownerId || !owner?.userId) return ACCESS_TIER.standard
    const key = JSON.stringify([owner.ownerId, owner.userId]), held = cache.get(key)
    if (held && now() - held.at < cacheMs) return held.value
    const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
    try {
      const result = await session.executeRead(tx => tx.run(`MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId})
        WHERE coalesce(b.active, true) = true RETURN b.unlinkedVerified = true AS verified, b.unlinkedApproved = true AS approved`, { ownerId: owner.ownerId, userId: owner.userId }))
      const record = result.records.length === 1 ? result.records[0] : null
      const value = record?.get('verified') === true ? ACCESS_TIER.verified : record?.get('approved') === true ? ACCESS_TIER.approved : ACCESS_TIER.standard
      if (cache.size >= 5000) cache.clear()
      cache.set(key, { at: now(), value })
      return value
    } finally { await session.close() }
  }
}

export const verifiedFromTier = accessTier => async owner => await accessTier(owner) === ACCESS_TIER.verified

export function createVerifiedAccess(options) { return verifiedFromTier(createAccessTier(options)) }
