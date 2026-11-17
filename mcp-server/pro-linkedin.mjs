import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { UNIPILE_ACCOUNT_ID } from './unipile-client.mjs'

// Owner-only Pro LinkedIn source (unlinked-flav, docs/pro-linkedin.md).
//
// A Pro owner links their OWN LinkedIn session through Unipile Hosted Auth.
// Ideaflow stays the application identity; this links a private data source.
// Rules this module owns:
// - Eligibility is an exact server-side allowlist of account owners plus a
//   feature switch. It is not a tier, a browser flag, an email or imported data.
// - A browser redirect proves nothing. A source is bound only after the
//   one-time callback for a live attempt AND a server-side read of the provider
//   account and of the LinkedIn identity that signed in.
// - Sources are `personal`. Configured system account ids can never be bound,
//   read, searched or removed here, and there is no default-account fallback.
// - Every write is fenced by the source generation, so a disconnect always wins
//   over a late callback or an in-flight request.
// - Connecting grants nothing else: no messaging, invitations, posting,
//   publication, sync or agent permission.

export const PRO_ATTEMPT_TTL_MS = 15 * 60 * 1000
export const PRO_SEARCH_RECEIPT_TTL_MS = 10 * 60 * 1000
export const PRO_CONSENT_VERSION = 'pro-linkedin-source-v1'
const CREATED_SKEW_MS = 2 * 60 * 1000
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const RECEIPT_LIMIT = 1000
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const fail = (code, extra = {}) => Object.assign(new Error(`pro_linkedin_${code}`), { code, ...extra })
const validOwner = owner => typeof owner?.ownerId === 'string' && owner.ownerId && owner.ownerId.length <= 200 && typeof owner.userId === 'string' && owner.userId && owner.userId.length <= 200
const sha256 = value => createHash('sha256').update(value).digest('hex')
const accountKeyOf = accountId => sha256('unipile-account\u0000' + accountId)
const selfKeyOf = providerId => sha256('linkedin-self\u0000' + providerId)
export const proTokenHash = token => sha256('pro-linkedin-notify\u0000' + token)

// Exact allowlist: entries are JSON pairs [ownerId, userId]. Anything
// malformed disables the whole list rather than widening it.
export function createProAccess({ owners = [], enabled = false } = {}) {
  const valid = Array.isArray(owners) && owners.length <= 50 && owners.every(entry => Array.isArray(entry) && entry.length === 2 && validOwner({ ownerId: entry[0], userId: entry[1] }))
  const keys = new Set(valid ? owners.map(entry => JSON.stringify(entry)) : [])
  return { enabled: enabled === true && keys.size > 0, allowed: owner => enabled === true && validOwner(owner) && keys.has(JSON.stringify([owner.ownerId, owner.userId])) }
}
export function proAccessFromEnv(env = process.env) {
  let owners = []
  try { owners = JSON.parse(env.UNLINKED_PRO_OWNERS || '[]') } catch { owners = null }
  return createProAccess({ owners, enabled: env.UNLINKED_PRO_LINKEDIN === 'on' })
}

const SOURCE_STATES = ['connected', 'reconnect_required', 'paused', 'disconnected']
// A record without one of these states (for example a stateless leftover) is not linked.
const LINKED_STATES = ['connected', 'reconnect_required', 'paused']
const normalQuery = query => query.trim().replace(/\s+/g, ' ').toLowerCase()

// ---- Stores -------------------------------------------------------------

