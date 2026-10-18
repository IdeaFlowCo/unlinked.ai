import { createHash, randomUUID } from 'node:crypto'

// Member blocks (docs/report-and-block.md). A member blocks another person from
// their profile or from a conversation. The block is kept here, keyed by the
// blocker's account, and names the blocked person by whatever is known: their
// Unlinked account (connection requests are refused either way), their public
// profile (shown as blocked) and their OpenChat user (OpenChat's own block
// drops messages either way; Unlinked also hides the conversation).

const OPENCHAT_ID = /^[A-Za-z0-9_-]{1,80}$/
const valid = member => typeof member?.ownerId === 'string' && member.ownerId && typeof member.userId === 'string' && member.userId
const same = (a, b) => a.ownerId === b.ownerId && a.userId === b.userId
export const BLOCKS_PER_ACCOUNT = 500

export class BlockError extends Error {
  constructor(code) { super(code); this.code = code }
}
const plainName = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || null : null
const accountKey = member => `${member.ownerId}\u0000${member.userId}`
// The one key per blocked person: their account when known, else their OpenChat user.
const targetKey = target => target.blockedOwnerId ? `account:${createHash('sha256').update(`${target.blockedOwnerId}\u0000${target.blockedUserId}`).digest('hex')}` : `openchat:${target.openChatUserId}`
const recordKey = (blocker, key) => createHash('sha256').update(`${accountKey(blocker)}\u0001${key}`).digest('hex')

// A normalized block from the blocker and what is known about the blocked person.
export function blockRecord(blocker, { blocked = null, profileId = null, openChatUserId = null, name = null } = {}, { now = Date.now, id = randomUUID } = {}) {
  if (!valid(blocker)) throw new BlockError('block_owner_required')
  if (blocked && !valid(blocked)) throw new BlockError('block_target_invalid')
  if (blocked && same(blocker, blocked)) throw new BlockError('block_self')
  if (openChatUserId !== null && !OPENCHAT_ID.test(openChatUserId)) throw new BlockError('block_target_invalid')
  if (profileId !== null && (typeof profileId !== 'string' || !profileId || profileId.length > 160)) throw new BlockError('block_target_invalid')
  if (!blocked && !openChatUserId) throw new BlockError('block_target_invalid')
  const record = { id: id(), blockerOwnerId: blocker.ownerId, blockerUserId: blocker.userId, blockedOwnerId: blocked?.ownerId ?? null, blockedUserId: blocked?.userId ?? null,
    blockedProfileId: profileId, openChatUserId, name: plainName(name), createdAt: now() }
  record.key = recordKey(blocker, targetKey(record))
  return record
}
const view = record => record ? Object.freeze({ id: record.id, name: record.name ?? null, blockedProfileId: record.blockedProfileId ?? null, openChatUserId: record.openChatUserId ?? null,
  ...(record.blockedOwnerId ? { blocked: Object.freeze({ ownerId: record.blockedOwnerId, userId: record.blockedUserId }) } : {}), createdAt: record.createdAt }) : null
// A new block about the same person keeps what was already known and adds what is new.
const merged = (old, next) => old ? { ...old, ...Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== null && !['id', 'createdAt', 'key'].includes(key))) } : next

export function createMemoryBlockStore() {
  const records = new Map()
  const mine = member => [...records.values()].filter(record => record.blockerOwnerId === member.ownerId && record.blockerUserId === member.userId)
  return {
    async initialize() {},
    async add(record) {
      if (!records.has(record.key) && records.size && [...records.values()].filter(value => value.blockerOwnerId === record.blockerOwnerId && value.blockerUserId === record.blockerUserId).length >= BLOCKS_PER_ACCOUNT) throw new BlockError('block_limit')
      const value = merged(records.get(record.key), record)
      records.set(record.key, value)
      return view(value)
    },
    async list(member) { return mine(member).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).map(view) },
    async remove(member, id) {
      const value = mine(member).find(record => record.id === id)
      if (!value) return null
      records.delete(value.key)
      return view(value)
    },
    async between(a, b) {
      return [...records.values()].some(record => (record.blockerOwnerId === a.ownerId && record.blockerUserId === a.userId && record.blockedOwnerId === b.ownerId && record.blockedUserId === b.userId) ||
        (record.blockerOwnerId === b.ownerId && record.blockerUserId === b.userId && record.blockedOwnerId === a.ownerId && record.blockedUserId === a.userId))
    },
    async removeOwner(member) {
      for (const [key, record] of records) if ((record.blockerOwnerId === member.ownerId && record.blockerUserId === member.userId) || (record.blockedOwnerId === member.ownerId && record.blockedUserId === member.userId)) records.delete(key)
    },
  }
}

const FIELDS = ['id', 'key', 'blockerOwnerId', 'blockerUserId', 'blockedOwnerId', 'blockedUserId', 'blockedProfileId', 'openChatUserId', 'name', 'createdAt']
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const fromNode = node => node ? Object.fromEntries(FIELDS.map(key => [key, key === 'createdAt' ? number(node[key]) : node[key] ?? null])) : null

