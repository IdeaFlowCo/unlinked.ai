import { randomUUID } from 'node:crypto'

// A stored, per-account notification feed. Each event is one record keyed by a
// `dedupeKey`, so replays, retries and double submits never notify twice.
//
// Two read states, like LinkedIn: `seenAt` clears the bell badge (set when the
// member opens the notifications page) and `readAt` clears an item's highlight
// (set when they open that item, or mark everything read).
//
// Delivery beyond the page is deliberately not built yet: a later mailer can
// select records whose kind has `email: true` in NOTIFICATION_KINDS and that
// carry no `emailedAt`, send, then set `emailedAt`. Nothing here assumes the
// page is the only channel.
export const NOTIFICATION_KINDS = Object.freeze({
  // Someone asked to connect with you.
  connection_request_received: Object.freeze({ email: true }),
  // Someone accepted your connection request.
  connection_request_accepted: Object.freeze({ email: true }),
  // Someone accepted an off-platform invite you sent (and so joined Unlinked).
  invite_accepted: Object.freeze({ email: true }),
  // Someone you listed as a connection joined and claimed their profile.
  profile_claimed: Object.freeze({ email: false }),
})
export const NOTIFICATIONS_PER_ACCOUNT = 500
const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const owner = value => {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.userId !== 'string' || !value.userId) throw new Error('notification_owner_required')
  return value
}
const plainName = value => {
  const name = typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''
  return name && [...name].length <= 120 && !/[\u0000-\u001f\u007f<>@]/.test(name) ? name : 'An Unlinked member'
}

