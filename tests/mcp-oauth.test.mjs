import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'
import { createOAuthServer, redirectPolicy } from '../mcp-server/oauth-server.mjs'
import { Client } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StreamableHTTPClientTransport } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
import { UnauthorizedError } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js'

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
const b64sha = value => createHash('sha256').update(value).digest('base64url')

async function freePort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 7000 + Math.floor(Math.random() * 3000)
    const free = await new Promise(resolve => { const probe = createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true))) })
    if (free) return port
  }
  throw new Error('no free port')
}

// Durable-contract graph fixture (CAS revisions, payload-erasing tombstones).
function store() {
  const resources = new Map()
  const backend = owner => ({
    readResource: async (_type, id) => { const value = resources.get(id); return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null },
    writeResource: async value => {
      const prior = resources.get(value.sourceId)
      if (prior ? value.expectedRevision !== prior.sourceRevision || (prior.deleted && !value.deleted) : value.expectedRevision != null) throw new Error('cas_conflict')
      const stored = { ...value }; delete stored.expectedRevision
      resources.set(value.sourceId, structuredClone(stored))
    },
    listImportIds: async () => [], listImportJobIds: async () => [],
    listAccountGrantIds: async () => [...resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted && x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
    adapter: {},
  })
  return { resources, getBackend: async owner => backend(owner), live: () => [...resources.values()].filter(x => !x.deleted && x.payload?.kind === 'account_tool_grant') }
}

async function pilot(t) {
  const owner = { ownerId: 'oauth-owner', userId: 'oauth-user' }
  const graph = store(), auditEvents = []
  const port = await freePort()
  const baseUrl = `https://127.0.0.1:${port}`, endpoint = `http://127.0.0.1:${port}`
  const running = await startPrivatePilot({ baseUrl, port, host: '127.0.0.1', dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'oauth-subject', verifiedEmail: 'member@example.invalid' }) },
    resolveOwner: async () => owner, signup: async () => owner, accountGrantKey: randomBytes(32),
    getBackend: graph.getBackend, complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => ({ people: [] }),
    audit: async event => { auditEvents.push(event) } })
  t.after(() => running.stop())
  const go = (path, init = {}) => fetch(endpoint + path, { redirect: 'manual', ...init })
  const signIn = async next => {
    const start = await go(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`)
    const callback = await go('/auth/callback/ideaflow?state=synthetic-state&code=x', { headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    return { cookie: callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0], location: callback.headers.get('location') }
  }
  const register = (metadata, headers = {}) => go('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(metadata) })
  const token = form => go('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  return { owner, graph, auditEvents, baseUrl, endpoint, go, signIn, register, token }
}

const authorizeQuery = (clientId, extra = {}) => new URLSearchParams({ client_id: clientId, redirect_uri: CLAUDE, response_type: 'code', state: 'st-1',
  code_challenge: b64sha('v'.repeat(64)), code_challenge_method: 'S256', resource: 'RESOURCE', scope: 'network people', ...extra })
const csrfFrom = text => text.match(/name="csrf" value="([^"]+)"/)[1]
const hiddenParams = text => new URLSearchParams([...text.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].filter(m => m[1] !== 'csrf').map(m => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')]))

async function mcpTools(endpoint, accessToken) {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }))
  try { return (await client.listTools()).tools.map(tool => tool.name).sort() } finally { await client.close() }
}

test('discovery metadata, CORS and the /mcp challenge point clients at sign-in', async t => {
  const p = await pilot(t)
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await p.go(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(await response.json(), { resource: `${p.baseUrl}/mcp`, authorization_servers: [p.baseUrl], scopes_supported: ['network', 'people'],
      bearer_methods_supported: ['header'], resource_name: 'Unlinked', resource_documentation: `${p.baseUrl}/agents` })
  }
  const as = await (await p.go('/.well-known/oauth-authorization-server')).json()
  assert.equal(as.issuer, p.baseUrl)
  assert.equal(as.authorization_endpoint, `${p.baseUrl}/oauth/authorize`)
  assert.equal(as.token_endpoint, `${p.baseUrl}/oauth/token`)
  assert.equal(as.registration_endpoint, `${p.baseUrl}/oauth/register`)
  assert.equal(as.revocation_endpoint, `${p.baseUrl}/oauth/revoke`)
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none'])
  assert.deepEqual(as.grant_types_supported, ['authorization_code'])
  assert.equal(as.client_id_metadata_document_supported, true)
  assert.equal(as.authorization_response_iss_parameter_supported, true)
  const oidc = await p.go('/.well-known/openid-configuration')
  assert.equal(oidc.status, 404)
  assert.equal((await oidc.json()).error, 'not_found')
  const preflight = await p.go('/oauth/token', { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/)

  const challenge = `Bearer resource_metadata="${p.baseUrl}/.well-known/oauth-protected-resource/mcp", scope="network people"`
  const bare = await p.go('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(bare.status, 401)
  assert.equal(bare.headers.get('www-authenticate'), challenge)
  const asGet = await p.go('/mcp')
  assert.equal(asGet.status, 401, 'unauthenticated GET is challenged too')
  const forged = await p.go('/mcp', { method: 'POST', headers: { Authorization: 'Bearer not-a-grant', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forged.status, 401)
  assert.equal(forged.headers.get('www-authenticate'), `Bearer error="invalid_token", resource_metadata="${p.baseUrl}/.well-known/oauth-protected-resource/mcp", scope="network people"`)
})

test('dynamic registration accepts only connector callbacks and loopback, always as a public client', async t => {
  const p = await pilot(t)
  const ok = await p.register({ client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'] })
  assert.equal(ok.status, 201)
  const client = await ok.json()
  assert.match(client.client_id, /^ulc1\./)
  assert.equal(client.token_endpoint_auth_method, 'none')
  assert.equal(client.client_secret, undefined)
  assert.deepEqual(client.redirect_uris, [CLAUDE])
  assert.equal((await p.register({ redirect_uris: ['http://localhost:6274/oauth/callback', 'http://127.0.0.1/callback', 'https://chatgpt.com/connector_platform_oauth_redirect'] })).status, 201)
  for (const uris of [['https://evil.example/callback'], ['https://claude.ai.evil.example/api/mcp/auth_callback'], ['https://claude.ai/api/mcp/auth_callback?x=1'], ['javascript:alert(1)'],
    ['http://localhost.evil.example/cb'], ['http://user@localhost/cb'], ['custom-app://callback'], [], ['http://10.0.0.1/cb'], Array(9).fill(CLAUDE)]) {
    const refused = await p.register({ redirect_uris: uris })
    assert.equal(refused.status, 400, JSON.stringify(uris))
    assert.match((await refused.json()).error, /^invalid_(redirect_uri|client_metadata)$/)
  }
  assert.equal((await p.register({ redirect_uris: [CLAUDE], response_types: ['token'] })).status, 400)
  assert.equal((await p.go('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 400)
  assert.equal((await p.go('/oauth/register')).status, 405)

  // A tampered client_id (same shape, foreign redirect) is refused at authorize without a redirect.
  const [, payload] = client.client_id.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), r: ['http://127.0.0.1/steal'] })).toString('base64url')
  const forged = await p.go(`/oauth/authorize?${authorizeQuery(client.client_id.replace(payload, forgedPayload), { redirect_uri: 'http://127.0.0.1/steal' })}`)
  assert.equal(forged.status, 400)
  assert.equal(forged.headers.get('location'), null)
})

test('sign-in, consent, PKCE code exchange, scoped tools, Settings listing and revocation', async t => {
  const p = await pilot(t)
  const client = await (await p.register({ client_name: 'Claude', redirect_uris: [CLAUDE] })).json()
  const query = authorizeQuery(client.client_id, { resource: `${p.baseUrl}/mcp` })

  // Unregistered redirect and missing PKCE never reach consent.
  const badRedirect = await p.go(`/oauth/authorize?${authorizeQuery(client.client_id, { redirect_uri: 'https://claude.com/api/mcp/auth_callback', resource: `${p.baseUrl}/mcp` })}`)
  assert.equal(badRedirect.status, 400)
  assert.equal(badRedirect.headers.get('location'), null)
  const noPkce = new URLSearchParams(query); noPkce.delete('code_challenge')
  const pkceError = new URL((await p.go(`/oauth/authorize?${noPkce}`)).headers.get('location'))
  assert.equal(pkceError.origin + pkceError.pathname, CLAUDE)
  assert.equal(pkceError.searchParams.get('error'), 'invalid_request')
  assert.equal(pkceError.searchParams.get('state'), 'st-1')
  assert.equal(pkceError.searchParams.get('iss'), p.baseUrl)
  const wrongResource = new URL((await p.go(`/oauth/authorize?${authorizeQuery(client.client_id, { resource: 'https://other.example/mcp' })}`)).headers.get('location'))
  assert.equal(wrongResource.searchParams.get('error'), 'invalid_target')

  // Signed out: the request survives sign-in and returns to consent.
  const anonymous = await p.go(`/oauth/authorize?${query}`)
  assert.equal(anonymous.status, 303)
  const next = new URL(anonymous.headers.get('location'), p.endpoint).searchParams.get('next')
  assert.equal(next, `/oauth/authorize?${query}`)
  const { cookie, location } = await p.signIn(next)
  assert.equal(location, next)

  const consentPage = async () => {
    const response = await p.go(location, { headers: { Cookie: cookie } })
    assert.equal(response.status, 200)
    return { csp: response.headers.get('content-security-policy'), text: await response.text() }
  }
  const consent = await consentPage()
  assert.match(consent.text, /Connect Claude to Unlinked/)
  assert.match(consent.text, /Read your own Unlinked account and network/)
  assert.match(consent.text, /published People index/)
  assert.match(consent.text, /member@example\.invalid/)
  assert.match(consent.csp, /form-action 'self' https:\/\/claude\.ai;/)
  assert.match(consent.csp, /frame-ancestors 'none'/)
  const decide = async (decision, params = hiddenParams(consent.text), extraHeaders = {}) => p.go('/oauth/authorize', { method: 'POST',
    headers: { Cookie: cookie, Origin: p.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams([['csrf', csrfFrom(consent.text)], ['decision', decision], ...params]) })
  const approveCode = async (params) => {
    const response = await decide('allow', params)
    assert.equal(response.status, 303)
    const target = new URL(response.headers.get('location'))
    assert.equal(target.origin + target.pathname, CLAUDE)
    assert.equal(target.searchParams.get('state'), 'st-1')
    assert.equal(target.searchParams.get('iss'), p.baseUrl)
    return target.searchParams.get('code')
  }

  // Consent is bound to the session and its CSRF token.
  assert.equal((await decide('allow', hiddenParams(consent.text), { Origin: 'https://evil.example' })).status, 403)
  const noCsrf = await p.go('/oauth/authorize', { method: 'POST', headers: { Cookie: cookie, Origin: p.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['decision', 'allow'], ...hiddenParams(consent.text)]) })
  assert.notEqual(noCsrf.status, 303)

  const denied = new URL((await decide('deny')).headers.get('location'))
  assert.equal(denied.searchParams.get('error'), 'access_denied')
  assert.equal(denied.searchParams.get('iss'), p.baseUrl)

  const verifier = 'v'.repeat(64)
  const exchange = (code, overrides = {}) => p.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE, resource: `${p.baseUrl}/mcp`, ...overrides })
  const wrongVerifier = await approveCode()
  assert.equal((await (await exchange(wrongVerifier, { code_verifier: 'w'.repeat(64) })).json()).error, 'invalid_grant')
  assert.equal((await (await exchange(wrongVerifier)).json()).error, 'invalid_grant', 'a code is single-use even after a failed exchange')
  assert.equal((await (await exchange(await approveCode(), { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).json()).error, 'invalid_grant')
  const otherClient = await (await p.register({ redirect_uris: [CLAUDE] })).json()
  assert.equal((await (await exchange(await approveCode(), { client_id: otherClient.client_id })).json()).error, 'invalid_grant')
  assert.equal((await (await exchange(await approveCode(), { resource: 'https://other.example/mcp' })).json()).error, 'invalid_target')
  assert.equal((await (await p.token({ grant_type: 'refresh_token', refresh_token: 'x', client_id: client.client_id })).json()).error, 'unsupported_grant_type')
  assert.equal(p.graph.live().length, 0, 'failed exchanges mint nothing')

  const code = await approveCode()
  const issued = await exchange(code)
  assert.equal(issued.status, 200)
  assert.equal(issued.headers.get('cache-control'), 'no-store')
  const body = await issued.json()
  assert.deepEqual(Object.keys(body).sort(), ['access_token', 'scope', 'token_type'])
  assert.equal(body.token_type, 'Bearer')
  assert.equal(body.scope, 'network people')
  assert.equal((await (await exchange(code)).json()).error, 'invalid_grant', 'replayed code')
  const fullTools = await mcpTools(p.endpoint, body.access_token)
  assert.ok(fullTools.includes('unlinked_search_everyone'))
  assert.ok(fullTools.includes('unlinked_search_network'))
  const [record] = p.graph.live()
  assert.equal(record.payload.connection.app, 'Claude')
  assert.equal(record.payload.connection.redirectHost, 'claude.ai')
  assert.equal(record.payload.connection.clientKey, createHash('sha256').update(client.client_id).digest('hex'))
  assert.equal(JSON.stringify(p.graph.resources).includes(body.access_token), false)
  assert.equal(JSON.stringify(p.auditEvents).includes(body.access_token), false)
  assert.ok(p.auditEvents.some(event => event.event === 'oauth_connection_granted' && event.app === 'Claude'))

  // A narrower consent gets exactly the narrower tool list.
  const narrowConsent = hiddenParams(consent.text); narrowConsent.set('scope', 'network')
  const narrow = await (await exchange(await approveCode(narrowConsent))).json()
  assert.equal(narrow.scope, 'network')
  const narrowTools = await mcpTools(p.endpoint, narrow.access_token)
  assert.equal(narrowTools.includes('unlinked_search_everyone'), false)
  assert.ok(narrowTools.includes('unlinked_search_network'))

  // Settings: the connection is listed separately and the copyable credential is not the OAuth token.
  const settings = await (await p.go('/settings', { headers: { Cookie: cookie } })).text()
  assert.match(settings, /Claude and ChatGPT: paste this address, then sign in/)
  assert.match(settings, /Connected apps/)
  assert.equal((settings.match(/<b>Claude<\/b> · connected/g) ?? []).length, 2)
  assert.equal(settings.includes(body.access_token), false)
  assert.match(settings, /Use a private credential instead/)
  assert.equal(p.graph.live().length, 3, 'two connections plus the automatic credential')

  // Regenerating the copyable credential leaves connected apps connected.
  const regenerated = await p.go('/setup-account', { method: 'POST', headers: { Cookie: cookie, Origin: p.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: csrfFrom(settings) }) })
  assert.equal(regenerated.status, 200)
  assert.ok((await mcpTools(p.endpoint, body.access_token)).length)

  // Disconnect in Settings stops the app immediately and does not turn off the copyable credential.
  const connectionId = p.graph.live().find(x => x.payload.connection && x.payload.scope === 'owner_network_and_public').sourceId
  assert.equal((await p.go('/revoke-account', { method: 'POST', headers: { Cookie: cookie, Origin: p.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: csrfFrom(settings), grantId: connectionId }) })).status, 303)
  const dead = await p.go('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${body.access_token}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(dead.status, 401)
  assert.match(dead.headers.get('www-authenticate'), /error="invalid_token"/)
  assert.equal(p.graph.live().filter(x => !x.payload.connection).length, 1)

  // RFC 7009 revocation works only for the client the token was issued to.
  const foreign = await p.go('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: narrow.access_token, client_id: otherClient.client_id }) })
  assert.equal(foreign.status, 200)
  assert.ok((await mcpTools(p.endpoint, narrow.access_token)).length, 'another client cannot revoke it')
  const own = await p.go('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: narrow.access_token, client_id: client.client_id }) })
  assert.equal(own.status, 200)
  assert.equal((await p.go('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${narrow.access_token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal(p.graph.live().length, 1, 'only the copyable credential remains')
})

test('the official MCP SDK client completes discovery, registration, PKCE and the token exchange', async t => {
  const p = await pilot(t)
  const { cookie } = await p.signIn()
  // The runtime believes it is served at https://127.0.0.1:<port>; route that to plain HTTP for the test.
  const fetchFn = (url, init) => fetch(String(url).replace(p.baseUrl, p.endpoint), init)
  let saved = {}, authorizationUrl = null
  const provider = {
    get redirectUrl() { return 'http://127.0.0.1:43123/oauth/callback' },
    get clientMetadata() { return { client_name: 'SDK interop', redirect_uris: ['http://127.0.0.1:43123/oauth/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } },
    clientInformation: () => saved.client, saveClientInformation: value => { saved.client = value },
    tokens: () => saved.tokens, saveTokens: value => { saved.tokens = value },
    redirectToAuthorization: url => { authorizationUrl = url },
    saveCodeVerifier: value => { saved.verifier = value }, codeVerifier: () => saved.verifier,
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${p.baseUrl}/mcp`), { authProvider: provider, fetch: fetchFn })
  await assert.rejects(new Client({ name: 'sdk', version: '1.0.0' }).connect(transport), UnauthorizedError)
  assert.ok(authorizationUrl, 'the SDK reached the authorization endpoint')
  assert.equal(authorizationUrl.origin, p.baseUrl)
  assert.equal(authorizationUrl.searchParams.get('resource'), `${p.baseUrl}/mcp`)
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.match(saved.client.client_id, /^ulc1\./)

  const consent = await (await p.go(authorizationUrl.pathname + authorizationUrl.search, { headers: { Cookie: cookie } })).text()
  assert.match(consent, /Connect An app on this computer to Unlinked/)
  assert.match(consent, /it calls itself “SDK interop”/)
  assert.match(consent, /Only allow this if you started/)
  const approved = await p.go('/oauth/authorize', { method: 'POST', headers: { Cookie: cookie, Origin: p.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['csrf', csrfFrom(consent)], ['decision', 'allow'], ...hiddenParams(consent)]) })
  const callback = new URL(approved.headers.get('location'))
  assert.equal(callback.origin, 'http://127.0.0.1:43123')
  await transport.finishAuth(callback.searchParams.get('code'))
  assert.equal(saved.tokens.token_type.toLowerCase(), 'bearer')

  const client = new Client({ name: 'sdk', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${p.baseUrl}/mcp`), { authProvider: provider, fetch: fetchFn }))
  const names = (await client.listTools()).tools.map(tool => tool.name)
  assert.ok(names.includes('unlinked_search_network'))
  assert.ok(names.includes('unlinked_whoami'))
  await client.close()
})

test('client metadata documents are fetched only from allow-listed hosts and validated; codes expire', async () => {
  let clock = Date.now(), fetches = []
  const claudeDocument = { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_name: 'Claude', redirect_uris: [CLAUDE, 'https://evil.example/cb'], token_endpoint_auth_method: 'none' }
  const documents = new Map([[claudeDocument.client_id, claudeDocument],
    ['https://claude.ai/oauth/claude-code-client-metadata', { client_id: 'https://claude.ai/oauth/claude-code-client-metadata', client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] }],
    ['https://chatgpt.com/oauth/mismatch.json', { client_id: 'https://chatgpt.com/oauth/other.json', client_name: 'x', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }]])
  const issuedGrants = []
  const server = createOAuthServer({ origin: 'https://www.unlinked.ai', clientKey: randomBytes(32), publicSearchEnabled: true, now: () => clock,
    issueGrant: async (owner, jti, options) => { issuedGrants.push({ owner, options }); return { accessToken: 'token-value', grantId: 'g'.repeat(64) } },
    revokeConnectionToken: async () => false,
    fetchImpl: async (url, init) => { fetches.push(url); assert.equal(init.redirect, 'error'); const doc = documents.get(url); return doc ? new Response(JSON.stringify(doc), { status: 200 }) : new Response('nope', { status: 404 }) } })
  const params = (clientId, redirect, extra = {}) => new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: b64sha('x'.repeat(50)), code_challenge_method: 'S256', resource: 'https://www.unlinked.ai/mcp', ...extra })

  const ok = await server.readAuthorization(params(claudeDocument.client_id, CLAUDE))
  assert.equal(ok.ok, true)
  assert.equal(ok.request.app, 'Claude')
  assert.equal((await server.readAuthorization(params(claudeDocument.client_id, 'https://evil.example/cb'))).ok, false, 'document redirect outside the allow list is dropped')
  await server.readAuthorization(params(claudeDocument.client_id, CLAUDE))
  assert.equal(fetches.length, 1, 'documents are cached')
  // Claude Code: loopback redirect with a request-time port.
  const code = await server.readAuthorization(params('https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:51234/callback'))
  assert.equal(code.ok, true)
  assert.equal(code.request.loopback, true)
  assert.equal((await server.readAuthorization(params('https://chatgpt.com/oauth/mismatch.json', 'https://chatgpt.com/connector_platform_oauth_redirect'))).ok, false)
  const before = fetches.length
  for (const id of ['https://evil.example/client.json', 'http://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai:8443/x', 'https://169.254.169.254/latest', 'https://claude.ai/']) assert.equal((await server.readAuthorization(params(id, CLAUDE))).ok, false)
  assert.equal(fetches.length, before, 'non-allow-listed client ids are never fetched')

  // Codes are single-use and expire after 60 seconds.
  const location = new URL(server.approve(ok.request, { ownerId: 'o', userId: 'u' }))
  clock += 61000
  const handled = await new Promise(resolve => {
    const chunks = []
    const request = Object.assign((async function* () { yield Buffer.from(new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), code_verifier: 'x'.repeat(50), client_id: claudeDocument.client_id, redirect_uri: CLAUDE }).toString()) })(),
      { method: 'POST', url: '/oauth/token', headers: { host: 'www.unlinked.ai', 'content-type': 'application/x-www-form-urlencoded' } })
    const response = { setHeader() {}, writeHead(status) { this.status = status; return this }, end(value) { chunks.push(value); resolve({ status: this.status, body: JSON.parse(chunks.join('')) }) } }
    server.handle(request, response)
  })
  assert.equal(handled.status, 400)
  assert.equal(handled.body.error, 'invalid_grant')
  assert.equal(issuedGrants.length, 0)
})

test('redirect policy table', () => {
  assert.equal(redirectPolicy(CLAUDE).app, 'Claude')
  assert.equal(redirectPolicy('https://claude.com/api/mcp/auth_callback').app, 'Claude')
  assert.equal(redirectPolicy('https://chatgpt.com/connector_platform_oauth_redirect').app, 'ChatGPT')
  assert.equal(redirectPolicy('https://chatgpt.com/connector/oauth/AbC_123-x').app, 'ChatGPT')
  assert.equal(redirectPolicy('http://[::1]:9000/cb').loopback, true)
  for (const uri of ['https://chatgpt.com/connector/oauth/../../x', 'https://chatgpt.com/other', 'http://localhost:6274/cb#frag', 'http://LOCALHOST/cb', 'https://localhost/cb', 'http://127.0.0.2/cb', 'http://localhost/a b']) assert.equal(redirectPolicy(uri), null, uri)
})
