// Operator-controlled account entitlement. Neither a grant, imported profile,
// email verification nor client input can confer this tier.
export function createVerifiedAccess({ driver, now = Date.now, cacheMs = 1000 }) {
  const cache = new Map()
  return async owner => {
    if (!owner?.ownerId || !owner?.userId) return false
    const key = JSON.stringify([owner.ownerId, owner.userId]), held = cache.get(key)
    if (held && now() - held.at < cacheMs) return held.value
    const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
    try {
      const result = await session.executeRead(tx => tx.run(`MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId})
        WHERE coalesce(b.active, true) = true RETURN b.unlinkedVerified = true AS verified`, { ownerId: owner.ownerId, userId: owner.userId }))
      const value = result.records.length === 1 && result.records[0].get('verified') === true
      if (cache.size >= 5000) cache.clear()
      cache.set(key, { at: now(), value })
      return value
    } finally { await session.close() }
  }
}