export function createNotifications({ store, now = Date.now, keep = NOTIFICATIONS_PER_ACCOUNT } = {}) {
  if (!store || ['insertOnce', 'list', 'counts', 'markSeen', 'markRead', 'markAllRead', 'markReadByKey', 'deleteByKey', 'deleteOwner', 'prune'].some(name => typeof store[name] !== 'function')) throw new Error('notification_store_required')
  const view = record => ({ id: record.id, kind: record.kind, actorName: record.actorName, ...(record.actorProfileId ? { actorProfileId: record.actorProfileId } : {}),
    ...(record.subjectId ? { subjectId: record.subjectId } : {}), createdAt: record.createdAt, seen: record.seenAt != null, read: record.readAt != null })
  return {
    // Returns true when this event is new for the recipient.
    async notify({ recipient, kind, actor, actorName, actorProfileId, subjectId, dedupeKey }) {
      owner(recipient)
      if (!Object.hasOwn(NOTIFICATION_KINDS, kind)) throw new Error('notification_kind_invalid')
      if (typeof dedupeKey !== 'string' || !dedupeKey || dedupeKey.length > 300) throw new Error('notification_key_invalid')
      // Nobody is notified about their own action.
      if (actor && actor.ownerId === recipient.ownerId && actor.userId === recipient.userId) return false
      const record = { id: randomUUID(), dedupeKey, recipientOwnerId: recipient.ownerId, recipientUserId: recipient.userId, kind, actorName: plainName(actorName), createdAt: now() }
      if (actor?.ownerId && actor.userId) Object.assign(record, { actorOwnerId: actor.ownerId, actorUserId: actor.userId })
      if (typeof actorProfileId === 'string' && actorProfileId && actorProfileId.length <= 160) record.actorProfileId = actorProfileId
      if (typeof subjectId === 'string' && subjectId && subjectId.length <= 160) record.subjectId = subjectId
      const created = await store.insertOnce(record)
      if (created) await store.prune(recipient, keep)
      return created
    },
    async list(member, { limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('notification_limit_invalid')
      return (await store.list(owner(member), limit)).map(view)
    },
    async counts(member) { return store.counts(owner(member)) },
    async markSeen(member) { await store.markSeen(owner(member), now()) },
    // Opens one item: marks it read and returns it, or null when it is not this member's.
    async open(member, id) {
      owner(member)
      if (typeof id !== 'string' || !NOTIFICATION_ID.test(id)) return null
      const record = await store.markRead(member, id, now())
      return record ? view(record) : null
    },
    async markAllRead(member) { await store.markAllRead(owner(member), now()) },
    async markReadByKey(member, dedupeKey) { await store.markReadByKey(owner(member), dedupeKey, now()) },
    // The event no longer stands (a withdrawn request): it disappears.
    async retract(dedupeKey) { await store.deleteByKey(dedupeKey) },
    // Account deletion: the account's own feed, and its name in anyone else's.
    async removeOwner(member) { return store.deleteOwner(owner(member)) },
  }
}

export function createMemoryNotificationStore() {
  const records = new Map()
  const mine = member => [...records.values()].filter(record => record.recipientOwnerId === member.ownerId && record.recipientUserId === member.userId)
  const newest = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
  return {
    records,
    async insertOnce(record) {
      if ([...records.values()].some(value => value.dedupeKey === record.dedupeKey)) return false
      records.set(record.id, structuredClone(record)); return true
    },
    async list(member, limit) { return mine(member).sort(newest).slice(0, limit).map(value => structuredClone(value)) },
    async counts(member) { const values = mine(member); return { unseen: values.filter(value => value.seenAt == null).length, unread: values.filter(value => value.readAt == null).length } },
    async markSeen(member, at) { for (const value of mine(member)) value.seenAt ??= at },
    async markRead(member, id, at) {
      const value = records.get(id)
      if (!value || value.recipientOwnerId !== member.ownerId || value.recipientUserId !== member.userId) return null
      value.readAt ??= at; value.seenAt ??= at
      return structuredClone(value)
    },
    async markAllRead(member, at) { for (const value of mine(member)) { value.readAt ??= at; value.seenAt ??= at } },
    async markReadByKey(member, dedupeKey, at) { for (const value of mine(member)) if (value.dedupeKey === dedupeKey) { value.readAt ??= at; value.seenAt ??= at } },
    async deleteByKey(dedupeKey) { for (const [id, value] of records) if (value.dedupeKey === dedupeKey) records.delete(id) },
    async deleteOwner(member) {
      let removed = 0
      for (const [id, value] of records) if ((value.recipientOwnerId === member.ownerId && value.recipientUserId === member.userId) || (value.actorOwnerId === member.ownerId && value.actorUserId === member.userId)) { records.delete(id); removed++ }
      return removed
    },
    async prune(member, keep) { for (const value of mine(member).sort(newest).slice(keep)) records.delete(value.id) },
  }
}

const RECORD_KEYS = ['id', 'dedupeKey', 'recipientOwnerId', 'recipientUserId', 'kind', 'actorOwnerId', 'actorUserId', 'actorName', 'actorProfileId', 'subjectId', 'createdAt', 'seenAt', 'readAt', 'emailedAt']
const fromNode = properties => {
  const value = {}
  for (const name of RECORD_KEYS) if (properties[name] !== undefined && properties[name] !== null) value[name] = typeof properties[name]?.toNumber === 'function' ? properties[name].toNumber() : properties[name]
  if (!Object.hasOwn(NOTIFICATION_KINDS, value.kind)) throw new Error('notification_record_invalid')
  return value
}
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0)

