import { createHash, randomUUID } from 'node:crypto'

// Member-to-member connection requests ("Connect"), between two accounts.
// A request is pending until the recipient accepts or ignores it, or the sender
// withdraws it. Accepting connects the two accounts exactly like an accepted
// invite does: each sees the other in People you know, and the shared public
// graph carries an edge when both have a public profile.
//
// The sender is never told about an ignore: an ignored request still reads as
// pending to them, keeps blocking duplicates, and can be withdrawn. The
// recipient can still connect later; pressing Connect on the sender's profile
// accepts the old request instead of creating a second one.
//
// Either member can later remove an accepted connection: it becomes `removed`
// for both of them (nobody is told), and either can send a new request.
//
// Storage enforces the pair rules: `openKey` (set while pending or ignored) and
// `connectedKey` (set once accepted) are the pair's key and unique, so two
// racing requests or accepts between the same two accounts cannot both land.

export const CONNECTION_REQUESTS_PER_DAY = 50
export const RESEND_COOLDOWN_MS = 21 * 24 * 60 * 60 * 1000
export const CONNECTION_NOTE_LIMIT = 300
const STATUSES = ['pending', 'accepted', 'ignored', 'withdrawn', 'removed']
const OPEN = ['pending', 'ignored']
const DAY = 24 * 60 * 60 * 1000
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class ConnectionError extends Error {
  constructor(code) { super(code); this.code = code }
}

const owner = value => {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.userId !== 'string' || !value.userId) throw new ConnectionError('connection_owner_required')
  return value
}
const same = (a, b) => a.ownerId === b.ownerId && a.userId === b.userId
const key = member => `${member.ownerId}\u0000${member.userId}`
// One key for the unordered pair, so A→B and B→A collide.
export const pairKey = (a, b) => createHash('sha256').update([key(a), key(b)].sort().join('\u0001')).digest('hex')
const senderOf = record => ({ ownerId: record.senderOwnerId, userId: record.senderUserId })
const recipientOf = record => ({ ownerId: record.recipientOwnerId, userId: record.recipientUserId })

// A display name only: plain text, bounded. Anything else is not kept.
export function connectionName(value) {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  // Opaque identifiers (an OIDC subject standing in for a name) are not names either.
  return name && [...name].length <= 120 && !/[\u0000-\u001f\u007f<>@]/.test(name) && !/^[0-9a-f-]{20,}$/i.test(name) && !/^[A-Za-z0-9_|:.-]{24,}$/.test(name) ? name : null
}
// An optional short note: single paragraph, no control characters.
export function connectionNote(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ConnectionError('connection_note_invalid')
  const note = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!note) return null
  if ([...note].length > CONNECTION_NOTE_LIMIT || /[\u0000-\u001f\u007f]/.test(note)) throw new ConnectionError('connection_note_invalid')
  return note
}

