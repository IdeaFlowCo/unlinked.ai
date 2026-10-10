import { IDEAFLOW_ISSUER } from './messaging.mjs'

const ENDPOINT = 'https://chat.ideaflow.app/api/unlinked/connections/accepted'
const identity = value => value?.issuer === IDEAFLOW_ISSUER && typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.subject)

// Accepted request rows are the durable outbox: a commit cannot lose its wakeup.
// No browser/agent-selected recipient, public profile inference, or request note
// crosses this boundary. Reconciliation revisits failed/missed accepted rows.
export function createOpenChatConnectionSync({ store, identityForOwner, secret, fetchImpl = fetch, now = Date.now, intervalMs = 5000 }) {
  if (!store || typeof identityForOwner !== 'function') throw Error('connection_sync_configuration_required')
  let running = null, timer = null, stopped = false
  const deliver = async id => {
    const record = await store.get(id)
    if (!record || record.status !== 'accepted' || record.openChatSyncStatus || (record.openChatNextAttemptAt ?? 0) > now()) return
    try {
      const [sender, recipient] = await Promise.all([
        identityForOwner({ ownerId: record.senderOwnerId, userId: record.senderUserId }),
        identityForOwner({ ownerId: record.recipientOwnerId, userId: record.recipientUserId }),
      ])
      if (!identity(sender) || !identity(recipient) || sender.subject === recipient.subject) throw Error('identity_unavailable')
      // Recheck after identity resolution so a removed request is not dispatched.
      const current = await store.get(id)
      if (!current || current.status !== 'accepted' || current.openChatSyncStatus || current.respondedAt !== record.respondedAt) return
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ requestId: record.id, acceptedAt: record.respondedAt,
          sender: { issuer: sender.issuer, subject: sender.subject, name: record.senderName },
          recipient: { issuer: recipient.issuer, subject: recipient.subject, name: record.recipientName } }) })
      if (!response.ok) throw Error('delivery_unavailable')
      const body = await response.text()
      if (body.length > 2048) throw Error('invalid_receipt')
      const receipt = JSON.parse(body)
      if (!['synced', 'suppressed'].includes(receipt?.status) || (receipt.status === 'synced' && (typeof receipt.conversationId !== 'string' || !receipt.conversationId)) || (receipt.status === 'suppressed' && receipt.conversationId !== null)) throw Error('invalid_receipt')
      await store.finish(id, record.respondedAt, { openChatSyncStatus: receipt.status, openChatSyncedAt: now() })
    } catch {
      const attempts = Math.min((record.openChatSyncAttempts ?? 0) + 1, 20)
      await store.finish(id, record.respondedAt, { openChatSyncAttempts: attempts, openChatNextAttemptAt: now() + Math.min(3600000, 5000 * 2 ** (attempts - 1)) })
    }
  }
  const runOnce = () => {
    if (!secret || secret.length < 32 || stopped) return Promise.resolve()
    if (running) return running
    running = (async () => { for (const id of await store.due(now(), 10)) { if (stopped) break; await deliver(id) } })().finally(() => { running = null })
    return running
  }
  const wake = () => { if (!stopped) void runOnce().catch(() => {}) }
  return { runOnce, wake,
    start() { if (timer || !secret || secret.length < 32 || stopped) return; timer = setInterval(wake, intervalMs); timer.unref?.(); wake() },
    async stop() { stopped = true; clearInterval(timer); timer = null; await running?.catch(() => {}) },
  }
}

export function createNeo4jOpenChatSyncStore(driver, database = 'neo4j') {
  const execute = async (mode, query, params) => {
    const session = driver.session({ database })
    try { return await session[mode](tx => tx.run(query, params)) } finally { await session.close() }
  }
  const properties = record => Object.fromEntries(Object.entries(record).map(([k,v]) => [k, typeof v?.toNumber === 'function' ? v.toNumber() : v]))
  return {
    async due(now, limit) {
      const result = await execute('executeRead', `MATCH (r:UnlinkedConnectionRequest {status:'accepted'})
        WHERE r.openChatSyncStatus IS NULL AND coalesce(r.openChatNextAttemptAt,0) <= $now
        RETURN r.id AS id ORDER BY coalesce(r.openChatNextAttemptAt,0),r.respondedAt,r.id LIMIT toInteger($limit)`, { now, limit })
      return result.records.map(r => r.get('id'))
    },
    async get(id) {
      const result = await execute('executeRead', 'MATCH (r:UnlinkedConnectionRequest {id:$id}) RETURN properties(r) AS r', { id })
      return result.records.length ? properties(result.records[0].get('r')) : null
    },
    async finish(id, acceptedAt, patch) {
      await execute('executeWrite', `MATCH (r:UnlinkedConnectionRequest {id:$id})
        SET r._transitionLock=coalesce(r._transitionLock,0)+1
        WITH r WHERE r.status='accepted' AND r.respondedAt=$acceptedAt AND r.openChatSyncStatus IS NULL
        SET r += $patch`, { id, acceptedAt, patch })
    },
  }
}
