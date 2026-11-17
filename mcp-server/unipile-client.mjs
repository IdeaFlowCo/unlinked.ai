// Minimal Unipile v1 client for the owner-only Pro LinkedIn source
// (docs/pro-linkedin.md). It is a transport only: which account a call may use
// is decided by mcp-server/pro-linkedin.mjs from the durable owner binding,
// never by a browser parameter and never by a "default account" here.
//
// Contract v1 (developer.unipile.com, checked 2026-11-16): X-API-KEY header,
// POST /api/v1/hosted/accounts/link, GET /api/v1/accounts/{id},
// GET /api/v1/users/me?account_id=, DELETE /api/v1/accounts/{id},
// POST /api/v1/linkedin/search?account_id=. No silent migration to v2.
//
// The API key, provider response bodies and account ids never enter an error
// message, a log line or a return value meant for a browser.

export class UnipileError extends Error {
  constructor(code, { retryAfter, status } = {}) {
    super(`unipile_${code}`)
    this.name = 'UnipileError'
    this.code = code
    if (Number.isSafeInteger(retryAfter) && retryAfter > 0) this.retryAfter = Math.min(retryAfter, 86400)
    if (Number.isSafeInteger(status)) this.status = status
  }
}

export const UNIPILE_DSN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.unipile\.com(?::[1-9]\d{1,4})?$/
export const UNIPILE_ACCOUNT_ID = /^[A-Za-z0-9_-]{6,80}$/

// Provider error types that mean "this LinkedIn session must be re-authenticated
// by its owner", as opposed to a workspace credential or entitlement problem.
const RECONNECT_TYPES = new Set(['errors/disconnected_account', 'errors/expired_credentials', 'errors/invalid_credentials', 'errors/checkpoint_error', 'errors/multiple_sessions', 'errors/wrong_account', 'errors/password_reset_required', 'errors/account_restricted', 'errors/action_required', 'errors/session_mismatch', 'errors/account_mismatch', 'errors/no_client_session'])
const NOT_ENTITLED_TYPES = new Set(['errors/feature_not_subscribed', 'errors/subscription_required', 'errors/insufficient_privileges', 'errors/disconnected_feature'])

const text = (value, max = 500) => typeof value === 'string' && value.length <= max ? value : undefined

function failure(status, body) {
  const type = text(body?.type, 100)
  if (status === 429) return new UnipileError('rate_limited', { status, retryAfter: Number(body?.retry_after) })
  if (type && RECONNECT_TYPES.has(type)) return new UnipileError('reconnect_required', { status })
  if (type && NOT_ENTITLED_TYPES.has(type)) return new UnipileError('not_entitled', { status })
  if (status === 401 || status === 403) return new UnipileError('provider_unauthorized', { status })
  if (status === 404) return new UnipileError('not_found', { status })
  if (status === 504) return new UnipileError('timeout', { status })
  if (status >= 500) return new UnipileError('provider_unavailable', { status })
  return new UnipileError('provider_rejected', { status })
}

