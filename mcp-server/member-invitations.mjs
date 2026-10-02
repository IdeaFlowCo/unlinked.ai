import { createHash, randomBytes, randomUUID } from 'node:crypto'

// Member-delivered invitations for people who are not on Unlinked yet.
// The platform never sends them: the inviter copies the link and passes it on.
// Only a hash of the token is stored. A token is single-use, expires, and on
// its own binds nothing: accepting needs a signed-in account and an explicit
// click, and records only that this account accepted this invitation.

export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/
const STATUSES = ['pending', 'accepted', 'declined', 'revoked']
const hash = value => createHash('sha256').update(value).digest('hex')

export class InvitationError extends Error {
  constructor(code) { super(code); this.code = code }
}

const owner = value => {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.userId !== 'string' || !value.userId) throw new InvitationError('invitation_owner_required')
  return value
}
// A display name only: no markup characters, no control characters, bounded.
export function invitationName(value) {
  if (typeof value !== 'string') throw new InvitationError('invitation_name_invalid')
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f<>]/.test(name)) throw new InvitationError('invitation_name_invalid')
  return name
}

export function createMemberInvitations({ store, now = Date.now, ttlMs = INVITATION_TTL_MS, maxPending = 100, maxPerDay = 50 } = {}) {
  if (!store || ['insert', 'get', 'listByInviter', 'transition', 'countByInviter', 'deleteByInviter'].some(key => typeof store[key] !== 'function')) throw new Error('invitation_store_required')
  // An expired invitation reads as expired; the stored status stays pending.
  const status = record => record.status === 'pending' && record.expiresAt <= now() ? 'expired' : record.status
  const view = record => ({ id: record.id, inviteeName: record.inviteeName, status: status(record), createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.respondedAt ? { respondedAt: record.respondedAt } : {}) })
  const byToken = async token => typeof token === 'string' && INVITATION_TOKEN.test(token) ? store.get(hash(token)) : null
  return {
    async create({ inviter, inviterName, inviteeName }) {
      owner(inviter)
      const record = { id: randomUUID(), inviterOwnerId: inviter.ownerId, inviterUserId: inviter.userId, inviterName: invitationName(inviterName), inviteeName: invitationName(inviteeName), status: 'pending', createdAt: now() }
      record.expiresAt = record.createdAt + ttlMs
      const counts = await store.countByInviter(inviter, { since: record.createdAt - 24 * 60 * 60 * 1000, now: record.createdAt })
      if (counts.recent >= maxPerDay || counts.pending >= maxPending) throw new InvitationError('invitation_limit')
      const token = randomBytes(32).toString('base64url')
      await store.insert({ ...record, tokenHash: hash(token) })
      return { token, invitation: view(record) }
    },
    async list(inviter) {
      return (await store.listByInviter(owner(inviter))).map(view).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    },
    // What the link's page may show: who invited whom, and whether it still works.
    async open(token) {
      const record = await byToken(token)
      return record ? { inviterName: record.inviterName, inviteeName: record.inviteeName, status: status(record), expiresAt: record.expiresAt } : null
    },
    async respond(token, invitee, action) {
      owner(invitee)
      if (!['accept', 'decline'].includes(action)) throw new InvitationError('invitation_action_invalid')
      const record = await byToken(token)
      if (!record) throw new InvitationError('invitation_not_found')
      if (record.inviterOwnerId === invitee.ownerId) throw new InvitationError('invitation_own')
      if (status(record) !== 'pending') throw new InvitationError('invitation_unavailable')
      const next = action === 'accept' ? 'accepted' : 'declined'
      const changed = await store.transition(record.tokenHash, 'pending', { status: next, respondedAt: now(), responderOwnerId: invitee.ownerId, responderUserId: invitee.userId }, now())
      if (!changed) throw new InvitationError('invitation_unavailable')
      return { status: next, inviterName: record.inviterName }
    },
    async revoke(inviter, id) {
      owner(inviter)
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new InvitationError('invitation_not_found')
      const record = (await store.listByInviter(inviter)).find(value => value.id === id)
      if (!record || !(await store.transition(record.tokenHash, 'pending', { status: 'revoked', respondedAt: now() }, null))) throw new InvitationError('invitation_unavailable')
    },
    // Account deletion removes every invitation the owner created.
    async removeOwner(inviter) { return store.deleteByInviter(owner(inviter)) },
  }
}

