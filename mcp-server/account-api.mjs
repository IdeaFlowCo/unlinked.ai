import { createHash, timingSafeEqual } from 'node:crypto'
import { AccountToolError } from './account-tools.mjs'

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{4,64}$/
const sha256 = value => createHash('sha256').update(value).digest()

// Confidential-client Basic credentials (client_secret_basic). Unknown client
// ids still perform one hash comparison so lookups are not timing-observable.
const DUMMY_SECRET_HASH = sha256('unlinked-provisioning-dummy-secret')
function authenticateClient(request, clients) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Basic ') || header.length > 1024) return null
  let decoded
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8') } catch { return null }
  const split = decoded.indexOf(':')
  if (split < 1) return null
  const clientId = decoded.slice(0, split), secret = decoded.slice(split + 1)
  const client = clients.find(value => value.clientId === clientId) ?? null
  const presented = sha256(secret)
  const expected = client ? client.secretSha256 : DUMMY_SECRET_HASH
  const matched = timingSafeEqual(presented, expected)
  return client && matched ? client : null
}

// Grant-authenticated HTTP JSON surface for the same account tool service the
// hosted MCP endpoint uses. Versioned contract: docs/agent-api.md (v1). The
// MCP tools are thin wrappers over these semantics; names map 1:1.
const ROUTES = Object.freeze({
  'GET /api/agent/v1/whoami': { tool: 'unlinked_whoami', query: [] },
  'GET /api/agent/v1/people': { tool: 'unlinked_list_people', query: ['q', 'mode', 'presence', 'cursor', 'limit'], numbers: ['limit'] },
  'GET /api/agent/v1/connections': { tool: 'unlinked_list_connections', query: ['degree', 'q', 'cursor', 'limit'], numbers: ['degree', 'limit'] },
  'GET /api/agent/v1/connection-requests': { tool: 'unlinked_list_connection_requests', query: ['direction'] },
  'GET /api/agent/v1/notifications': { tool: 'unlinked_list_notifications', query: ['limit'], numbers: ['limit'] },
  'POST /api/agent/v1/connection-requests/send': { tool: 'unlinked_send_connection_request', body: ['profileId', 'note'] },
  'POST /api/agent/v1/connection-requests/accept': { tool: 'unlinked_accept_connection_request', body: ['id'] },
  'POST /api/agent/v1/connection-requests/ignore': { tool: 'unlinked_ignore_connection_request', body: ['id'] },
  'POST /api/agent/v1/connection-requests/withdraw': { tool: 'unlinked_withdraw_connection_request', body: ['id'] },
  'POST /api/agent/v1/ai-search': { tool: 'unlinked_ai_search', body: ['query', 'scope', 'timeoutMs'] },
  'POST /api/agent/v1/search-network': { tool: 'unlinked_search_network', body: ['query', 'degree', 'cursor'] },
  'POST /api/agent/v1/search-everyone': { tool: 'unlinked_search_everyone', body: ['query'] },
})

async function readJsonBody(request, limit = 8192) {
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type && type !== 'application/json') throw new AccountToolError('invalid_input', 'Send a JSON body with Content-Type: application/json.')
  const parts = []
  let size = 0
  for await (const part of request) {
    size += part.length
    if (size > limit) throw new AccountToolError('invalid_input', 'The request body exceeds 8 KiB.')
    parts.push(part)
  }
  if (!size) return {}
  let value
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new AccountToolError('invalid_input', 'The request body is not valid JSON.') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AccountToolError('invalid_input', 'The request body must be a JSON object.')
  return value
}