export function createUnipileClient({ dsn, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const configured = typeof dsn === 'string' && UNIPILE_DSN.test(dsn) && typeof apiKey === 'string' && apiKey.length >= 16 && apiKey.length <= 512 && !/\s/.test(apiKey)
  const base = configured ? `https://${dsn}` : null

  async function call(method, path, { query, body, signal } = {}) {
    if (!configured) throw new UnipileError('not_configured')
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    const timeout = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'X-API-KEY': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch {
      if (signal?.aborted) throw new UnipileError('aborted')
      throw new UnipileError(timeout.aborted ? 'timeout' : 'provider_unavailable')
    }
    let parsed = null
    try { const raw = await response.text(); if (raw.length > 2_000_000) throw new Error('large'); parsed = raw ? JSON.parse(raw) : null } catch { if (response.ok) throw new UnipileError('invalid_response', { status: response.status }) }
    if (!response.ok) throw failure(response.status, parsed)
    return parsed
  }
  const accountId = id => { if (typeof id !== 'string' || !UNIPILE_ACCOUNT_ID.test(id)) throw new UnipileError('invalid_account'); return id }

  return {
    configured,
    // A one-time hosted page where the owner signs in to LinkedIn. `name` is
    // our opaque attempt id, echoed to notifyUrl; it is not an internal user id.
    async createHostedAuthLink({ kind, name, notifyUrl, successUrl, failureUrl, expiresOn, reconnectAccountId, signal }) {
      if (!['create', 'reconnect'].includes(kind)) throw new UnipileError('invalid_request')
      const result = await call('POST', '/api/v1/hosted/accounts/link', { signal, body: {
        type: kind, providers: ['LINKEDIN'], api_url: base, expiresOn, notify_url: notifyUrl, name,
        success_redirect_url: successUrl, failure_redirect_url: failureUrl, ...(kind === 'reconnect' ? { reconnect_account: accountId(reconnectAccountId) } : {}) } })
      let link
      try { link = new URL(result?.url) } catch { throw new UnipileError('invalid_response') }
      if (result?.object !== 'HostedAuthURL' || link.protocol !== 'https:' || !/(?:^|\.)unipile\.com$/.test(link.hostname)) throw new UnipileError('invalid_response')
      return { url: link.href }
    },
    async getAccount(id, { signal } = {}) {
      const value = await call('GET', `/api/v1/accounts/${encodeURIComponent(accountId(id))}`, { signal })
      if (value?.object !== 'Account' || value.id !== id) throw new UnipileError('invalid_response')
      const statuses = Array.isArray(value.sources) ? value.sources.map(source => text(source?.status, 40)).filter(Boolean) : []
      const createdAt = Date.parse(value.created_at)
      return { id: value.id, type: text(value.type, 40) ?? null, createdAt: Number.isFinite(createdAt) ? createdAt : null, statuses }
    },
    // The LinkedIn identity that actually signed in on this account.
    async getOwnProfile(id, { signal } = {}) {
      const value = await call('GET', '/api/v1/users/me', { signal, query: { account_id: accountId(id) } })
      if (value?.object !== 'AccountOwnerProfile' || value.provider !== 'LINKEDIN' || !text(value.provider_id, 200)) throw new UnipileError('invalid_response')
      const publicIdentifier = text(value.public_identifier, 200)
      return { providerId: value.provider_id, name: [text(value.first_name, 200), text(value.last_name, 200)].filter(Boolean).join(' ').trim(), ...(publicIdentifier && /^[A-Za-z0-9\-_%.]{1,200}$/.test(publicIdentifier) ? { publicIdentifier } : {}) }
    },
    async deleteAccount(id, { signal } = {}) {
      try { await call('DELETE', `/api/v1/accounts/${encodeURIComponent(accountId(id))}`, { signal }) } catch (error) { if (error?.code !== 'not_found') throw error }
    },
    // One classic LinkedIn people search page on the owner's own session.
    // The response shape is parsed defensively: only well-formed people with a
    // public identifier are returned, and nothing else is passed through.
    async searchPeople(id, { keywords, limit = 10, signal } = {}) {
      if (typeof keywords !== 'string' || !keywords.trim() || keywords.length > 200) throw new UnipileError('invalid_request')
      const value = await call('POST', '/api/v1/linkedin/search', { signal, query: { account_id: accountId(id), limit: Math.max(1, Math.min(10, limit)) }, body: { api: 'classic', category: 'people', keywords: keywords.trim() } })
      if (!value || !Array.isArray(value.items)) throw new UnipileError('invalid_response')
      const people = []
      for (const item of value.items.slice(0, 10)) {
        const publicIdentifier = text(item?.public_identifier, 200), name = text(item?.name, 300)
        if (item?.type !== 'PEOPLE' || !name || !publicIdentifier || !/^[A-Za-z0-9\-_%.]{1,200}$/.test(publicIdentifier)) continue
        const distance = /^DISTANCE_([123])$/.exec(text(item.network_distance, 40) ?? '')
        people.push({ publicIdentifier, name, ...(text(item.headline, 500) ? { headline: item.headline } : {}), ...(text(item.location, 300) ? { location: item.location } : {}), ...(distance ? { networkDistance: Number(distance[1]) } : {}) })
      }
      const total = Number(value.paging?.total_count)
      return { people, skipped: Math.min(value.items.length, 10) - people.length, ...(Number.isSafeInteger(total) && total >= 0 ? { total } : {}) }
    },
  }
}