export function createNeo4jBlockStore(driver, database = 'neo4j') {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      await run('CREATE CONSTRAINT unlinked_member_block_key IF NOT EXISTS FOR (b:UnlinkedMemberBlock) REQUIRE b.key IS UNIQUE', {})
      await run('CREATE INDEX unlinked_member_block_blocker IF NOT EXISTS FOR (b:UnlinkedMemberBlock) ON (b.blockerOwnerId)', {})
      await run('CREATE INDEX unlinked_member_block_blocked IF NOT EXISTS FOR (b:UnlinkedMemberBlock) ON (b.blockedOwnerId)', {})
    },
    async add(record) {
      const count = await run('MATCH (b:UnlinkedMemberBlock {blockerOwnerId: $ownerId, blockerUserId: $userId}) WHERE b.key <> $key RETURN count(b) AS n', { ownerId: record.blockerOwnerId, userId: record.blockerUserId, key: record.key }, 'READ')
      if (number(count.records[0].get('n')) >= BLOCKS_PER_ACCOUNT) throw new BlockError('block_limit')
      const fresh = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null))
      const result = await run(`MERGE (b:UnlinkedMemberBlock {key: $key}) ON CREATE SET b = $fresh
        ON MATCH SET b.blockedOwnerId = coalesce($record.blockedOwnerId, b.blockedOwnerId), b.blockedUserId = coalesce($record.blockedUserId, b.blockedUserId),
          b.blockedProfileId = coalesce($record.blockedProfileId, b.blockedProfileId), b.openChatUserId = coalesce($record.openChatUserId, b.openChatUserId), b.name = coalesce($record.name, b.name)
        RETURN properties(b) AS b`, { key: record.key, fresh, record })
      return view(fromNode(result.records[0].get('b')))
    },
    async list(member) {
      const result = await run('MATCH (b:UnlinkedMemberBlock {blockerOwnerId: $ownerId, blockerUserId: $userId}) RETURN properties(b) AS b ORDER BY b.createdAt DESC, b.id LIMIT toInteger($limit)', { ...member, limit: BLOCKS_PER_ACCOUNT }, 'READ')
      return result.records.map(row => view(fromNode(row.get('b'))))
    },
    async remove(member, id) {
      const result = await run('MATCH (b:UnlinkedMemberBlock {blockerOwnerId: $ownerId, blockerUserId: $userId, id: $id}) WITH b, properties(b) AS value DETACH DELETE b RETURN value', { ...member, id })
      return view(fromNode(result.records[0]?.get('value')))
    },
    async between(a, b) {
      const result = await run(`MATCH (x:UnlinkedMemberBlock) WHERE (x.blockerOwnerId = $a.ownerId AND x.blockerUserId = $a.userId AND x.blockedOwnerId = $b.ownerId AND x.blockedUserId = $b.userId)
        OR (x.blockedOwnerId = $a.ownerId AND x.blockedUserId = $a.userId AND x.blockerOwnerId = $b.ownerId AND x.blockerUserId = $b.userId) RETURN count(x) > 0 AS blocked`, { a: { ownerId: a.ownerId, userId: a.userId }, b: { ownerId: b.ownerId, userId: b.userId } }, 'READ')
      return result.records[0].get('blocked') === true
    },
    async removeOwner(member) {
      await run('MATCH (b:UnlinkedMemberBlock) WHERE (b.blockerOwnerId = $ownerId AND b.blockerUserId = $userId) OR (b.blockedOwnerId = $ownerId AND b.blockedUserId = $userId) DETACH DELETE b', { ownerId: member.ownerId, userId: member.userId })
    },
  }
}

// The service the browser and the connection rules use.
export function createMemberBlocks({ store, now = Date.now } = {}) {
  if (!store || ['initialize', 'add', 'list', 'remove', 'between', 'removeOwner'].some(name => typeof store[name] !== 'function')) throw new Error('block_store_required')
  return {
    initialize: () => store.initialize(),
    block: (blocker, target) => store.add(blockRecord(blocker, target, { now })),
    list: member => valid(member) ? store.list(member) : [],
    unblock: (member, id) => valid(member) && typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? store.remove(member, id) : null,
    // Either direction: a block stops connection requests both ways.
    between: (a, b) => valid(a) && valid(b) && !same(a, b) ? store.between(a, b) : false,
    // The OpenChat users and public profiles this member blocked.
    async hidden(member) {
      const list = valid(member) ? await store.list(member) : []
      return { users: new Set(list.map(value => value.openChatUserId).filter(Boolean)), profiles: new Set(list.map(value => value.blockedProfileId).filter(Boolean)) }
    },
    removeOwner: member => valid(member) ? store.removeOwner(member) : undefined,
  }
}
