import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// OAuth 2.1 authorization server for the hosted MCP resource (/mcp), so MCP
// clients such as Claude custom connectors and ChatGPT developer-mode
// connectors connect with "paste the URL, sign in, approve". Contract:
// docs/agent-api.md ("OAuth connector").
//
// - Discovery: RFC 9728 protected resource metadata and RFC 8414 authorization
//   server metadata; /mcp answers 401 with a WWW-Authenticate challenge.
// - Clients: Client ID Metadata Documents from an allow list of hosted client
//   hosts (Claude, ChatGPT), or stateless dynamic registration (RFC 7591) whose
//   client_id is an HMAC-signed record of the registered redirect URIs, so a
//   runtime restart never forgets a client and registration stores nothing.
// - Redirect URIs are restricted to the exact hosted connector callbacks and
//   RFC 8252 loopback URIs. Arbitrary HTTPS redirects are refused, so a
//   look-alike client can never receive an authorization code off-device.
// - Public clients only (token_endpoint_auth_method "none"), PKCE S256
//   required, single-use 60 s codes, RFC 9207 `iss` on every redirect.
// - The access token IS an ordinary account grant (mcp-server/account-grants.mjs)
//   with the consented scope and the connected app recorded on the grant
//   record. It does not expire and every request re-checks the durable grant
//   record, so "Disconnect" in Settings (or RFC 7009 revocation) is immediate.
//   No refresh tokens are issued.

export const OAUTH_SCOPE_DESCRIPTIONS = Object.freeze({
  network: 'Read your own Unlinked account and network: who you are, the connections in your imported files and your linked profile’s recorded paths, and (where available) your connection requests and notifications.',
  people: 'Search and read the published People index on Unlinked (public professional profiles only).',
})

const CODE_SECONDS = 60, CODE_CAPACITY = 1000
const CIMD_HOSTS = new Set(['claude.ai', 'claude.com', 'chatgpt.com'])
const CIMD_TTL_MS = 60 * 60 * 1000, CIMD_FAILURE_TTL_MS = 60 * 1000, CIMD_CAPACITY = 64, CIMD_BYTES = 32 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const b64url = value => Buffer.from(value).toString('base64url')
const sha256hex = value => createHash('sha256').update(value).digest('hex')
const printable = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)

// The hosted connector callbacks this server will ever redirect a code to,
// besides loopback. `app` is the label shown on the consent screen and stored
// on the grant: it comes from the verified redirect target, never from the
// client's self-asserted name.
function hostedRedirectApp(uri) {
  if (uri === 'https://claude.ai/api/mcp/auth_callback' || uri === 'https://claude.com/api/mcp/auth_callback') return 'Claude'
  if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect' || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(uri)) return 'ChatGPT'
  return null
}

function parseLoopback(uri) {
  let url
  try { url = new URL(uri) } catch { return null }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.href !== uri) return null
  if (!/^\/[A-Za-z0-9/._~-]{0,200}$/.test(url.pathname)) return null
  return url
}

// Registration-time policy for a redirect URI. Canonical form only.
export function redirectPolicy(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null
  const app = hostedRedirectApp(uri)
  if (app) return { app, loopback: false, host: new URL(uri).host }
  const loopback = parseLoopback(uri)
  return loopback ? { app: null, loopback: true, host: loopback.host } : null
}

// RFC 8252 section 7.3: loopback redirect ports are chosen at request time, so
// a registered loopback URI matches any port with the same scheme/host/path.
function redirectMatches(registered, requested) {
  if (registered === requested) return true
  const a = parseLoopback(registered), b = parseLoopback(requested)
  return Boolean(a && b && a.hostname === b.hostname && a.pathname === b.pathname)
}

export class OAuthError extends Error {
  constructor(code, description, status = 400) { super(code); this.code = code; this.description = description; this.status = status }
}