export function createAccountAgentApiHandler({ authenticateGrantDetailed, authenticateGrant, service, origin, provisioning }) {
  provisioning = provisioning ?? undefined
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || typeof authenticateGrantDetailed !== 'function' || typeof authenticateGrant !== 'function' || typeof service?.call !== 'function') throw new Error('account_agent_api_configuration_required')
  // Server-to-server grant provisioning is default-off: it exists only when an
  // operator supplies a non-empty confidential-client allow list plus the
  // verified-identity resolver and ensureGrant capability.
  if (provisioning !== undefined && (!Array.isArray(provisioning.clients) || !provisioning.clients.length ||
      provisioning.clients.some(client => !CLIENT_ID_PATTERN.test(client?.clientId ?? '') || !(client.secretSha256 instanceof Uint8Array) || client.secretSha256.length !== 32) ||
      new Set(provisioning.clients.map(client => client.clientId)).size !== provisioning.clients.length ||
      typeof provisioning.resolveOwner !== 'function' || typeof provisioning.ensureGrant !== 'function' ||
      (provisioning.audit !== undefined && typeof provisioning.audit !== 'function') ||
      (provisioning.perClientPerMinute !== undefined && !(Number.isSafeInteger(provisioning.perClientPerMinute) && provisioning.perClientPerMinute >= 1 && provisioning.perClientPerMinute <= 600)))) throw new Error('account_agent_provisioning_configuration_required')
  const provisionBudgets = new Map()
  const admitClient = clientId => {
    const limit = provisioning.perClientPerMinute ?? 30
    const now = Date.now()
    let value = provisionBudgets.get(clientId)
    if (!value || now - value.window >= 60000) { value = { window: now, count: 0 }; provisionBudgets.set(clientId, value) }
    if (++value.count > limit) {
      const error = new AccountToolError('rate_limited', 'Provisioning budget for this client is exhausted; retry when the window resets.')
      error.retryAfter = Math.max(1, Math.ceil((value.window + 60000 - now) / 1000))
      throw error
    }
  }
  async function provisionGrant(request, response) {
    // Client authentication comes first and uses its own typed code so a
    // credential problem is never confused with an unlinked person.
    const client = authenticateClient(request, provisioning.clients)
    if (!client) throw new AccountToolError('client_unauthorized', 'Unknown client or wrong client secret. Supply allow-listed confidential-client credentials via HTTP Basic.')
    admitClient(client.clientId)
    const body = await readJsonBody(request)
    const unknown = Object.keys(body).find(key => !['issuer', 'subject'].includes(key))
    if (unknown) throw new AccountToolError('invalid_input', `Unknown field: ${unknown}`)
    const { issuer, subject } = body
    let issuerUrl = null
    try { issuerUrl = new URL(issuer) } catch { /* typed below */ }
    if (typeof issuer !== 'string' || issuer.length > 256 || issuerUrl?.protocol !== 'https:' ||
        typeof subject !== 'string' || !subject || subject.length > 512 || /[\x00-\x1f\x7f]/.test(subject)) throw new AccountToolError('invalid_input', 'Send { issuer, subject }: the verified https OIDC issuer and the exact opaque subject.')
    // The caller must have verified this identity itself; this endpoint only
    // maps an exact issuer+subject binding to its owner — never email.
    let owner = null
    try { owner = await provisioning.resolveOwner({ issuer, subject }) } catch { throw new AccountToolError('upstream_unavailable', 'The identity binding could not be read right now; retry.') }
    if (!owner || typeof owner.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) throw new AccountToolError('not_linked', 'No Unlinked account is bound to that verified identity. The person must sign in at /login once; linkage is never established by email matching.')
    let ensured = null
    try { ensured = await provisioning.ensureGrant({ ownerId: owner.ownerId, userId: owner.userId }, { readOnly: true }) } catch { throw new AccountToolError('upstream_unavailable', 'Grant provisioning could not finish; retry.') }
    if (!ensured) throw new AccountToolError('grant_revoked', 'The owner revoked agent access; it stays off until they re-enable it in Settings.')
    // Validate end to end before handing anything out: the returned token must
    // authenticate against the live grant record.
    const verified = await authenticateGrantDetailed({ headers: { authorization: `Bearer ${ensured.accessToken}` } })
    if (verified.error === 'grant_revoked') throw new AccountToolError('grant_revoked', 'The owner revoked agent access; it stays off until they re-enable it in Settings.')
    if (!verified.grant || verified.grant.ownerId !== owner.ownerId) throw new AccountToolError('upstream_unavailable', 'The provisioned grant could not be verified right now; retry.')
    const grant = verified.grant
    // Audit the event — never the token. The contract promises an audit row
    // for every issuance/reuse, so an unauditable provisioning fails closed:
    // the token is simply not returned (the grant record itself is unchanged).
    if (provisioning.audit) {
      try { await provisioning.audit({ event: ensured.created ? 'account_grant_provisioned' : 'account_grant_reused', clientId: client.clientId, ownerHash: createHash('sha256').update(owner.ownerId).digest('hex'), grantId: ensured.grantId, at: new Date().toISOString(), origin: base.origin }) }
      catch { throw new AccountToolError('upstream_unavailable', 'Provisioning could not be audited, so no credential was returned; retry after the operator restores the audit sink.') }
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ kind: 'unlinked_provision_grant', ownerId: owner.ownerId, grantId: ensured.grantId, created: ensured.created === true,
      version: grant.version, scope: grant.scope, tools: grant.tools, accessToken: ensured.accessToken }))
  }
  const send = (response, status, value, headers = {}) => {
    if (response.headersSent) { response.end(); return }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    response.end(JSON.stringify(value))
  }
  const failure = (response, error) => {
    const typed = error instanceof AccountToolError ? error : new AccountToolError('upstream_unavailable', 'The request could not finish; retry.')
    send(response, typed.status, { error: { code: typed.code, message: typed.message } }, typed.code === 'rate_limited' ? { 'Retry-After': '60' } : {})
  }
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'strict-origin')
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    if (request.headers.host !== base.host || request.headers.origin && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    try {
      const url = new URL(request.url, base)
      if (url.origin !== base.origin) { response.writeHead(403).end(); return }
      if (url.pathname === '/api/agent/v1/provision-grant') {
        if (!provisioning) { failure(response, new AccountToolError('not_found', 'Grant provisioning is not enabled on this runtime.')); return }
        if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
        await provisionGrant(request, response); return
      }
      const detailMatch = url.pathname.match(/^\/api\/agent\/v1\/people\/([^/]+)$/)
      const profileMatch = request.method === 'GET' && detailMatch
      const suffix = url.pathname.slice('/api/agent/v1/'.length)
      const route = profileMatch ? { tool: 'unlinked_get_profile', query: ['connectionsCursor'] } : ROUTES[`${request.method} /api/agent/v1/${suffix}`]
      if (!url.pathname.startsWith('/api/agent/v1/') || !route) {
        const allowed = detailMatch ? 'GET' : ['GET', 'POST'].map(method => ROUTES[`${method} /api/agent/v1/${suffix}`] ? method : null).filter(Boolean).join(', ')
        if (allowed) { response.writeHead(405, { Allow: allowed }).end(); return }
        if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return }
        failure(response, new AccountToolError('not_found', 'Unknown agent API route. See docs/agent-api.md for the v1 contract.')); return
      }
      const detailed = await authenticateGrantDetailed(request)
      if (!detailed.grant) {
        const messages = {
          grant_revoked: 'The grant was revoked or its account was deleted; sign in at /settings and create a new agent grant.',
          upstream_unavailable: 'The grant could not be verified right now; retry with the same token.',
          not_linked: 'No linked Unlinked account: supply a valid account-grant bearer token issued at /settings. Linkage is never established by email matching.',
        }
        const code = Object.hasOwn(messages, detailed.error) ? detailed.error : 'not_linked'
        failure(response, new AccountToolError(code, messages[code]))
        return
      }
      const grant = detailed.grant
      const input = {}
      if (route.body) {
        const body = await readJsonBody(request)
        const unknown = Object.keys(body).find(key => !route.body.includes(key))
        if (unknown) throw new AccountToolError('invalid_input', `Unknown field: ${unknown}`)
        for (const key of route.body) if (body[key] !== undefined) input[key] = body[key]
      } else {
        const unknown = [...url.searchParams.keys()].find(key => !route.query.includes(key))
        if (unknown) throw new AccountToolError('invalid_input', `Unknown query parameter: ${unknown}`)
        for (const key of route.query) {
          const values = url.searchParams.getAll(key)
          if (values.length > 1) throw new AccountToolError('invalid_input', `Repeated query parameter: ${key}`)
          if (!values.length) continue
          if (route.numbers?.includes(key)) {
            const value = Number(values[0])
            if (!Number.isSafeInteger(value)) throw new AccountToolError('invalid_input', `${key} must be an integer.`)
            input[key] = value
          } else input[key] = values[0]
        }
        if (profileMatch) {
          try { input.id = decodeURIComponent(profileMatch[1]) } catch { throw new AccountToolError('invalid_input', 'The profile id is not valid percent-encoding.') }
        }
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      // The pre-call check already happened just above; revalidate only after
      // the tool body, so a mid-call revocation still never returns data.
      let checked = false
      const revalidate = async () => {
        if (!checked) { checked = true; return }
        const current = await authenticateGrant(request)
        if (!current || current.grantId !== grant.grantId || current.ownerId !== grant.ownerId || current.userId !== grant.userId || JSON.stringify(current.tools) !== JSON.stringify(grant.tools)) throw new AccountToolError('grant_revoked', 'The grant was revoked; sign in and create a new agent grant.')
      }
      const { text } = await service.call({ grant, name: route.tool, input, signal, revalidate })
      if (response.headersSent) { response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(text)
    } catch (error) { failure(response, error) }
  }
}