export function createMemoryProLinkedinStore() {
  const sources = new Map(), attempts = new Map(), counters = new Map()
  return {
    async initialize() {},
    async createAttempt(record) {
      for (const attempt of attempts.values()) if (attempt.ownerId === record.ownerId && attempt.state === 'pending') Object.assign(attempt, { state: 'superseded', settledAt: record.createdAt })
      if (attempts.has(record.attemptId) || [...attempts.values()].some(attempt => attempt.tokenHash === record.tokenHash)) throw fail('store_conflict')
      attempts.set(record.attemptId, { ...record })
    },
    async attemptByTokenHash(tokenHash) { const found = [...attempts.values()].find(attempt => attempt.tokenHash === tokenHash); return found ? { ...found } : null },
    async latestAttempt(owner) { const mine = [...attempts.values()].filter(attempt => attempt.ownerId === owner.ownerId && attempt.userId === owner.userId).reverse().sort((a, b) => b.createdAt - a.createdAt)[0]; return mine ? { ...mine } : null },
    async supersedeAttempts(owner, at) { for (const attempt of attempts.values()) if (attempt.ownerId === owner.ownerId && ['pending', 'binding'].includes(attempt.state)) Object.assign(attempt, { state: 'superseded', settledAt: at }) },
    // Compare-and-set on the attempt state: pending -> binding -> verified|failed,
    // or pending -> failed|expired|superseded. Each transition happens once.
    async settleAttempt(attemptId, patch, from = 'pending') { const attempt = attempts.get(attemptId); if (!attempt || attempt.state !== from) return false; Object.assign(attempt, patch); return true },
    // The cleanup marker for a provider account an attempt created; independent of the attempt state.
    async markCleanup(attemptId, patch) { const attempt = attempts.get(attemptId); if (!attempt) return false; Object.assign(attempt, patch); return true },
    async pendingCleanups(limit) { return [...attempts.values()].filter(attempt => attempt.cleanup === 'pending').slice(0, limit).map(attempt => ({ ...attempt })) },
    async getSource(owner) { const source = sources.get(owner.ownerId); return source && source.userId === owner.userId ? { ...source } : null },
    async findSourceByKeys({ accountKey, selfKey }) { return [...sources.values()].filter(source => accountKey && source.accountKey === accountKey || selfKey && source.selfKey === selfKey).map(source => ({ ...source })) },
    async pendingRevocations(limit) { return [...sources.values()].filter(source => source.providerRevocation === 'pending').slice(0, limit).map(source => ({ ...source })) },
    async removeSource(owner, expectedGeneration) { const current = sources.get(owner.ownerId); if (!current || current.userId !== owner.userId || current.generation !== expectedGeneration) return false; sources.delete(owner.ownerId); return true },
    // Per-owner daily search count, incremented before the provider call; null once the bound is reached.
    async countSearch(ownerId, day, limit) { const used = counters.get(ownerId), count = used?.day === day ? used.count : 0; if (count >= limit) return null; counters.set(ownerId, { day, count: count + 1 }); return count + 1 },
    // Compare-and-set on generation; provider account and LinkedIn identity
    // are each bound to at most one owner.
    async putSource(record, expectedGeneration) {
      const current = sources.get(record.ownerId)
      if ((current?.generation ?? 0) !== expectedGeneration || current && current.userId !== record.userId) return false
      for (const other of sources.values()) if (other.ownerId !== record.ownerId && (record.accountKey && other.accountKey === record.accountKey || record.selfKey && other.selfKey === record.selfKey)) throw fail('account_in_use')
      sources.set(record.ownerId, { ...record })
      return true
    },
    // Account deletion. A provider removal or cleanup that has not finished keeps
    // only its own record (marked for a deleted owner) for sweepPendingRemovals.
    async removeOwner(owner) {
      const source = sources.get(owner.ownerId)
      if (source?.providerRevocation === 'pending') source.ownerDeleted = true; else sources.delete(owner.ownerId)
      counters.delete(owner.ownerId)
      for (const [id, attempt] of attempts) if (attempt.ownerId === owner.ownerId && attempt.cleanup !== 'pending') attempts.delete(id)
    },
    async pruneAttempts(before) { for (const [id, attempt] of attempts) if (attempt.cleanup !== 'pending' && (attempt.state !== 'pending' && attempt.createdAt < before || attempt.expiresAt < before)) attempts.delete(id) },
  }
}

const SOURCE_KEYS = ['ownerId', 'userId', 'role', 'state', 'generation', 'accountId', 'accountKey', 'selfKey', 'selfName', 'selfPublicIdentifier', 'connectedAt', 'verifiedAt', 'updatedAt', 'consentVersion', 'providerRevocation', 'ownerDeleted']
const ATTEMPT_KEYS = ['attemptId', 'tokenHash', 'ownerId', 'userId', 'kind', 'generation', 'state', 'failure', 'createdAt', 'expiresAt', 'settledAt', 'cleanup', 'cleanupAccountId']
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const plainRecord = (value, keys) => value ? Object.fromEntries(keys.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, number(value[key])])) : null
const props = (record, keys) => Object.fromEntries(keys.map(key => [key, record[key] ?? null]))

