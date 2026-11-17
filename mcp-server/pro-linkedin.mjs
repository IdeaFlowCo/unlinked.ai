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
export const PRO_CONSENT_VERSION = 'pro-linkedin-source-v1'
const CREATED_SKEW_MS = 2 * 60 * 1000
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

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

// ---- Stores -------------------------------------------------------------

export function createMemoryProLinkedinStore() {
  const sources = new Map(), attempts = new Map()
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
    async getSource(owner) { const source = sources.get(owner.ownerId); return source && source.userId === owner.userId ? { ...source } : null },
    async findSourceByKeys({ accountKey, selfKey }) { return [...sources.values()].filter(source => accountKey && source.accountKey === accountKey || selfKey && source.selfKey === selfKey).map(source => ({ ...source })) },
    // Compare-and-set on generation; provider account and LinkedIn identity
    // are each bound to at most one owner.
    async putSource(record, expectedGeneration) {
      const current = sources.get(record.ownerId)
      if ((current?.generation ?? 0) !== expectedGeneration || current && current.userId !== record.userId) return false
      for (const other of sources.values()) if (other.ownerId !== record.ownerId && (record.accountKey && other.accountKey === record.accountKey || record.selfKey && other.selfKey === record.selfKey)) throw fail('account_in_use')
      sources.set(record.ownerId, { ...record })
      return true
    },
    async removeOwner(owner) { sources.delete(owner.ownerId); for (const [id, attempt] of attempts) if (attempt.ownerId === owner.ownerId) attempts.delete(id) },
    async pruneAttempts(before) { for (const [id, attempt] of attempts) if (attempt.state !== 'pending' && attempt.createdAt < before || attempt.expiresAt < before) attempts.delete(id) },
  }
}

const SOURCE_KEYS = ['ownerId', 'userId', 'role', 'state', 'generation', 'accountId', 'accountKey', 'selfKey', 'selfName', 'selfPublicIdentifier', 'connectedAt', 'verifiedAt', 'updatedAt', 'consentVersion', 'providerRevocation']
const ATTEMPT_KEYS = ['attemptId', 'tokenHash', 'ownerId', 'userId', 'kind', 'generation', 'state', 'failure', 'createdAt', 'expiresAt', 'settledAt']
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const plainRecord = (value, keys) => value ? Object.fromEntries(keys.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, number(value[key])])) : null
const props = (record, keys) => Object.fromEntries(keys.map(key => [key, record[key] ?? null]))

// Graph labels UnlinkedProSource / UnlinkedProAuthAttempt (in the recovery
// domain: deploy/private-pilot/graph-migration.mjs). All values are parameters.
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
    async getSource(owner) { return rows(await run('MATCH (s:UnlinkedProSource {ownerId: $ownerId}) WHERE s.userId = $userId RETURN properties(s) AS value LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ'), SOURCE_KEYS)[0] ?? null },
    async findSourceByKeys({ accountKey = null, selfKey = null }) { return rows(await run('MATCH (s:UnlinkedProSource) WHERE ($accountKey IS NOT NULL AND s.accountKey = $accountKey) OR ($selfKey IS NOT NULL AND s.selfKey = $selfKey) RETURN properties(s) AS value LIMIT 5', { accountKey, selfKey }, 'READ'), SOURCE_KEYS) },
    async putSource(record, expectedGeneration) {
      try {
        const result = await run(`MERGE (s:UnlinkedProSource {ownerId: $ownerId}) ON CREATE SET s.generation = 0, s.userId = $userId
          WITH s WHERE s.generation = $expected AND s.userId = $userId SET s = $props RETURN count(s) AS written`, { ownerId: record.ownerId, userId: record.userId, expected: expectedGeneration, props: props(record, SOURCE_KEYS) })
        return number(result.records[0]?.get('written')) === 1
      } catch (error) {
        if (error?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') throw fail('account_in_use')
        throw error
      }
    },
    async removeOwner(owner) { await run('MATCH (n) WHERE (n:UnlinkedProSource OR n:UnlinkedProAuthAttempt) AND n.ownerId = $ownerId DETACH DELETE n', { ownerId: owner.ownerId }) },
    async pruneAttempts(before) { await run(`MATCH (a:UnlinkedProAuthAttempt) WHERE (a.state <> 'pending' AND a.createdAt < $before) OR a.expiresAt < $before DETACH DELETE a`, { before }) },
  }
}