// UnlinkedNotification nodes in the pilot graph; initialize() is additive and idempotent.
export function createNeo4jNotificationStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  const recipient = member => ({ ownerId: member.ownerId, userId: member.userId })
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_notification_id IF NOT EXISTS FOR (n:UnlinkedNotification) REQUIRE n.id IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_notification_dedupe IF NOT EXISTS FOR (n:UnlinkedNotification) REQUIRE n.dedupeKey IS UNIQUE', {})
      await write('CREATE INDEX unlinked_notification_recipient IF NOT EXISTS FOR (n:UnlinkedNotification) ON (n.recipientOwnerId)', {})
      await write('CREATE INDEX unlinked_notification_actor IF NOT EXISTS FOR (n:UnlinkedNotification) ON (n.actorOwnerId)', {})
    },
    // MERGE on the dedupe key: an event that already exists is left alone.
    async insertOnce(record) {
      const { dedupeKey, ...rest } = record
      try {
        const result = await write('MERGE (n:UnlinkedNotification {dedupeKey: $dedupeKey}) ON CREATE SET n += $rest, n._created = true WITH n, coalesce(n._created, false) AS created REMOVE n._created RETURN created', { dedupeKey, rest })
        return result.records[0]?.get('created') === true
      } catch (error) {
        // A concurrent MERGE of the same key loses on the constraint: same event.
        if (String(error?.code ?? '').includes('ConstraintValidationFailed')) return false
        throw error
      }
    },
    async list(member, limit) {
      const result = await read(`MATCH (n:UnlinkedNotification {recipientOwnerId: $ownerId, recipientUserId: $userId}) RETURN properties(n) AS n ORDER BY n.createdAt DESC, n.id LIMIT ${count(limit)}`, recipient(member))
      return result.records.map(record => fromNode(record.get('n')))
    },
    async counts(member) {
      const result = await read('MATCH (n:UnlinkedNotification {recipientOwnerId: $ownerId, recipientUserId: $userId}) RETURN sum(CASE WHEN n.seenAt IS NULL THEN 1 ELSE 0 END) AS unseen, sum(CASE WHEN n.readAt IS NULL THEN 1 ELSE 0 END) AS unread', recipient(member))
      const row = result.records[0]
      return { unseen: number(row?.get('unseen')), unread: number(row?.get('unread')) }
    },
    async markSeen(member, at) { await write('MATCH (n:UnlinkedNotification {recipientOwnerId: $ownerId, recipientUserId: $userId}) WHERE n.seenAt IS NULL SET n.seenAt = $at', { ...recipient(member), at }) },
    async markRead(member, id, at) {
      const result = await write('MATCH (n:UnlinkedNotification {id: $id, recipientOwnerId: $ownerId, recipientUserId: $userId}) SET n.readAt = coalesce(n.readAt, $at), n.seenAt = coalesce(n.seenAt, $at) RETURN properties(n) AS n', { ...recipient(member), id, at })
      return result.records.length ? fromNode(result.records[0].get('n')) : null
    },
    async markAllRead(member, at) { await write('MATCH (n:UnlinkedNotification {recipientOwnerId: $ownerId, recipientUserId: $userId}) WHERE n.readAt IS NULL SET n.readAt = $at, n.seenAt = coalesce(n.seenAt, $at)', { ...recipient(member), at }) },
    async markReadByKey(member, dedupeKey, at) { await write('MATCH (n:UnlinkedNotification {dedupeKey: $dedupeKey, recipientOwnerId: $ownerId, recipientUserId: $userId}) SET n.readAt = coalesce(n.readAt, $at), n.seenAt = coalesce(n.seenAt, $at)', { ...recipient(member), dedupeKey, at }) },
    async deleteByKey(dedupeKey) { await write('MATCH (n:UnlinkedNotification {dedupeKey: $dedupeKey}) DETACH DELETE n', { dedupeKey }) },
    async deleteOwner(member) {
      const result = await write(`MATCH (n:UnlinkedNotification) WHERE (n.recipientOwnerId = $ownerId AND n.recipientUserId = $userId) OR (n.actorOwnerId = $ownerId AND n.actorUserId = $userId)
        WITH n, n.id AS id DETACH DELETE n RETURN count(id) AS removed`, recipient(member))
      return number(result.records[0]?.get('removed'))
    },
    async prune(member, keep) {
      await write(`MATCH (n:UnlinkedNotification {recipientOwnerId: $ownerId, recipientUserId: $userId}) WITH n ORDER BY n.createdAt DESC, n.id SKIP ${count(keep)} DETACH DELETE n`, recipient(member))
    },
  }
}
// LIMIT/SKIP are written as validated integer literals: a JS number parameter
// reaches Neo4j as a float, which it refuses there.
const count = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new Error('notification_limit_invalid'); return value }
