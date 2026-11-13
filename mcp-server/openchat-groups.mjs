import { createHash } from 'node:crypto'
import { communityChatId, validCommunityIdentity as valid } from './community-chat-id.mjs'
const ENDPOINT = 'https://chat.ideaflow.app/api/unlinked/groups/sync'
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Delivery revisions must not change the effective chat-state fingerprint.
const fingerprint = ({ revision, ...snapshot }) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
export function createOpenChatGroupSync({ store, identityForOwner, blocked = async () => false, secret, fetchImpl = fetch, now = Date.now, intervalMs = 1000, auditIntervalMs = 60000 }) {
  let running = null, auditing = null, timer = null, auditTimer = null, stopped = false, cursor = '', nextAuditAt = now() + auditIntervalMs
  const snapshotFor = async (job, group = job.group) => {
    const resolved = job.deleted ? null : await identityForOwner(group.organizer)
    const organizer = job.organizer ?? (valid(resolved) ? { issuer: resolved.issuer, subject: resolved.subject, name: 'Organizer' } : null)
    if (!valid(organizer)) throw Error('identity_unavailable')
    const deleted = job.deleted || !valid(resolved) || resolved.subject !== organizer.subject || resolved.issuer !== organizer.issuer
    const members = [], seen = new Set([organizer.subject])
    if (!deleted) for (const member of group.members) {
      const identity = await identityForOwner(member.actor)
      if (!valid(identity) || seen.has(identity.subject) || await blocked(group.organizer, member.actor)) continue
      seen.add(identity.subject)
      members.push({ issuer: identity.issuer, subject: identity.subject, name: (member.name ?? 'Member').slice(0,160) })
    }
    return { groupId: job.id, revision: job.revision, name: deleted ? 'Deleted community' : group.name, organizer, members, deleted,
      ...(group.chatConversationId ? { existingConversationId: group.chatConversationId } : {}) }
  }
  const reconcile = async (id, completedOnly = false) => {
    const job = await store.chatJob(id)
    if (!job?.fingerprint || job.deleted || (completedOnly && !job.done)) return
    const group = await store.get(id)
    if (group?.chatManaged !== true) return
    const snapshot = await snapshotFor(job, group)
    if (fingerprint(snapshot) !== job.fingerprint) await store.chatRequeue(id, job.revision)
  }
  const deliver = async id => {
    let job = await store.chatJob(id)
    if (!job || job.done || job.nextAttemptAt > now()) return
    try {
      await reconcile(id)
      job = await store.chatJob(id)
      if (!job || job.done || job.nextAttemptAt > now()) return
      const proposed = job.lastSnapshot ?? await snapshotFor(job)
      const snapshot = job.lastSnapshot ?? await store.chatPrepare(id, job.revision, proposed, fingerprint(proposed))
      if (!snapshot || (await store.chatJob(id))?.revision !== job.revision) return
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(snapshot) })
      if (!response.ok) throw Error('sync_unavailable')
      const text = await response.text()
      if (text.length > 2048) throw Error('invalid_receipt')
      const receipt = JSON.parse(text)
      if (receipt.revision !== job.revision || receipt.conversationId !== communityChatId({ id, chatConversationId: snapshot.existingConversationId })) throw Error('invalid_receipt')
      await store.chatFinish(id, job.revision, { done: true })
    } catch {
      const attempts = Math.min((job.attempts ?? 0) + 1,10)
      await store.chatFinish(id, job.revision, { attempts, nextAttemptAt: now() + Math.min(60000,1000 * 2 ** (attempts - 1)) })
    }
  }
  const runOnce = () => {
    if (stopped || !secret || secret.length < 32) return Promise.resolve()
    if (running) return running
    running = (async () => {
      for (const id of await store.chatDue(now(),20)) { if (stopped) break; await deliver(id) }
    })().finally(() => { running = null })
    return running
  }
  const wake = () => { void runOnce().catch(() => {}) }
  const auditOnce = () => {
    if (stopped || !secret || secret.length < 32) return Promise.resolve()
    if (auditing) return auditing
    if (now() < nextAuditAt) return Promise.resolve()
    nextAuditAt = now() + auditIntervalMs
    auditing = (async () => {
      const [id,next] = await store.chatCandidates(cursor,2)
      cursor = next ? id : ''
      if (id && !stopped) await reconcile(id,true)
      wake()
    })().finally(() => { auditing = null })
    return auditing
  }
  const auditWake = () => { void auditOnce().catch(() => {}) }
  return { runOnce, auditOnce, wake,
    start() {
      if (timer || stopped || !secret || secret.length < 32) return
      timer = setInterval(wake,intervalMs); timer.unref?.()
      auditTimer = setInterval(auditWake,auditIntervalMs); auditTimer.unref?.()
      wake()
    },
    async stop() {
      stopped = true; clearInterval(timer); clearInterval(auditTimer)
      await Promise.all([running?.catch(() => {}),auditing?.catch(() => {})])
    },
  }
}