// ---- Service ------------------------------------------------------------

const publicIdentifierOk = value => typeof value === 'string' && /^[A-Za-z0-9\-_%.]{1,200}$/.test(value)
// What a browser may see. Never the provider account id or any key.
const sourceView = (source, now) => source && source.state !== 'disconnected' || source?.providerRevocation === 'pending' ? {
  state: source.state, name: source.selfName ?? '', ...(publicIdentifierOk(source.selfPublicIdentifier) ? { profileUrl: `https://www.linkedin.com/in/${source.selfPublicIdentifier}` } : {}),
  connectedAt: source.connectedAt ?? null, verifiedAt: source.verifiedAt ?? null, stale: !source.verifiedAt || now - source.verifiedAt > STALE_AFTER_MS,
  ...(source.providerRevocation ? { providerRevocation: source.providerRevocation } : {}),
} : null

export function createProLinkedin({ store, client, access, origin, systemAccountIds = [], searchEnabled = false, searchPerDay = 20, now = Date.now, randomToken = () => randomBytes(32).toString('base64url') }) {
  if (!store || !client || !access) throw new Error('pro_linkedin_configuration_required')
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.pathname !== '/') throw new Error('pro_linkedin_origin_invalid')
  const system = new Set(systemAccountIds)
  if ([...system].some(id => typeof id !== 'string' || !UNIPILE_ACCOUNT_ID.test(id))) throw new Error('pro_linkedin_system_accounts_invalid')
  const searches = new Map()

  const eligible = owner => access.allowed(owner) === true
  const ready = () => client.configured === true
  const requireOwner = owner => { if (!validOwner(owner)) throw fail('owner_required'); if (!eligible(owner)) throw fail('not_eligible'); if (!ready()) throw fail('not_configured') }
  const isSystem = accountId => system.has(accountId)
  const providerCode = error => ['rate_limited', 'reconnect_required', 'not_entitled', 'timeout', 'not_configured'].includes(error?.code) ? error.code : 'provider_unavailable'

  async function status(owner) {
    if (!validOwner(owner) || !eligible(owner)) return { eligible: false }
    const [source, attempt] = await Promise.all([store.getSource(owner), store.latestAttempt(owner)])
    const at = now(), pending = attempt?.state === 'pending' && attempt.expiresAt > at
    return { eligible: true, configured: ready(), searchEnabled: searchEnabled === true, source: sourceView(source, at),
      attempt: attempt ? { state: pending || attempt.state === 'binding' ? 'pending' : attempt.state === 'pending' ? 'expired' : attempt.state, kind: attempt.kind, ...(attempt.failure ? { failure: attempt.failure } : {}), createdAt: attempt.createdAt, expiresAt: attempt.expiresAt } : null }
  }

  // Retry a provider-side removal that failed earlier. Never touches a system id.
  async function revoke(source) {
    if (!source?.accountId || source.providerRevocation !== 'pending') return source
    if (isSystem(source.accountId)) throw fail('protected_account')
    try { await client.deleteAccount(source.accountId) } catch { return source }
    const next = { ...source, accountId: null, accountKey: null, providerRevocation: null, generation: source.generation + 1, updatedAt: now() }
    return await store.putSource(next, source.generation) ? next : await store.getSource(source)
  }

  async function begin(owner, { reconnect = false } = {}) {
    requireOwner(owner)
    let source = await store.getSource(owner)
    if (source?.providerRevocation === 'pending') { source = await revoke(source); if (source?.providerRevocation === 'pending') throw fail('revocation_pending') }
    const linked = source && source.state !== 'disconnected' && source.accountId
    if (reconnect && !linked) throw fail('not_connected')
    if (!reconnect && linked) throw fail('already_connected')
    if (linked && isSystem(source.accountId)) throw fail('protected_account')
    const at = now(), token = randomToken(), attemptId = randomBytes(18).toString('base64url')
    const attempt = { attemptId, tokenHash: proTokenHash(token), ownerId: owner.ownerId, userId: owner.userId, kind: reconnect ? 'reconnect' : 'create', generation: source?.generation ?? 0, state: 'pending', createdAt: at, expiresAt: at + PRO_ATTEMPT_TTL_MS }
    await store.pruneAttempts(at - 7 * 24 * 60 * 60 * 1000)
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

  // The provider's server-to-server callback. The unguessable one-time path
  // token is the correlation; the payload is untrusted until the provider's
  // own API confirms the account and the identity that signed in.
  // Returns 'unknown' (no such live attempt) or 'accepted' (handled; the
  // outcome is recorded on the attempt, never echoed to the caller).
  async function notify(token, payload) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return 'unknown'
    const hash = proTokenHash(token), attempt = await store.attemptByTokenHash(hash)
    if (!attempt || !timingSafeEqual(Buffer.from(attempt.tokenHash), Buffer.from(hash)) || attempt.state !== 'pending') return 'unknown'
    const settle = (state, failure) => store.settleAttempt(attempt.attemptId, { state, ...(failure ? { failure } : {}), settledAt: now() })
    if (attempt.expiresAt <= now()) { await settle('expired'); return 'unknown' }
    const owner = { ownerId: attempt.ownerId, userId: attempt.userId }
    const expected = attempt.kind === 'reconnect' ? 'RECONNECTED' : 'CREATION_SUCCESS'
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.name !== attempt.attemptId || payload.status !== expected || typeof payload.account_id !== 'string' || !UNIPILE_ACCOUNT_ID.test(payload.account_id)) return 'unknown'
    const accountId = payload.account_id
    if (!eligible(owner) || !ready()) { await settle('failed', 'not_eligible'); return 'accepted' }
    if (isSystem(accountId)) { await settle('failed', 'protected_account'); return 'accepted' }
    const source = await store.getSource(owner)
    if ((source?.generation ?? 0) !== attempt.generation) { await settle('failed', 'superseded'); return 'accepted' }
    if (attempt.kind === 'reconnect' && source?.accountId !== accountId) { await settle('failed', 'account_mismatch'); return 'accepted' }
    let account, self
    try { account = await client.getAccount(accountId); self = await client.getOwnProfile(accountId) }
    // A transient provider failure leaves the attempt pending: the provider retries its callback.
    catch (error) { if (['timeout', 'provider_unavailable', 'rate_limited', 'aborted'].includes(error?.code)) throw fail('verification_unavailable'); await settle('failed', 'verification_failed'); return 'accepted' }
    if (account.type !== 'LINKEDIN' || !account.statuses.length || account.statuses.some(value => value !== 'OK')) { await settle('failed', 'account_not_ready'); return 'accepted' }
    // A new link must be an account created by this attempt, not one that already existed in the workspace.
    if (attempt.kind === 'create' && (account.createdAt === null || account.createdAt < attempt.createdAt - CREATED_SKEW_MS)) { await settle('failed', 'account_not_new'); return 'accepted' }
    const accountKey = accountKeyOf(accountId), selfKey = selfKeyOf(self.providerId)
    if (attempt.kind === 'reconnect' && source.selfKey !== selfKey) { await settle('failed', 'identity_mismatch'); return 'accepted' }
    if ((await store.findSourceByKeys({ accountKey, selfKey })).some(other => other.ownerId !== owner.ownerId)) { await settle('failed', 'account_in_use'); return 'accepted' }
    // Single use: the first verified delivery wins; a replay finds no pending attempt.
    if (!await settle('binding')) return 'unknown'
    const at = now()
    const record = { ownerId: owner.ownerId, userId: owner.userId, role: 'personal', state: 'connected', generation: attempt.generation + 1, accountId, accountKey, selfKey, selfName: self.name, selfPublicIdentifier: self.publicIdentifier ?? null,
      connectedAt: attempt.kind === 'reconnect' ? source.connectedAt ?? at : at, verifiedAt: at, updatedAt: at, consentVersion: PRO_CONSENT_VERSION, providerRevocation: null }
    let outcome = 'superseded'
    try { if (await store.putSource(record, attempt.generation)) outcome = null } catch (error) { if (error?.code !== 'account_in_use') { await store.settleAttempt(attempt.attemptId, { state: 'failed', failure: 'store_unavailable', settledAt: now() }, 'binding'); throw error } outcome = 'account_in_use' }
    await store.settleAttempt(attempt.attemptId, outcome ? { state: 'failed', failure: outcome, settledAt: now() } : { state: 'verified', settledAt: now() }, 'binding')
    return 'accepted'
  }

  // An explicit "check now": reads the provider's account status for the
  // owner's own bound account. Not a sync.
  async function check(owner) {
    requireOwner(owner)
    const source = await store.getSource(owner)
    if (!source?.accountId || source.state === 'disconnected') throw fail('not_connected')
    if (isSystem(source.accountId)) throw fail('protected_account')
    let state
    try {
      const account = await client.getAccount(source.accountId)
      state = account.statuses.length && account.statuses.every(value => value === 'OK') ? 'connected' : account.statuses.includes('STOPPED') ? 'paused' : 'reconnect_required'
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
  async function disconnect(owner) {
    if (!validOwner(owner)) throw fail('owner_required')
    const source = await store.getSource(owner), at = now()
    await store.supersedeAttempts(owner, at)
    if (!source) return { removedAtProvider: false }
    if (source.accountId && isSystem(source.accountId)) throw fail('protected_account')
    const next = { ...source, state: 'disconnected', generation: source.generation + 1, updatedAt: at, providerRevocation: source.accountId ? 'pending' : null }
    if (!await store.putSource(next, source.generation)) throw fail('superseded')
    const after = next.accountId && ready() ? await revoke(next) : next
    return { removedAtProvider: Boolean(source.accountId) && !after?.providerRevocation, pending: after?.providerRevocation === 'pending' }
  }

  // Account deletion: this owner's personal source and attempts only.
  async function removeOwner(owner) {
    if (!validOwner(owner)) return
    const result = await disconnect(owner)
    // Keep the record while the provider session could not be removed, so an
    // operator can finish the removal; it holds no searchable data.
    if (!result.pending) await store.removeOwner(owner)
    searches.delete(owner.ownerId)
    return result
  }

  // Explicit LinkedIn people search on the owner's own session. The caller
  // (browser) offers it only after a successful local no-match.
  async function search(owner, query, { signal } = {}) {
    requireOwner(owner)
    if (searchEnabled !== true) throw fail('search_not_enabled')
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw fail('invalid_query')
    const source = await store.getSource(owner)
    if (!source?.accountId || source.state === 'disconnected') throw fail('not_connected')
    if (source.state !== 'connected') throw fail(source.state === 'paused' ? 'paused' : 'reconnect_required')
    if (source.role !== 'personal' || isSystem(source.accountId)) throw fail('protected_account')
    const at = now(), day = Math.floor(at / 86400000), used = searches.get(owner.ownerId)
    const count = used?.day === day ? used.count : 0
    if (count >= searchPerDay) throw fail('daily_limit', { retryAfter: Math.ceil(((day + 1) * 86400000 - at) / 1000) })
    // Counted before the call: an uncertain outcome is never retried for free.
    searches.set(owner.ownerId, { day, count: count + 1 })
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
    return { observedAt: now(), account: { name: source.selfName ?? '' }, remainingToday: searchPerDay - count - 1, ...(result.total !== undefined ? { total: result.total } : {}), skipped: result.skipped,
      people: result.people.map(person => ({ ...person, linkedinUrl: `https://www.linkedin.com/in/${person.publicIdentifier}`, source: 'linkedin_search' })) }
  }

  return { eligible, status, begin, notify, check, disconnect, removeOwner, search }
}

export { SOURCE_STATES }