// Graph labels UnlinkedProSource / UnlinkedProAuthAttempt / UnlinkedProSearchCount
// (in the recovery domain: deploy/private-pilot/graph-migration.mjs). All values are parameters.
export function createNeo4jProLinkedinStore(driver, database = 'neo4j') {
  const run = async (query, params = {}, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  const rows = (result, keys) => result.records.map(record => plainRecord(record.get('value'), keys))
  return {
    async initialize() {
      await run('CREATE CONSTRAINT unlinked_pro_source_owner IF NOT EXISTS FOR (s:UnlinkedProSource) REQUIRE s.ownerId IS UNIQUE')
      await run('CREATE CONSTRAINT unlinked_pro_source_account IF NOT EXISTS FOR (s:UnlinkedProSource) REQUIRE s.accountKey IS UNIQUE')
      await run('CREATE CONSTRAINT unlinked_pro_source_self IF NOT EXISTS FOR (s:UnlinkedProSource) REQUIRE s.selfKey IS UNIQUE')
      await run('CREATE CONSTRAINT unlinked_pro_attempt_id IF NOT EXISTS FOR (a:UnlinkedProAuthAttempt) REQUIRE a.attemptId IS UNIQUE')
      await run('CREATE CONSTRAINT unlinked_pro_attempt_token IF NOT EXISTS FOR (a:UnlinkedProAuthAttempt) REQUIRE a.tokenHash IS UNIQUE')
      await run('CREATE CONSTRAINT unlinked_pro_search_count_owner IF NOT EXISTS FOR (c:UnlinkedProSearchCount) REQUIRE c.ownerId IS UNIQUE')
    },
    async createAttempt(record) {
      await run(`OPTIONAL MATCH (old:UnlinkedProAuthAttempt {ownerId: $ownerId}) WHERE old.state = 'pending'
        SET old.state = 'superseded', old.settledAt = $createdAt
        WITH count(old) AS superseded CREATE (a:UnlinkedProAuthAttempt) SET a = $props`, { ownerId: record.ownerId, createdAt: record.createdAt, props: props(record, ATTEMPT_KEYS) })
    },
    async attemptByTokenHash(tokenHash) { return rows(await run('MATCH (a:UnlinkedProAuthAttempt {tokenHash: $tokenHash}) RETURN properties(a) AS value LIMIT 1', { tokenHash }, 'READ'), ATTEMPT_KEYS)[0] ?? null },
    async latestAttempt(owner) { return rows(await run('MATCH (a:UnlinkedProAuthAttempt {ownerId: $ownerId}) WHERE a.userId = $userId RETURN properties(a) AS value ORDER BY a.createdAt DESC, a.settledAt IS NULL DESC LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ'), ATTEMPT_KEYS)[0] ?? null },
    async supersedeAttempts(owner, at) { await run(`MATCH (a:UnlinkedProAuthAttempt {ownerId: $ownerId}) WHERE a.state IN ['pending', 'binding'] SET a.state = 'superseded', a.settledAt = $at`, { ownerId: owner.ownerId, at }) },
    async settleAttempt(attemptId, patch, from = 'pending') {
      const result = await run('MATCH (a:UnlinkedProAuthAttempt {attemptId: $attemptId}) WHERE a.state = $from SET a += $patch RETURN count(a) AS settled', { attemptId, patch, from })
      return number(result.records[0]?.get('settled')) === 1
    },
    async markCleanup(attemptId, patch) {
      const result = await run('MATCH (a:UnlinkedProAuthAttempt {attemptId: $attemptId}) SET a += $patch RETURN count(a) AS marked', { attemptId, patch })
      return number(result.records[0]?.get('marked')) === 1
    },
    async pendingCleanups(limit) { return rows(await run(`MATCH (a:UnlinkedProAuthAttempt) WHERE a.cleanup = 'pending' RETURN properties(a) AS value ORDER BY a.createdAt LIMIT toInteger($limit)`, { limit }, 'READ'), ATTEMPT_KEYS) },
    async pendingRevocations(limit) { return rows(await run(`MATCH (s:UnlinkedProSource) WHERE s.providerRevocation = 'pending' RETURN properties(s) AS value ORDER BY s.updatedAt LIMIT toInteger($limit)`, { limit }, 'READ'), SOURCE_KEYS) },
    async removeSource(owner, expectedGeneration) {
      const result = await run('MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WHERE s.userId = $userId AND s.generation = $expected DETACH DELETE s RETURN count(*) AS removed', { ownerId: owner.ownerId, userId: owner.userId, expected: expectedGeneration })
      return number(result.records[0]?.get('removed')) === 1
    },
    // The write lock is taken before the count is read, so concurrent searches cannot both pass the bound.
    async countSearch(ownerId, day, limit) {
      const result = await run(`MERGE (c:UnlinkedProSearchCount {ownerId: $ownerId}) ON CREATE SET c.day = $day, c.count = 0
        SET c.locked = true WITH c, CASE WHEN c.day = $day THEN c.count ELSE 0 END AS used
        WHERE used < $limit SET c.day = $day, c.count = used + 1, c.locked = null RETURN c.count AS count`, { ownerId, day, limit })
      return result.records.length ? number(result.records[0].get('count')) : null
    },
    async getSource(owner) { return rows(await run('MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WHERE s.userId = $userId RETURN properties(s) AS value LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ'), SOURCE_KEYS)[0] ?? null },
    async findSourceByKeys({ accountKey = null, selfKey = null }) { return rows(await run('MATCH (s:UnlinkedProSource) WHERE ($accountKey IS NOT NULL AND s.accountKey = $accountKey) OR ($selfKey IS NOT NULL AND s.selfKey = $selfKey) RETURN properties(s) AS value LIMIT 5', { accountKey, selfKey }, 'READ'), SOURCE_KEYS) },
    async putSource(record, expectedGeneration) {
      // A compare-and-set miss writes nothing. Generation 0 means "no source
      // yet": it creates the node (a stateless leftover of the same owner is
      // replaced); any other generation must match the stored one exactly.
      const params = { ownerId: record.ownerId, userId: record.userId, expected: expectedGeneration, props: props(record, SOURCE_KEYS) }
      try {
        const result = await run(expectedGeneration === 0
          ? `OPTIONAL MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WITH s WHERE s IS NULL OR (s.state IS NULL AND s.userId = $userId)
            DETACH DELETE s WITH count(*) AS free WHERE free = 1 CREATE (n:UnlinkedProSource) SET n = $props RETURN count(n) AS written`
          : 'MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WHERE s.generation = $expected AND s.userId = $userId SET s = $props RETURN count(s) AS written', params)
        return number(result.records[0]?.get('written')) === 1
      } catch (error) {
        if (error?.code !== 'Neo.ClientError.Schema.ConstraintValidationFailed') throw error
        // A concurrent first write for the same owner lost the race: a compare-and-set miss, not a conflict.
        if (/ownerId/.test(String(error.message)) && !/accountKey|selfKey/.test(String(error.message))) return false
        throw fail('account_in_use')
      }
    },
    async removeOwner(owner) {
      await run(`MATCH (n) WHERE (n:UnlinkedProSource OR n:UnlinkedProAuthAttempt OR n:UnlinkedProSearchCount) AND n.ownerId = $ownerId
        AND NOT (n:UnlinkedProSource AND coalesce(n.providerRevocation, '') = 'pending') AND NOT (n:UnlinkedProAuthAttempt AND coalesce(n.cleanup, '') = 'pending') DETACH DELETE n`, { ownerId: owner.ownerId })
      await run(`MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WHERE s.providerRevocation = 'pending' SET s.ownerDeleted = true`, { ownerId: owner.ownerId })
    },
    async pruneAttempts(before) { await run(`MATCH (a:UnlinkedProAuthAttempt) WHERE coalesce(a.cleanup, '') <> 'pending' AND ((a.state <> 'pending' AND a.createdAt < $before) OR a.expiresAt < $before) DETACH DELETE a`, { before }) },
  }
}

// ---- Service ------------------------------------------------------------

const publicIdentifierOk = value => typeof value === 'string' && /^[A-Za-z0-9\-_%.]{1,200}$/.test(value)
// What a browser may see. Never the provider account id or any key. A record
// without a linked state is shown only while a provider removal is pending.
const sourceView = (source, now) => source && (LINKED_STATES.includes(source.state) || source.providerRevocation === 'pending') ? {
  state: LINKED_STATES.includes(source.state) ? source.state : 'disconnected', name: source.selfName ?? '', ...(publicIdentifierOk(source.selfPublicIdentifier) ? { profileUrl: `https://www.linkedin.com/in/${source.selfPublicIdentifier}` } : {}),
  connectedAt: source.connectedAt ?? null, verifiedAt: source.verifiedAt ?? null, stale: !source.verifiedAt || now - source.verifiedAt > STALE_AFTER_MS,
  ...(source.providerRevocation ? { providerRevocation: source.providerRevocation } : {}),
} : null

export function createProLinkedin({ store, client, access, origin, systemAccountIds = [], searchEnabled = false, searchPerDay = 20, now = Date.now, randomToken = () => randomBytes(32).toString('base64url') }) {
  if (!store || !client || !access) throw new Error('pro_linkedin_configuration_required')
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.pathname !== '/') throw new Error('pro_linkedin_origin_invalid')
  const system = new Set(systemAccountIds)
  if ([...system].some(id => typeof id !== 'string' || !UNIPILE_ACCOUNT_ID.test(id))) throw new Error('pro_linkedin_system_accounts_invalid')
  // Search receipts: in memory, bounded, single use. Losing them on restart only means searching Unlinked again.
  const receipts = new Map()

  const eligible = owner => access.allowed(owner) === true
  const ready = () => client.configured === true
  const requireOwner = owner => { if (!validOwner(owner)) throw fail('owner_required'); if (!eligible(owner)) throw fail('not_eligible'); if (!ready()) throw fail('not_configured') }
  const isSystem = accountId => system.has(accountId)
  const providerCode = error => ['rate_limited', 'reconnect_required', 'not_entitled', 'timeout', 'not_configured'].includes(error?.code) ? error.code : 'provider_unavailable'
  const transient = error => ['timeout', 'provider_unavailable', 'rate_limited', 'aborted'].includes(error?.code)
  const ownerKey = owner => JSON.stringify([owner.ownerId, owner.userId])
  // Made by this attempt: a LinkedIn account created at or after it was issued.
  const createdBy = (account, attempt) => account?.type === 'LINKEDIN' && account.createdAt !== null && account.createdAt >= attempt.createdAt - CREATED_SKEW_MS

  async function status(owner) {
    if (!validOwner(owner) || !eligible(owner)) return { eligible: false }
    const [source, attempt] = await Promise.all([store.getSource(owner), store.latestAttempt(owner)])
    const at = now(), pending = attempt?.state === 'pending' && attempt.expiresAt > at
    // A binding that never finished (for example a crash mid-write) is a failure, not a wait.
    const stuck = attempt?.state === 'binding' && at - (attempt.settledAt ?? attempt.createdAt) > PRO_ATTEMPT_TTL_MS
    return { eligible: true, configured: ready(), searchEnabled: searchEnabled === true, source: sourceView(source, at),
      attempt: attempt ? { state: stuck ? 'failed' : pending || attempt.state === 'binding' ? 'pending' : attempt.state === 'pending' ? 'expired' : attempt.state, kind: attempt.kind, ...(attempt.failure ? { failure: attempt.failure } : {}), createdAt: attempt.createdAt, expiresAt: attempt.expiresAt } : null }
  }

  // Retry a provider-side removal that failed earlier. Never touches a system id.
  // A deleted owner's record goes once its provider session is gone.
  async function revoke(source) {
    if (!source?.accountId || source.providerRevocation !== 'pending') return source
    if (isSystem(source.accountId)) throw fail('protected_account')
    try { await client.deleteAccount(source.accountId) } catch { return source }
    if (source.ownerDeleted) return await store.removeSource(source, source.generation) ? null : await store.getSource(source)
    const next = { ...source, accountId: null, accountKey: null, providerRevocation: null, generation: source.generation + 1, updatedAt: now() }
    return await store.putSource(next, source.generation) ? next : await store.getSource(source)
  }

  // A provider account that a *create* attempt made but did not bind is
  // removed, so a failed link never leaves a live LinkedIn session (or a
  // billable seat) behind. Never on reconnect, never a system id, never an
  // account bound to any owner. What cannot be confirmed or removed now keeps a
  // durable marker (account id server-side only) for sweepPendingRemovals.
  // Returns 'done' | 'skipped' | 'pending'.
  async function discard(attempt, accountId, account = null) {
    if (attempt.kind !== 'create' || typeof accountId !== 'string' || isSystem(accountId)) {
      if (attempt.cleanup === 'pending') await store.markCleanup(attempt.attemptId, { cleanup: 'skipped', cleanupAccountId: null })
      return 'skipped'
    }
    const finish = async (outcome, verified) => {
      if (outcome === 'skipped' && attempt.cleanup !== 'pending') return outcome
      const marked = await store.markCleanup(attempt.attemptId, outcome === 'pending' ? { cleanup: 'pending', cleanupAccountId: accountId } : { cleanup: outcome, cleanupAccountId: null })
      // The attempt went with its deleted owner: keep a pending-removal record instead (verified accounts only).
      if (!marked && outcome === 'pending' && verified) await tombstone(attempt, accountId).catch(() => {})
      return outcome
    }
    try {
      if (!account) {
        if (!ready()) return await finish('pending', false)
        try { account = await client.getAccount(accountId) } catch (error) { return await finish(error?.code === 'not_found' ? 'done' : 'pending', false) }
      }
      if (!createdBy(account, attempt)) return await finish('skipped')
      if ((await store.findSourceByKeys({ accountKey: accountKeyOf(accountId) })).length) return await finish('skipped')
      try { await client.deleteAccount(accountId) } catch { return await finish('pending', true) }
      return await finish('done')
    } catch { return 'pending' }
  }
  async function tombstone(attempt, accountId) {
    const owner = { ownerId: attempt.ownerId, userId: attempt.userId }
    if (await store.getSource(owner)) return
    await store.putSource({ ...owner, role: 'personal', state: 'disconnected', generation: 1, accountId, updatedAt: now(), providerRevocation: 'pending', ownerDeleted: true }, 0)
  }

  async function begin(owner, { reconnect = false } = {}) {
    requireOwner(owner)
    let source = await store.getSource(owner)
    if (source?.providerRevocation === 'pending') { source = await revoke(source); if (source?.providerRevocation === 'pending') throw fail('revocation_pending') }
    const linked = source && LINKED_STATES.includes(source.state) && source.accountId
    if (reconnect && !linked) throw fail('not_connected')
    if (!reconnect && linked) throw fail('already_connected')
    if (linked && isSystem(source.accountId)) throw fail('protected_account')
    const at = now(), token = randomToken(), attemptId = randomBytes(18).toString('base64url')
    const attempt = { attemptId, tokenHash: proTokenHash(token), ownerId: owner.ownerId, userId: owner.userId, kind: reconnect ? 'reconnect' : 'create', generation: source?.generation ?? 0, state: 'pending', createdAt: at, expiresAt: at + PRO_ATTEMPT_TTL_MS }
    await store.pruneAttempts(at - PRUNE_AFTER_MS)
    await store.createAttempt(attempt)
    try {
      const link = await client.createHostedAuthLink({ kind: attempt.kind, name: attemptId, notifyUrl: new URL(`/api/pro/linkedin/notify/${token}`, base).href,
        successUrl: new URL('/pro?linkedin=returned', base).href, failureUrl: new URL('/pro?linkedin=cancelled', base).href, expiresOn: new Date(attempt.expiresAt).toISOString(), ...(reconnect ? { reconnectAccountId: source.accountId } : {}) })
      return { url: link.url, expiresAt: attempt.expiresAt }
    } catch (error) {
      await store.settleAttempt(attemptId, { state: 'failed', failure: providerCode(error), settledAt: now() })
      throw fail(providerCode(error), error?.retryAfter ? { retryAfter: error.retryAfter } : {})
    }
  }

  // Disconnect or account deletion ran while this callback was binding, so it
  // wins: the source just written is closed and its provider session removed
  // through the ordinary revocation path.
  async function undo(attempt, record) {
    const owner = { ownerId: record.ownerId, userId: record.userId }, current = await store.getSource(owner)
    // Already moved on (a disconnect saw the new source and removed it itself).
    if (current?.generation !== record.generation || current.accountId !== record.accountId) return
    const deleted = !await store.attemptByTokenHash(attempt.tokenHash)
    const next = { ...current, state: 'disconnected', generation: current.generation + 1, updatedAt: now(), providerRevocation: 'pending', ...(deleted ? { ownerDeleted: true } : {}) }
    if (await store.putSource(next, current.generation) && ready()) await revoke(next)
  }

  // The provider's server-to-server callback. The unguessable one-time path
  // token is the correlation; the payload is untrusted until the provider's
  // own API confirms the account and the identity that signed in.
  // Returns 'unknown' (no such live attempt) or 'accepted' (handled; the
  // outcome is recorded on the attempt, never echoed to the caller).
  async function notify(token, payload) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return 'unknown'
    const hash = proTokenHash(token), attempt = await store.attemptByTokenHash(hash)
    if (!attempt || !timingSafeEqual(Buffer.from(attempt.tokenHash), Buffer.from(hash))) return 'unknown'
    const settle = (state, failure) => store.settleAttempt(attempt.attemptId, { state, ...(failure ? { failure } : {}), settledAt: now() })
    const owner = { ownerId: attempt.ownerId, userId: attempt.userId }
    const expected = attempt.kind === 'reconnect' ? 'RECONNECTED' : 'CREATION_SUCCESS'
    const valid = payload && typeof payload === 'object' && !Array.isArray(payload) && payload.name === attempt.attemptId && payload.status === expected && typeof payload.account_id === 'string' && UNIPILE_ACCOUNT_ID.test(payload.account_id)
    const late = attempt.state === 'pending' && attempt.expiresAt <= now()
    if (late) await settle('expired')
    if (attempt.state !== 'pending' || late) {
      // A sign-in finished on a link that was replaced or expired: nothing will bind it, so the account it made is removed.
      if (valid && (late || ['superseded', 'expired'].includes(attempt.state)) && !attempt.cleanup) await discard(attempt, payload.account_id)
      return 'unknown'
    }
    if (!valid) return 'unknown'
    const accountId = payload.account_id
    // Each failure is recorded once; only the delivery that recorded it cleans up what the attempt created.
    const reject = async (failure, account) => { if (await settle('failed', failure)) await discard(attempt, accountId, account); return 'accepted' }
    if (!eligible(owner) || !ready()) return reject('not_eligible')
    if (isSystem(accountId)) { await settle('failed', 'protected_account'); return 'accepted' }
    const source = await store.getSource(owner)
    if ((source?.generation ?? 0) !== attempt.generation) return reject('superseded')
    if (attempt.kind === 'reconnect' && source?.accountId !== accountId) { await settle('failed', 'account_mismatch'); return 'accepted' }
    let account, self
    // A transient provider failure leaves the attempt pending: the provider retries its callback.
    try { account = await client.getAccount(accountId) } catch (error) { if (transient(error)) throw fail('verification_unavailable'); if (error?.code === 'not_found') { await settle('failed', 'verification_failed'); return 'accepted' } return reject('verification_failed') }
    if (account.type !== 'LINKEDIN' || !account.statuses.length || account.statuses.some(value => value !== 'OK')) return reject('account_not_ready', account)
    // A new link must be an account created by this attempt, not one that already existed in the workspace.
    if (attempt.kind === 'create' && !createdBy(account, attempt)) { await settle('failed', 'account_not_new'); return 'accepted' }
    try { self = await client.getOwnProfile(accountId) } catch (error) { if (transient(error)) throw fail('verification_unavailable'); return reject('verification_failed', account) }
    const accountKey = accountKeyOf(accountId), selfKey = selfKeyOf(self.providerId)
    if (attempt.kind === 'reconnect' && source.selfKey !== selfKey) {
      // The provider session now belongs to a different LinkedIn identity: it
      // must not be used (checked or searched) until the owner reconnects as themselves.
      if (await settle('failed', 'identity_mismatch')) await store.putSource({ ...source, state: 'reconnect_required', generation: source.generation + 1, updatedAt: now() }, source.generation)
      return 'accepted'
    }
    if ((await store.findSourceByKeys({ accountKey, selfKey })).some(other => other.ownerId !== owner.ownerId)) return reject('account_in_use', account)
    // Single use: the first verified delivery wins; a replay finds no pending attempt.
    if (!await settle('binding')) {
      // Superseded (or the owner deleted) while verifying: nothing will bind this account.
      const current = await store.attemptByTokenHash(hash)
      if (!current || ['superseded', 'expired'].includes(current.state)) await discard(attempt, accountId, account)
      return 'unknown'
    }
    const at = now()
    const record = { ownerId: owner.ownerId, userId: owner.userId, role: 'personal', state: 'connected', generation: attempt.generation + 1, accountId, accountKey, selfKey, selfName: self.name, selfPublicIdentifier: self.publicIdentifier ?? null,
      connectedAt: attempt.kind === 'reconnect' ? source.connectedAt ?? at : at, verifiedAt: at, updatedAt: at, consentVersion: PRO_CONSENT_VERSION, providerRevocation: null }
    let outcome = 'superseded', written = false
    try { written = await store.putSource(record, attempt.generation); if (written) outcome = null } catch (error) {
      if (error?.code !== 'account_in_use') { await store.settleAttempt(attempt.attemptId, { state: 'failed', failure: 'store_unavailable', settledAt: now() }, 'binding').catch(() => {}); await discard(attempt, accountId, account); throw error }
      outcome = 'account_in_use'
    }
    // The attempt must still be binding when it settles: a disconnect or an
    // account deletion that ran meanwhile has superseded (or removed) it.
    const settled = await store.settleAttempt(attempt.attemptId, outcome ? { state: 'failed', failure: outcome, settledAt: now() } : { state: 'verified', settledAt: now() }, 'binding')
    if (written && !settled) await undo(attempt, record)
    else if (!written) await discard(attempt, accountId, account)
    return 'accepted'
  }

  // An explicit "check now": reads the provider's account status and the
  // LinkedIn identity signed in on the owner's own bound account. Not a sync.
  async function check(owner) {
    requireOwner(owner)
    const source = await store.getSource(owner)
    if (!source?.accountId || !LINKED_STATES.includes(source.state)) throw fail('not_connected')
    if (isSystem(source.accountId)) throw fail('protected_account')
    let state
    try {
      const account = await client.getAccount(source.accountId)
      state = account.statuses.length && account.statuses.every(value => value === 'OK') ? 'connected' : account.statuses.includes('STOPPED') ? 'paused' : 'reconnect_required'
      // A healthy session is not enough: it must still be the identity that was bound.
      if (state === 'connected' && selfKeyOf((await client.getOwnProfile(source.accountId)).providerId) !== source.selfKey) state = 'reconnect_required'
    } catch (error) {
      if (!['reconnect_required', 'not_found'].includes(error?.code)) throw fail(providerCode(error), error?.retryAfter ? { retryAfter: error.retryAfter } : {})
      state = 'reconnect_required'
    }
    const at = now(), next = { ...source, state, updatedAt: at, ...(state === 'connected' ? { verifiedAt: at } : {}), generation: source.generation + (state === source.state ? 0 : 1) }
    if (!await store.putSource(next, source.generation)) throw fail('superseded')
    return sourceView(next, at)
  }

  // Disconnect wins over anything in flight: the generation moves first, then
  // the provider session is removed. A failed removal is kept visible.
  async function disconnect(owner, { deleting = false } = {}) {
    if (!validOwner(owner)) throw fail('owner_required')
    const source = await store.getSource(owner), at = now()
    await store.supersedeAttempts(owner, at)
    if (!source) return { removedAtProvider: false }
    if (source.accountId && isSystem(source.accountId)) throw fail('protected_account')
    const next = { ...source, state: 'disconnected', generation: source.generation + 1, updatedAt: at, providerRevocation: source.accountId ? 'pending' : null, ...(deleting ? { ownerDeleted: true } : {}) }
    if (!await store.putSource(next, source.generation)) throw fail('superseded')
    const after = next.accountId && ready() ? await revoke(next) : next
    return { removedAtProvider: Boolean(source.accountId) && !after?.providerRevocation, pending: after?.providerRevocation === 'pending' }
  }

  // Account deletion: this owner's personal source, attempts and search count
  // only. Everything else of the owner's Pro records goes even if the
  // disconnect fails; a provider removal that did not finish keeps only its
  // own record for sweepPendingRemovals. The failure is rethrown for the caller to record.
  async function removeOwner(owner) {
    if (!validOwner(owner)) return
    let result, failure
    for (let tries = 0; tries < 3 && !result; tries++) {
      try { result = await disconnect(owner, { deleting: true }) } catch (error) { failure = error; if (error?.code !== 'superseded') break }
    }
    await store.removeOwner(owner)
    for (const [token, receipt] of receipts) if (receipt.owner === ownerKey(owner)) receipts.delete(token)
    if (!result) throw failure
    return result
  }

  // Operator action, never scheduled: retry provider removals that did not
  // finish (disconnects, deleted owners) and cleanups of accounts that failed
  // attempts created. Each account is re-checked before anything is removed.
  async function sweepPendingRemovals({ limit = 50 } = {}) {
    if (!ready()) throw fail('not_configured')
    const result = { revoked: 0, cleaned: 0, skipped: 0, pending: 0 }
    for (const source of await store.pendingRevocations(limit)) {
      if (isSystem(source.accountId)) { result.skipped++; continue }
      const after = await revoke(source).catch(() => source)
      result[after?.providerRevocation === 'pending' ? 'pending' : 'revoked']++
    }
    for (const attempt of await store.pendingCleanups(limit)) {
      const outcome = await discard(attempt, attempt.cleanupAccountId)
      result[outcome === 'done' ? 'cleaned' : outcome]++
    }
    await store.pruneAttempts(now() - PRUNE_AFTER_MS)
    return result
  }

  // Issued only by the People page when this owner's own Unlinked search for
  // these words finished and found no one: single use, bound to owner + query.
  function searchReceipt(owner, query) {
    if (!validOwner(owner) || !eligible(owner) || searchEnabled !== true || typeof query !== 'string' || !query.trim() || query.length > 200) return null
    const at = now()
    for (const [token, receipt] of receipts) if (receipt.expiresAt <= at) receipts.delete(token)
    while (receipts.size >= RECEIPT_LIMIT) receipts.delete(receipts.keys().next().value)
    const token = randomBytes(24).toString('base64url')
    receipts.set(token, { owner: ownerKey(owner), query: normalQuery(query), expiresAt: at + PRO_SEARCH_RECEIPT_TTL_MS })
    return token
  }
  const redeem = (owner, query, token) => {
    const receipt = typeof token === 'string' ? receipts.get(token) : undefined
    if (!receipt || receipt.owner !== ownerKey(owner) || receipt.query !== normalQuery(query) || receipt.expiresAt <= now()) return false
    receipts.delete(token)
    return true
  }

  // Explicit LinkedIn people search on the owner's own session, only with a
  // receipt from a finished local no-match for the same words.
  async function search(owner, query, { signal, receipt } = {}) {
    requireOwner(owner)
    if (searchEnabled !== true) throw fail('search_not_enabled')
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw fail('invalid_query')
    const source = await store.getSource(owner)
    if (!source?.accountId || !LINKED_STATES.includes(source.state)) throw fail('not_connected')
    if (source.state !== 'connected') throw fail(source.state === 'paused' ? 'paused' : 'reconnect_required')
    if (source.role !== 'personal' || isSystem(source.accountId)) throw fail('protected_account')
    if (!redeem(owner, query, receipt)) throw fail('local_search_required')
    const at = now(), day = Math.floor(at / 86400000)
    // Counted durably before the call: an uncertain outcome is never retried for free.
    const count = await store.countSearch(owner.ownerId, day, searchPerDay)
    if (count === null) throw fail('daily_limit', { retryAfter: Math.ceil(((day + 1) * 86400000 - at) / 1000) })
    let result
    try { result = await client.searchPeople(source.accountId, { keywords: query, signal }) }
    catch (error) {
      const code = providerCode(error)
      if (code === 'reconnect_required') { const current = await store.getSource(owner); if (current?.generation === source.generation) await store.putSource({ ...current, state: 'reconnect_required', generation: current.generation + 1, updatedAt: now() }, current.generation) }
      throw fail(code, error?.retryAfter ? { retryAfter: error.retryAfter } : {})
    }
    // The owner may have disconnected while the provider answered.
    const current = await store.getSource(owner)
    if (current?.generation !== source.generation || current.state !== 'connected') throw fail('superseded')
    return { observedAt: now(), account: { name: source.selfName ?? '' }, remainingToday: Math.max(0, searchPerDay - count), ...(result.total !== undefined ? { total: result.total } : {}), skipped: result.skipped,
      people: result.people.map(person => ({ ...person, linkedinUrl: `https://www.linkedin.com/in/${person.publicIdentifier}`, source: 'linkedin_search' })) }
  }

  return { eligible, status, begin, notify, check, disconnect: owner => disconnect(owner), removeOwner, search, searchReceipt, sweepPendingRemovals }
}

// Account-deletion cleanup and the operator sweep, composed whenever a Pro
// store exists, including with the feature switched off (no route, no begin).
export function createProLinkedinCleanup({ store, client, systemAccountIds = [], now }) {
  const pro = createProLinkedin({ store, client, access: createProAccess(), origin: 'https://cleanup.invalid', systemAccountIds, ...(now ? { now } : {}) })
  return { removeOwner: pro.removeOwner, sweepPendingRemovals: pro.sweepPendingRemovals }
}

export { SOURCE_STATES }