// Test and preview storage with the same compare-and-set semantics as Neo4j.
export function createMemoryInvitationStore() {
  const records = new Map()
  const mine = inviter => [...records.values()].filter(value => value.inviterOwnerId === inviter.ownerId && value.inviterUserId === inviter.userId)
  return {
    records,
    async insert(record) { if (records.has(record.tokenHash)) throw new Error('invitation_conflict'); records.set(record.tokenHash, structuredClone(record)) },
    async get(tokenHash) { const value = records.get(tokenHash); return value ? structuredClone(value) : null },
    async listByInviter(inviter) { return mine(inviter).map(value => structuredClone(value)) },
    async transition(tokenHash, from, patch, unexpiredAt) {
      const value = records.get(tokenHash)
      if (!value || value.status !== from || (unexpiredAt !== null && value.expiresAt <= unexpiredAt)) return false
      Object.assign(value, patch); return true
    },
    async countByInviter(inviter, { since, now }) {
      const values = mine(inviter)
      return { recent: values.filter(value => value.createdAt > since).length, pending: values.filter(value => value.status === 'pending' && value.expiresAt > now).length }
    },
    async deleteByInviter(inviter) { const values = mine(inviter); for (const value of values) records.delete(value.tokenHash); return values.length },
  }
}

const RECORD_KEYS = ['id', 'tokenHash', 'inviterOwnerId', 'inviterUserId', 'inviterName', 'inviteeName', 'status', 'createdAt', 'expiresAt', 'respondedAt', 'responderOwnerId', 'responderUserId']
const fromNode = properties => {
  const value = {}
  for (const key of RECORD_KEYS) if (properties[key] !== undefined && properties[key] !== null) value[key] = typeof properties[key]?.toNumber === 'function' ? properties[key].toNumber() : properties[key]
  if (!STATUSES.includes(value.status)) throw new Error('invitation_record_invalid')
  return value
}

export function createNeo4jInvitationStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_member_invitation_token IF NOT EXISTS FOR (i:UnlinkedMemberInvitation) REQUIRE i.tokenHash IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_member_invitation_id IF NOT EXISTS FOR (i:UnlinkedMemberInvitation) REQUIRE i.id IS UNIQUE', {})
    },
    async insert(record) { await write('CREATE (i:UnlinkedMemberInvitation) SET i = $record', { record }) },
    async get(tokenHash) {
      const result = await read('MATCH (i:UnlinkedMemberInvitation {tokenHash: $tokenHash}) RETURN properties(i) AS i', { tokenHash })
      return result.records.length ? fromNode(result.records[0].get('i')) : null
    },
    async listByInviter(inviter) {
      const result = await read('MATCH (i:UnlinkedMemberInvitation {inviterOwnerId: $ownerId, inviterUserId: $userId}) RETURN properties(i) AS i ORDER BY i.createdAt DESC LIMIT 1000', inviter)
      return result.records.map(record => fromNode(record.get('i')))
    },
    // Compare-and-set: only a record still in `from` (and unexpired, when asked) changes.
    async transition(tokenHash, from, patch, unexpiredAt) {
      const result = await write(`MATCH (i:UnlinkedMemberInvitation {tokenHash: $tokenHash}) WHERE i.status = $from AND ($unexpiredAt IS NULL OR i.expiresAt > $unexpiredAt)
        SET i += $patch RETURN i.id AS id`, { tokenHash, from, patch, unexpiredAt })
      return result.records.length === 1
    },
    async countByInviter(inviter, { since, now }) {
      const result = await read(`MATCH (i:UnlinkedMemberInvitation {inviterOwnerId: $ownerId, inviterUserId: $userId})
        RETURN sum(CASE WHEN i.createdAt > $since THEN 1 ELSE 0 END) AS recent, sum(CASE WHEN i.status = 'pending' AND i.expiresAt > $now THEN 1 ELSE 0 END) AS pending`, { ...inviter, since, now })
      const record = result.records[0]
      const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0)
      return { recent: number(record?.get('recent')), pending: number(record?.get('pending')) }
    },
    async deleteByInviter(inviter) {
      const result = await write('MATCH (i:UnlinkedMemberInvitation {inviterOwnerId: $ownerId, inviterUserId: $userId}) WITH i, i.id AS id DETACH DELETE i RETURN count(id) AS removed', inviter)
      const removed = result.records[0]?.get('removed')
      return typeof removed?.toNumber === 'function' ? removed.toNumber() : Number(removed ?? 0)
    },
  }
}