export function createOAuthServer({ origin, resourcePath = '/mcp', clientKey, publicSearchEnabled = false, issueGrant, revokeConnectionToken, audit, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || !(clientKey instanceof Uint8Array) || clientKey.length < 32 ||
      typeof issueGrant !== 'function' || typeof revokeConnectionToken !== 'function' || typeof fetchImpl !== 'function' || !/^\/[a-z]+$/.test(resourcePath)) throw new Error('oauth_server_configuration_required')
  const resource = new URL(resourcePath, base).href
  const metadataUrl = new URL(`/.well-known/oauth-protected-resource${resourcePath}`, base).href
  // Accepted spellings of this server's resource indicator (RFC 8707).
  const resourceAliases = new Set([resource, `${resource}/`, base.origin, `${base.origin}/`])
  const scopesSupported = publicSearchEnabled ? ['network', 'people'] : ['network']
  const defaultScopeText = scopesSupported.join(' ')
  const endpoint = path => new URL(path, base).href
  const issuedFor = new Map() // authorization code hash -> pending exchange
  const cimdCache = new Map()
  const budgets = new Map()

  const protectedResourceMetadata = Object.freeze({ resource, authorization_servers: [base.origin], scopes_supported: scopesSupported,
    bearer_methods_supported: ['header'], resource_name: 'Unlinked', resource_documentation: endpoint('/agents') })
  const authorizationServerMetadata = Object.freeze({ issuer: base.origin,
    authorization_endpoint: endpoint('/oauth/authorize'), token_endpoint: endpoint('/oauth/token'), registration_endpoint: endpoint('/oauth/register'), revocation_endpoint: endpoint('/oauth/revoke'),
    response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    scopes_supported: scopesSupported, client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    service_documentation: endpoint('/agents') })

  const withinBudget = (name, perMinute) => {
    const at = now()
    let value = budgets.get(name)
    if (!value || at - value.window >= 60000) { value = { window: at, count: 0 }; budgets.set(name, value) }
    return ++value.count <= perMinute
  }

  // Stateless dynamic registration: the client_id carries its own redirect
  // URIs and display name under an HMAC, versioned by the "ulc1." prefix.
  const mac = payload => createHmac('sha256', clientKey).update(`unlinked-oauth-client-v1\n${payload}`).digest().subarray(0, 16)
  const mintClientId = record => { const payload = b64url(JSON.stringify(record)); return `ulc1.${payload}.${b64url(mac(payload))}` }
  function registeredClient(clientId) {
    const match = /^ulc1\.([A-Za-z0-9_-]{8,2048})\.([A-Za-z0-9_-]{22})$/.exec(clientId)
    if (!match) return null
    const expected = mac(match[1]), given = Buffer.from(match[2], 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    let record
    try { record = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) } catch { return null }
    if (!Array.isArray(record?.r) || !record.r.length || record.r.length > 8 || !record.r.every(uri => redirectPolicy(uri)) || !(record.n === null || printable(record.n, 100))) return null
    return { clientId, clientName: record.n, redirectUris: record.r }
  }

  // Client ID Metadata Documents, fetched only from allow-listed hosted client
  // hosts (no SSRF surface), without redirects, bounded in time and size.
  async function metadataDocumentClient(clientId) {
    let url
    try { url = new URL(clientId) } catch { return null }
    if (url.protocol !== 'https:' || !CIMD_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.href !== clientId || url.pathname === '/') return null
    const cached = cimdCache.get(clientId)
    if (cached && cached.expiresAt > now()) { if (cached.client) return cached.client; throw new OAuthError('invalid_client', 'The client metadata document could not be read; retry shortly.') }
    // Bounds outbound fetches if someone cycles through many allow-listed URLs.
    if (!withinBudget('cimd', 60)) throw new OAuthError('invalid_client', 'The client metadata document could not be read right now; retry in a minute.')
    let client = null
    try {
      const response = await fetchImpl(clientId, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
      const text = response.ok ? await response.text() : ''
      if (response.ok && Buffer.byteLength(text) <= CIMD_BYTES) {
        const document = JSON.parse(text)
        const redirectUris = Array.isArray(document?.redirect_uris) ? document.redirect_uris.filter(uri => redirectPolicy(uri)).slice(0, 16) : []
        if (document?.client_id === clientId && printable(document.client_name, 100) && redirectUris.length) client = { clientId, clientName: document.client_name, redirectUris }
      }
    } catch { client = null }
    if (cimdCache.size >= CIMD_CAPACITY) cimdCache.delete(cimdCache.keys().next().value)
    cimdCache.set(clientId, { client, expiresAt: now() + (client ? CIMD_TTL_MS : CIMD_FAILURE_TTL_MS) })
    if (!client) throw new OAuthError('invalid_client', 'The client metadata document could not be read or lists no permitted redirect URI.')
    return client
  }

  async function resolveClient(clientId) {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 4096) return null
    return clientId.startsWith('https://') ? metadataDocumentClient(clientId) : registeredClient(clientId)
  }

  // Maps requested scopes onto a catalog grant scope. `people` implies
  // `network` (there is no public-only grant scope). Unknown values such as
  // "openid" or "offline_access" are ignored; nothing known means everything
  // this server offers, which is what the consent screen then lists.
  function grantScopeFor(requested) {
    const words = new Set(String(requested ?? '').split(' ').filter(Boolean))
    const people = publicSearchEnabled && words.has('people')
    const network = words.has('network')
    if (people || !network) return publicSearchEnabled ? { scope: 'owner_network_and_public', scopeText: 'network people' } : { scope: 'owner_network', scopeText: 'network' }
    return { scope: 'owner_network', scopeText: 'network' }
  }

  const single = (params, name) => {
    const values = params.getAll(name)
    if (values.length > 1) throw new OAuthError('invalid_request', `Parameter ${name} must appear at most once.`)
    return values[0]
  }
  const errorRedirect = (redirectUri, error, description, state) => {
    const target = new URL(redirectUri)
    target.searchParams.set('error', error)
    if (description) target.searchParams.set('error_description', description)
    if (state !== undefined) target.searchParams.set('state', state)
    target.searchParams.set('iss', base.origin)
    return target.href
  }

  // Validates an authorization request. Problems with the client or redirect
  // URI are shown to the user and never redirected (RFC 6749 4.1.2.1); all
  // other errors go back to the verified redirect URI.
  async function readAuthorization(params) {
    let clientId, redirectParam
    try { clientId = single(params, 'client_id'); redirectParam = single(params, 'redirect_uri') }
    catch (error) { return { ok: false, message: error.description } }
    let client
    try { client = await resolveClient(clientId) } catch (error) { return { ok: false, message: error.description ?? 'Unknown client.' } }
    if (!client) return { ok: false, message: 'This app is not registered with Unlinked. Remove the connector and add it again.' }
    const redirectUri = redirectParam ?? (client.redirectUris.length === 1 && !parseLoopback(client.redirectUris[0]) ? client.redirectUris[0] : undefined)
    const policy = redirectPolicy(redirectUri)
    if (!redirectUri || !policy || !client.redirectUris.some(uri => redirectMatches(uri, redirectUri))) return { ok: false, message: 'The app asked to return to an address it did not register.' }
    let state
    try {
      state = single(params, 'state')
      if (state !== undefined && (state.length > 1024 || /[\x00-\x1f\x7f]/.test(state))) { state = undefined; throw new OAuthError('invalid_request', 'The state parameter is too long.') }
      if (single(params, 'response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported.')
      const challenge = single(params, 'code_challenge'), method = single(params, 'code_challenge_method')
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || method !== 'S256') throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
      const requestedResource = single(params, 'resource')
      if (requestedResource !== undefined && !resourceAliases.has(requestedResource)) throw new OAuthError('invalid_target', `This server only issues tokens for ${resource}.`)
      const scopeParam = single(params, 'scope')
      if (scopeParam !== undefined && scopeParam.length > 1024) throw new OAuthError('invalid_scope', 'The scope parameter is too long.')
      const { scope, scopeText } = grantScopeFor(scopeParam)
      const app = policy.app ?? 'An app on this computer'
      const forward = new URLSearchParams()
      for (const [key, value] of [['client_id', clientId], ['redirect_uri', redirectUri], ['state', state], ['response_type', 'code'], ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['resource', requestedResource], ['scope', scopeParam]]) if (value !== undefined) forward.set(key, value)
      return { ok: true, request: Object.freeze({ clientId, clientName: client.clientName, app, loopback: policy.loopback, redirectUri, redirectHost: policy.host, state,
        codeChallenge: challenge, resource: requestedResource ?? null, scope, scopeText, scopes: scopeText.split(' ').map(name => ({ name, description: OAUTH_SCOPE_DESCRIPTIONS[name] })), params: forward }) }
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error
      return { ok: false, redirect: errorRedirect(redirectUri, error.code, error.description, state) }
    }
  }

  function approve(request, owner) {
    if (!owner || typeof owner.ownerId !== 'string' || typeof owner.userId !== 'string') throw new Error('oauth_owner_required')
    const at = now()
    for (const [key, value] of issuedFor) if (value.expiresAt <= at) issuedFor.delete(key)
    if (issuedFor.size >= CODE_CAPACITY) throw new Error('oauth_authorization_capacity')
    const code = randomBytes(32).toString('base64url')
    issuedFor.set(sha256hex(code), { clientId: request.clientId, clientName: request.clientName, app: request.app, redirectUri: request.redirectUri, redirectHost: request.redirectHost,
      codeChallenge: request.codeChallenge, resource: request.resource, scope: request.scope, scopeText: request.scopeText,
      owner: { ownerId: owner.ownerId, userId: owner.userId }, expiresAt: at + CODE_SECONDS * 1000 })
    const target = new URL(request.redirectUri)
    target.searchParams.set('code', code)
    if (request.state !== undefined) target.searchParams.set('state', request.state)
    target.searchParams.set('iss', base.origin)
    return target.href
  }
  const deny = request => errorRedirect(request.redirectUri, 'access_denied', 'The person declined to connect this app.', request.state)

  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'WWW-Authenticate' }
  const json = (response, status, value, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...corsHeaders, ...headers })
    response.end(JSON.stringify(value))
  }
  const fail = (response, error) => json(response, error.status ?? 400, { error: error.code, error_description: error.description })
  async function readBody(request, limit) {
    const parts = []; let size = 0
    for await (const part of request) { size += part.length; if (size > limit) throw new OAuthError('invalid_request', 'The request body is too large.', 413); parts.push(part) }
    return Buffer.concat(parts).toString('utf8')
  }
  const formBody = async request => {
    if (!/^application\/x-www-form-urlencoded(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new OAuthError('invalid_request', 'Use application/x-www-form-urlencoded.')
    return new URLSearchParams(await readBody(request, 8192))
  }
  // Public clients send client_id in the body; tolerate HTTP Basic with an
  // empty secret from clients that always use it.
  const clientIdFrom = (request, params) => {
    const header = request.headers.authorization
    if (typeof header === 'string' && /^Basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'), index = decoded.indexOf(':')
      let id
      try { id = decodeURIComponent((index < 0 ? decoded : decoded.slice(0, index)).replace(/\+/g, ' ')) } catch { throw new OAuthError('invalid_client', 'Malformed client credentials.', 401) }
      const fromBody = single(params, 'client_id')
      if (fromBody !== undefined && fromBody !== id) throw new OAuthError('invalid_client', 'Conflicting client identifiers.', 401)
      return id
    }
    return single(params, 'client_id')
  }

  async function register(request, response) {
    // Registration is stateless and cheap; the budget only bounds abuse.
    if (!withinBudget('register', 600)) throw new OAuthError('temporarily_unavailable', 'Too many registrations; retry in a minute.', 429)
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new OAuthError('invalid_client_metadata', 'Send the client metadata as application/json.')
    let metadata
    try { metadata = JSON.parse(await readBody(request, 16384)) } catch (error) { if (error instanceof OAuthError) throw error; throw new OAuthError('invalid_client_metadata', 'The client metadata is not valid JSON.') }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new OAuthError('invalid_client_metadata', 'The client metadata must be a JSON object.')
    const uris = metadata.redirect_uris
    if (!Array.isArray(uris) || !uris.length || uris.length > 8 || uris.some(uri => typeof uri !== 'string')) throw new OAuthError('invalid_redirect_uri', 'Provide between one and eight redirect_uris.')
    const refused = uris.find(uri => !redirectPolicy(uri))
    if (refused !== undefined) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be a supported connector callback (Claude, ChatGPT) or a loopback http://localhost / http://127.0.0.1 address.')
    if (metadata.grant_types !== undefined && !(Array.isArray(metadata.grant_types) && metadata.grant_types.includes('authorization_code'))) throw new OAuthError('invalid_client_metadata', 'grant_types must include authorization_code.')
    if (metadata.response_types !== undefined && !(Array.isArray(metadata.response_types) && metadata.response_types.includes('code'))) throw new OAuthError('invalid_client_metadata', 'response_types must include code.')
    const clientName = printable(metadata.client_name, 100) ? metadata.client_name : null
    const issuedAt = Math.floor(now() / 1000)
    const redirectUris = [...new Set(uris)]
    const clientId = mintClientId({ n: clientName, r: redirectUris, t: issuedAt })
    if (!registeredClient(clientId)) throw new OAuthError('invalid_client_metadata', 'The registration is too large; register fewer or shorter redirect URIs.')
    // Every client is public: whatever authentication method was requested,
    // the registration answers "none" and issues no secret (RFC 7591 3.2.1).
    json(response, 201, { client_id: clientId, client_id_issued_at: issuedAt, ...(clientName ? { client_name: clientName } : {}), redirect_uris: redirectUris,
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' })
  }

  async function token(request, response) {
    // No global budget: only a consented, single-use code leads to a write.
    const params = await formBody(request)
    const grantType = single(params, 'grant_type')
    if (grantType !== 'authorization_code') throw new OAuthError('unsupported_grant_type', 'Only the authorization_code grant is supported; tokens do not expire, so no refresh is needed.')
    const clientId = clientIdFrom(request, params)
    const code = single(params, 'code'), verifier = single(params, 'code_verifier'), redirectUri = single(params, 'redirect_uri'), requestedResource = single(params, 'resource')
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401)
    if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.')
    const key = sha256hex(code), pending = issuedFor.get(key)
    issuedFor.delete(key) // single use, whatever the outcome
    if (!pending || pending.expiresAt <= now()) throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used.')
    if (pending.clientId !== clientId) throw new OAuthError('invalid_grant', 'The authorization code was issued to another client.')
    if (redirectUri !== pending.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.')
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'The code_verifier is malformed.')
    const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url')), expected = Buffer.from(pending.codeChallenge)
    if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) throw new OAuthError('invalid_grant', 'PKCE verification failed.')
    if (requestedResource !== undefined && !resourceAliases.has(requestedResource)) throw new OAuthError('invalid_target', `This server only issues tokens for ${resource}.`)
    const connection = { kind: 'oauth', app: pending.app, clientName: pending.clientName, redirectHost: pending.redirectHost, clientKey: sha256hex(clientId), resource }
    const issued = await issueGrant(pending.owner, undefined, { scope: pending.scope, connection })
    if (typeof audit === 'function') {
      try { await audit({ event: 'oauth_connection_granted', app: pending.app, clientKey: connection.clientKey, ownerHash: sha256hex(pending.owner.ownerId), grantId: issued.grantId, scope: pending.scope, at: new Date(now()).toISOString(), origin: base.origin }) }
      catch { /* Audit availability never changes an already-consented issuance. */ }
    }
    json(response, 200, { access_token: issued.accessToken, token_type: 'Bearer', scope: pending.scopeText })
  }

  async function revoke(request, response) {
    if (!withinBudget('revoke', 600)) throw new OAuthError('temporarily_unavailable', 'Too many revocation requests; retry in a minute.', 429)
    const params = await formBody(request)
    const value = single(params, 'token'), clientId = clientIdFrom(request, params)
    if (!value) throw new OAuthError('invalid_request', 'token is required.')
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401)
    // RFC 7009 2.2: answer 200 for unknown tokens too.
    if (/^[A-Za-z0-9._~-]{1,8192}$/.test(value)) await revokeConnectionToken(value, sha256hex(clientId))
    response.writeHead(200, { 'Cache-Control': 'no-store', ...corsHeaders }).end()
  }

  const paths = new Set(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${resourcePath}`, '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration', '/oauth/register', '/oauth/token', '/oauth/revoke'])
  const isEndpoint = pathname => paths.has(pathname) || pathname.startsWith('/.well-known/oauth-') || pathname.startsWith('/.well-known/openid-configuration')

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.host !== base.host) { response.writeHead(403).end(); return }
    const pathname = new URL(request.url, base).pathname
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Max-Age': '600' }).end(); return
    }
    try {
      if (pathname === '/.well-known/oauth-protected-resource' || pathname === `/.well-known/oauth-protected-resource${resourcePath}`) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new OAuthError('invalid_request', 'Use GET.', 405)
        json(response, 200, protectedResourceMetadata); return
      }
      if (pathname === '/.well-known/oauth-authorization-server') {
        if (!['GET', 'HEAD'].includes(request.method)) throw new OAuthError('invalid_request', 'Use GET.', 405)
        json(response, 200, authorizationServerMetadata); return
      }
      if (pathname === '/oauth/register' || pathname === '/oauth/token' || pathname === '/oauth/revoke') {
        if (request.method !== 'POST') throw new OAuthError('invalid_request', 'Use POST.', 405)
        await (pathname === '/oauth/register' ? register : pathname === '/oauth/token' ? token : revoke)(request, response); return
      }
      json(response, 404, { error: 'not_found', error_description: 'This server publishes OAuth 2.0 authorization server metadata at /.well-known/oauth-authorization-server.' })
    } catch (error) {
      if (error instanceof OAuthError) { fail(response, error); return }
      fail(response, new OAuthError('server_error', 'The request could not be completed; retry.', 500))
    }
  }

  // RFC 6750 / RFC 9728 challenge for 401 responses from the resource.
  const challenge = ({ invalidToken = false } = {}) => `Bearer ${invalidToken ? 'error="invalid_token", ' : ''}resource_metadata="${metadataUrl}", scope="${defaultScopeText}"`

  return { resource, metadataUrl, scopesSupported, isEndpoint, handle, readAuthorization, approve, deny, challenge }
}
