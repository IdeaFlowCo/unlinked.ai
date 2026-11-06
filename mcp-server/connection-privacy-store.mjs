// Each member's choice of who can see their connections (docs/connection-privacy.md).
// One node per account. Only non-default choices are stored: choosing the
// default removes the node, so a missing node always means "Everyone, all".
import { connectionPrivacyValue, isDefaultConnectionPrivacy, DEFAULT_CONNECTION_PRIVACY } from '../src/utils/public-people/connection-privacy.mjs'

const valid = owner => typeof owner?.ownerId === 'string' && owner.ownerId && owner.ownerId.length <= 200 && typeof owner.userId === 'string' && owner.userId && owner.userId.length <= 200
// The public index reads every stored choice on each build; bounded like its imports.
export const CONNECTION_PRIVACY_LIST_LIMIT = 10000

export function createMemoryConnectionPrivacyStore({ now = Date.now } = {}) {
  const records = new Map()
  return {
    async initialize() {},
    async get(owner) {
      if (!valid(owner)) return DEFAULT_CONNECTION_PRIVACY
      const value = records.get(owner.ownerId)
      return value && value.userId === owner.userId ? value.choice : DEFAULT_CONNECTION_PRIVACY
    },
    async set(owner, input) {
      if (!valid(owner)) throw new Error('connection_privacy_owner_required')
      const choice = connectionPrivacyValue(input)
      if (!choice) throw new Error('connection_privacy_invalid')
      if (isDefaultConnectionPrivacy(choice)) records.delete(owner.ownerId)
      else records.set(owner.ownerId, { userId: owner.userId, choice, updatedAt: now() })
      return choice
    },
    async list() { return [...records].map(([ownerId, value]) => ({ owner: { ownerId, userId: value.userId }, ...value.choice })) },
    async removeOwner(owner) { if (valid(owner)) records.delete(owner.ownerId) },
  }
}

export function createNeo4jConnectionPrivacyStore(driver, database = 'neo4j', { now = Date.now } = {}) {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      await run('CREATE CONSTRAINT unlinked_connection_privacy_owner IF NOT EXISTS FOR (p:UnlinkedConnectionPrivacy) REQUIRE p.ownerId IS UNIQUE', {})
    },
    async get(owner) {
      if (!valid(owner)) return DEFAULT_CONNECTION_PRIVACY
      const result = await run('MATCH (p:UnlinkedConnectionPrivacy {ownerId: $ownerId}) WHERE p.userId = $userId RETURN p.audience AS audience, p.scope AS scope LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ')
      if (!result.records.length) return DEFAULT_CONNECTION_PRIVACY
      // A stored value this code no longer understands fails closed to "Only you".
      return connectionPrivacyValue({ audience: result.records[0].get('audience'), scope: result.records[0].get('scope') }) ?? connectionPrivacyValue({ audience: 'only_me', scope: 'all' })
    },
    async set(owner, input) {
      if (!valid(owner)) throw new Error('connection_privacy_owner_required')
      const choice = connectionPrivacyValue(input)
      if (!choice) throw new Error('connection_privacy_invalid')
      if (isDefaultConnectionPrivacy(choice)) await run('MATCH (p:UnlinkedConnectionPrivacy {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
      else await run('MERGE (p:UnlinkedConnectionPrivacy {ownerId: $ownerId}) SET p.userId = $userId, p.audience = $audience, p.scope = $scope, p.updatedAt = $updatedAt', { ownerId: owner.ownerId, userId: owner.userId, ...choice, updatedAt: now() })
      return choice
    },
    async list() {
      const result = await run('MATCH (p:UnlinkedConnectionPrivacy) RETURN p.ownerId AS ownerId, p.userId AS userId, p.audience AS audience, p.scope AS scope ORDER BY p.ownerId LIMIT ' + (CONNECTION_PRIVACY_LIST_LIMIT + 1), {}, 'READ')
      if (result.records.length > CONNECTION_PRIVACY_LIST_LIMIT) throw new Error('connection_privacy_list_limit')
      return result.records.map(record => {
        const choice = connectionPrivacyValue({ audience: record.get('audience'), scope: record.get('scope') }) ?? connectionPrivacyValue({ audience: 'only_me', scope: 'all' })
        return { owner: { ownerId: record.get('ownerId'), userId: record.get('userId') }, ...choice }
      })
    },
    async removeOwner(owner) {
      if (!valid(owner)) return
      await run('MATCH (p:UnlinkedConnectionPrivacy {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
    },
  }
}