export function createConnectionRequests({ store, notifications = null, now = Date.now, perDay = CONNECTION_REQUESTS_PER_DAY, cooldownMs = RESEND_COOLDOWN_MS } = {}) {
  if (!store || ['insert', 'get', 'listPair', 'listByRecipient', 'listBySender', 'listAccepted', 'transition', 'countSentSince', 'countReceivedPending', 'deleteOwner'].some(name => typeof store[name] !== 'function')) throw new Error('connection_store_required')
  if (!Number.isSafeInteger(perDay) || perDay < 1 || !Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new Error('connection_limits_invalid')
  // Notifications never decide whether a request works.
  const quietly = async work => { try { await work() } catch { /* best effort */ } }
  const requestKey = id => `connection-request:${id}`
  // What one side sees. The sender never learns about an ignore.
  const view = (record, member) => {
    const received = same(recipientOf(record), member)
    const status = !received && record.status === 'ignored' ? 'pending' : record.status
    return { id: record.id, direction: received ? 'received' : 'sent', status, name: received ? record.senderName : record.recipientName,
      ...((received ? record.senderProfileId : record.recipientProfileId) ? { profileId: received ? record.senderProfileId : record.recipientProfileId } : {}),
      ...(record.note ? { note: record.note } : {}), createdAt: record.createdAt, ...(record.respondedAt && status !== 'pending' ? { respondedAt: record.respondedAt } : {}) }
  }
  const service = {
    async send({ sender, senderName, senderProfileId, recipient, recipientName, recipientProfileId, note }) {
      owner(sender); owner(recipient)
      if (same(sender, recipient)) throw new ConnectionError('connection_self')
      const text = connectionNote(note)
      const pair = pairKey(sender, recipient), existing = await store.listPair(pair)
      if (existing.some(record => record.status === 'accepted')) throw new ConnectionError('connection_exists')
      // They already asked you: connecting answers their request.
      const incoming = existing.find(record => OPEN.includes(record.status) && same(senderOf(record), recipient))
      if (incoming) return { status: 'accepted', request: await service.respond(sender, incoming.id, 'accept') }
      if (existing.some(record => OPEN.includes(record.status))) throw new ConnectionError('connection_pending')
      const at = now()
      const withdrawn = existing.filter(record => record.status === 'withdrawn' && same(senderOf(record), sender)).map(record => record.withdrawnAt ?? 0)
      if (withdrawn.length && Math.max(...withdrawn) + cooldownMs > at) throw new ConnectionError('connection_cooldown')
      if (await store.countSentSince(sender, at - DAY) >= perDay) throw new ConnectionError('connection_rate_limited')
      const record = { id: randomUUID(), pairKey: pair, openKey: pair, senderOwnerId: sender.ownerId, senderUserId: sender.userId, senderName: connectionName(senderName) ?? 'An Unlinked member',
        recipientOwnerId: recipient.ownerId, recipientUserId: recipient.userId, recipientName: connectionName(recipientName) ?? 'An Unlinked member', status: 'pending', createdAt: at }
      if (typeof senderProfileId === 'string' && senderProfileId) record.senderProfileId = senderProfileId
      if (typeof recipientProfileId === 'string' && recipientProfileId) record.recipientProfileId = recipientProfileId
      if (text) record.note = text
      try { await store.insert(record) } catch (error) {
        if (error?.message === 'connection_conflict') throw new ConnectionError('connection_pending')
        throw error
      }
      if (notifications) await quietly(() => notifications.notify({ recipient, kind: 'connection_request_received', actor: sender, actorName: record.senderName,
        ...(record.senderProfileId ? { actorProfileId: record.senderProfileId } : {}), subjectId: record.id, dedupeKey: requestKey(record.id) }))
      return { status: 'pending', request: view(record, sender) }
    },
    // Only the recipient answers. Unknown and other people's requests look the same.
    async respond(recipient, id, action) {
      owner(recipient)
      if (!['accept', 'ignore'].includes(action)) throw new ConnectionError('connection_action_invalid')
      const record = typeof id === 'string' && REQUEST_ID.test(id) ? await store.get(id) : null
      if (!record || !same(recipientOf(record), recipient)) throw new ConnectionError('connection_not_found')
      const at = now()
      let changed
      try {
        changed = action === 'accept'
          ? await store.transition(id, OPEN, { status: 'accepted', respondedAt: at, connectedKey: record.pairKey }, ['openKey'])
          : await store.transition(id, ['pending'], { status: 'ignored', respondedAt: at }, [])
      } catch (error) {
        if (error?.message === 'connection_conflict') throw new ConnectionError('connection_exists')
        throw error
      }
      if (!changed) throw new ConnectionError('connection_unavailable')
      const settled = { ...record, status: action === 'accept' ? 'accepted' : 'ignored', respondedAt: at }
      if (notifications) {
        await quietly(() => notifications.markReadByKey(recipient, requestKey(id)))
        if (action === 'accept') await quietly(() => notifications.notify({ recipient: senderOf(record), kind: 'connection_request_accepted', actor: recipient, actorName: record.recipientName,
          ...(record.recipientProfileId ? { actorProfileId: record.recipientProfileId } : {}), subjectId: id, dedupeKey: `connection-accepted:${id}` }))
      }
      return view(settled, recipient)
    },
    // Only the sender withdraws, while the request is still open. The
    // recipient's notification goes with it, so they never see a dead request.
    async withdraw(sender, id) {
      owner(sender)
      const record = typeof id === 'string' && REQUEST_ID.test(id) ? await store.get(id) : null
      if (!record || !same(senderOf(record), sender)) throw new ConnectionError('connection_not_found')
      if (!(await store.transition(id, OPEN, { status: 'withdrawn', withdrawnAt: now() }, ['openKey']))) throw new ConnectionError('connection_unavailable')
      if (notifications) await quietly(() => notifications.retract(requestKey(id)))
    },
    // Either member removes an accepted connection, for both of them. The
    // record stays as `removed` (history, and the pair key is freed so either
    // side can ask again); nobody is notified. Only the two members can do it,
    // and anything else looks like an unknown id.
    async remove(member, id) {
      owner(member)
      const record = typeof id === 'string' && REQUEST_ID.test(id) ? await store.get(id) : null
      if (!record || (!same(senderOf(record), member) && !same(recipientOf(record), member))) throw new ConnectionError('connection_not_found')
      if (!(await store.transition(id, ['accepted'], { status: 'removed', removedAt: now(), removedBy: same(senderOf(record), member) ? 'sender' : 'recipient' }, ['connectedKey']))) throw new ConnectionError('connection_unavailable')
    },
    // Internal pair lifecycle operation: connection-actions first authorizes a
    // selected accepted request/invitation involving this member. Removing that
    // agreement also settles obsolete requests, without the withdrawal cooldown.
    async settleRemovedPair(member, other) {
      owner(member); owner(other)
      if (same(member, other)) throw new ConnectionError('connection_self')
      for (const record of await store.listPair(pairKey(member, other))) {
        if (!['accepted', ...OPEN].includes(record.status)) continue
        const changed = await store.transition(record.id, ['accepted', ...OPEN],
          { status: 'removed', removedAt: now(), removedBy: same(senderOf(record), member) ? 'sender' : 'recipient' }, ['openKey', 'connectedKey'])
        if (changed && OPEN.includes(record.status) && notifications) await quietly(() => notifications.retract(requestKey(record.id)))
      }
    },
    // Requests waiting for this member's answer (ignored ones are set aside).
    async received(member) {
      return (await store.listByRecipient(owner(member), ['pending'])).map(record => view(record, member)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    },
    // Requests this member sent that are still open.
    async sent(member) {
      return (await store.listBySender(owner(member), OPEN)).map(record => view(record, member)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    },
    async pendingCount(member) { return store.countReceivedPending(owner(member)) },
    // Where two accounts stand, from `member`'s side.
    async between(member, other) {
      owner(member); owner(other)
      if (same(member, other)) return { state: 'self' }
      const records = await store.listPair(pairKey(member, other))
      const accepted = records.find(record => record.status === 'accepted')
      if (accepted) return { state: 'connected', requestId: accepted.id }
      const mine = records.find(record => OPEN.includes(record.status) && same(senderOf(record), member))
      if (mine) return { state: 'outgoing', requestId: mine.id }
      const theirs = records.find(record => record.status === 'pending' && same(senderOf(record), other))
      if (theirs) return { state: 'incoming', requestId: theirs.id, ...(theirs.note ? { note: theirs.note } : {}) }
      return { state: 'none' }
    },
    // The accounts this member is connected to through accepted requests.
    async connections(member) {
      owner(member)
      return (await store.listAccepted(member)).map(record => same(senderOf(record), member)
        ? { requestId: record.id, other: recipientOf(record), name: record.recipientName }
        : { requestId: record.id, other: senderOf(record), name: record.senderName })
    },
    // Every accepted request, for the shared public graph.
    async accepted() { return (await store.listAccepted(null)).map(record => ({ requestId: record.id, sender: senderOf(record), recipient: recipientOf(record) })) },
    // Account deletion: every request this account sent or received goes, and
    // with it every connection it made this way.
    async removeOwner(member) {
      const removed = await store.deleteOwner(owner(member))
      if (notifications) for (const id of removed) await quietly(() => notifications.retract(requestKey(id)))
      return removed.length
    },
  }
  return service
}

// Test and preview storage with the same uniqueness and compare-and-set rules as Neo4j.
export function createMemoryConnectionStore() {
  const records = new Map()
  const all = () => [...records.values()]
  const copy = value => structuredClone(value)
  const isSender = (record, member) => record.senderOwnerId === member.ownerId && record.senderUserId === member.userId
  const isRecipient = (record, member) => record.recipientOwnerId === member.ownerId && record.recipientUserId === member.userId
  const taken = (field, value, id) => value !== undefined && all().some(record => record.id !== id && record[field] === value)
  return {
    records,
    async insert(record) {
      if (records.has(record.id) || taken('openKey', record.openKey) || taken('connectedKey', record.connectedKey)) throw new Error('connection_conflict')
      records.set(record.id, copy(record))
    },
    async get(id) { const value = records.get(id); return value ? copy(value) : null },
    async listPair(pair) { return all().filter(record => record.pairKey === pair).map(copy) },
    async listByRecipient(member, statuses) { return all().filter(record => isRecipient(record, member) && statuses.includes(record.status)).map(copy) },
    async listBySender(member, statuses) { return all().filter(record => isSender(record, member) && statuses.includes(record.status)).map(copy) },
    async listAccepted(member) { return all().filter(record => record.status === 'accepted' && (!member || isSender(record, member) || isRecipient(record, member))).map(copy) },
    async transition(id, from, patch, remove) {
      const value = records.get(id)
      if (!value || !from.includes(value.status)) return false
      if (taken('connectedKey', patch.connectedKey, id)) throw new Error('connection_conflict')
      Object.assign(value, patch); for (const name of remove) delete value[name]
      return true
    },
    async countSentSince(member, since) { return all().filter(record => isSender(record, member) && record.createdAt > since).length },
    async countReceivedPending(member) { return all().filter(record => isRecipient(record, member) && record.status === 'pending').length },
    async deleteOwner(member) {
      const removed = all().filter(record => isSender(record, member) || isRecipient(record, member)).map(record => record.id)
      for (const id of removed) records.delete(id)
      return removed
    },
  }
}

const RECORD_KEYS = ['id', 'pairKey', 'openKey', 'connectedKey', 'senderOwnerId', 'senderUserId', 'senderName', 'senderProfileId', 'recipientOwnerId', 'recipientUserId', 'recipientName', 'recipientProfileId', 'note', 'status', 'createdAt', 'respondedAt', 'withdrawnAt', 'removedAt', 'removedBy']
const fromNode = properties => {
  const value = {}
  for (const name of RECORD_KEYS) if (properties[name] !== undefined && properties[name] !== null) value[name] = typeof properties[name]?.toNumber === 'function' ? properties[name].toNumber() : properties[name]
  if (!STATUSES.includes(value.status)) throw new Error('connection_record_invalid')
  return value
}
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0)
const conflict = error => String(error?.code ?? '').includes('ConstraintValidationFailed')

// UnlinkedConnectionRequest nodes in the pilot graph. initialize() is additive
// and idempotent (IF NOT EXISTS): it only adds this label's constraints/indexes.
export function createNeo4jConnectionStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  const rows = result => result.records.map(record => fromNode(record.get('r')))
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_connection_request_id IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) REQUIRE r.id IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_connection_request_open IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) REQUIRE r.openKey IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_connection_request_connected IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) REQUIRE r.connectedKey IS UNIQUE', {})
      await write('CREATE INDEX unlinked_connection_request_pair IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) ON (r.pairKey)', {})
      await write('CREATE INDEX unlinked_connection_request_recipient IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) ON (r.recipientOwnerId)', {})
      await write('CREATE INDEX unlinked_connection_request_sender IF NOT EXISTS FOR (r:UnlinkedConnectionRequest) ON (r.senderOwnerId)', {})
    },
    async insert(record) {
      try { await write('CREATE (r:UnlinkedConnectionRequest) SET r = $record', { record }) }
      catch (error) { if (conflict(error)) throw new Error('connection_conflict'); throw error }
    },
    async get(id) {
      const result = await read('MATCH (r:UnlinkedConnectionRequest {id: $id}) RETURN properties(r) AS r', { id })
      return result.records.length ? fromNode(result.records[0].get('r')) : null
    },
    async listPair(pair) { return rows(await read('MATCH (r:UnlinkedConnectionRequest {pairKey: $pair}) RETURN properties(r) AS r ORDER BY r.createdAt LIMIT 500', { pair })) },
    async listByRecipient(member, statuses) {
      return rows(await read('MATCH (r:UnlinkedConnectionRequest {recipientOwnerId: $ownerId, recipientUserId: $userId}) WHERE r.status IN $statuses RETURN properties(r) AS r ORDER BY r.createdAt DESC LIMIT 1000', { ownerId: member.ownerId, userId: member.userId, statuses }))
    },
    async listBySender(member, statuses) {
      return rows(await read('MATCH (r:UnlinkedConnectionRequest {senderOwnerId: $ownerId, senderUserId: $userId}) WHERE r.status IN $statuses RETURN properties(r) AS r ORDER BY r.createdAt DESC LIMIT 1000', { ownerId: member.ownerId, userId: member.userId, statuses }))
    },
    // One member's side uses the sender/recipient indexes; only the whole-graph build scans.
    async listAccepted(member) {
      if (!member) return rows(await read(`MATCH (r:UnlinkedConnectionRequest {status: 'accepted'}) RETURN properties(r) AS r ORDER BY r.respondedAt, r.id LIMIT 100000`, {}))
      return rows(await read(`CALL {
          MATCH (r:UnlinkedConnectionRequest {senderOwnerId: $ownerId, senderUserId: $userId, status: 'accepted'}) RETURN r
          UNION
          MATCH (r:UnlinkedConnectionRequest {recipientOwnerId: $ownerId, recipientUserId: $userId, status: 'accepted'}) RETURN r
        } RETURN properties(r) AS r ORDER BY r.respondedAt, r.id LIMIT 100000`, { ownerId: member.ownerId, userId: member.userId }))
    },
    // Compare-and-set: only a request still in one of `from` changes.
    async transition(id, from, patch, remove) {
      try {
        const result = await write(`MATCH (r:UnlinkedConnectionRequest {id: $id}) WHERE r.status IN $from SET r += $patch ${remove.length ? `REMOVE ${remove.map(name => `r.${name}`).join(', ')}` : ''} RETURN r.id AS id`,
          { id, from, patch })
        return result.records.length === 1
      } catch (error) { if (conflict(error)) throw new Error('connection_conflict'); throw error }
    },
    async countSentSince(member, since) {
      const result = await read('MATCH (r:UnlinkedConnectionRequest {senderOwnerId: $ownerId, senderUserId: $userId}) WHERE r.createdAt > $since RETURN count(r) AS n', { ownerId: member.ownerId, userId: member.userId, since })
      return number(result.records[0]?.get('n'))
    },
    async countReceivedPending(member) {
      const result = await read(`MATCH (r:UnlinkedConnectionRequest {recipientOwnerId: $ownerId, recipientUserId: $userId, status: 'pending'}) RETURN count(r) AS n`, { ownerId: member.ownerId, userId: member.userId })
      return number(result.records[0]?.get('n'))
    },
    async deleteOwner(member) {
      const result = await write(`MATCH (r:UnlinkedConnectionRequest) WHERE (r.senderOwnerId = $ownerId AND r.senderUserId = $userId) OR (r.recipientOwnerId = $ownerId AND r.recipientUserId = $userId)
        WITH r, r.id AS id DETACH DELETE r RETURN collect(id) AS ids`, { ownerId: member.ownerId, userId: member.userId })
      return result.records[0]?.get('ids') ?? []
    },
  }
}
