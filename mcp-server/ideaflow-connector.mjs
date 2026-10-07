import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION, ACCOUNT_WRITE_SCOPE } from './account-grants.mjs'
import { createAccountHostedHandler } from './account-hosted.mjs'

export function createAssertionVerifier(secret) {
  const seen = new Map()
  return (token, body) => {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || token.length > 8192) return null
    try {
      const parts = token.split('.')
      if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null
      const [header, payload, signature] = parts
      const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest(), provided = Buffer.from(signature, 'base64url')
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
      const h = JSON.parse(Buffer.from(header, 'base64url')), p = JSON.parse(Buffer.from(payload, 'base64url')), now = Math.floor(Date.now()/1000)
      if (h.alg !== 'HS256' || h.crit || p.iss !== 'https://id.ideaflow.app/connector' || p.aud !== 'https://www.unlinked.ai/mcp' ||
        p.identity_issuer !== 'https://id.ideaflow.app/api/auth' || typeof p.sub !== 'string' || !p.sub || p.sub.length > 200 ||
        typeof p.jti !== 'string' || !p.jti || p.jti.length > 200 || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) ||
        p.iat > now+5 || p.exp <= now || p.exp <= p.iat || p.exp-p.iat > 60 || typeof p.scope !== 'string' || !p.scope ||
        !p.scope.split(' ').every(scope => ['unlinked:read','unlinked:write'].includes(scope)) || !p.scope.split(' ').includes('unlinked:read') ||
        p.body_sha256 !== createHash('sha256').update(body).digest('hex')) return null
      for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id)
      if (seen.has(p.jti) || seen.size >= 10000) return null
      seen.set(p.jti, p.exp)
      return p
    } catch { return null }
  }
}

/** The gateway owns consent/revocation; each call carries a new 60s assertion.
 * No stored personal keys, account creation, or email matching occurs here. */
export function createIdeaflowConnectorHandler({ secret, resolveOwner, getBackend, complete, readPublishedSnapshot, origin, service }) {
  const verify = createAssertionVerifier(secret), authenticated = new WeakMap()
  const authenticateGrant = async request => {
    const state = authenticated.get(request)
    if (!state) return null
    const owner = await resolveOwner({ issuer: state.identity.identity_issuer, subject: state.identity.sub })
    if (!owner || owner.ownerId !== state.grant.ownerId || owner.userId !== state.grant.userId) return null
    await getBackend(owner) // live owner authorization; never trust assertion fields as local ids
    return state.grant
  }
  const hosted = createAccountHostedHandler({ authenticateGrant, getBackend, complete, readPublishedSnapshot, origin, service })
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc:'2.0', id:null, error:{ code:-32001, message } })) }
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) return fail(503, 'Unified connector is not configured')
    if (request.method !== 'POST') return fail(405, 'POST required')
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(400, 'JSON required')
    try {
    const chunks = []; let length = 0
    for await (const chunk of request) { length += chunk.length; if (length > 1024*1024) return fail(413, 'Request too large'); chunks.push(chunk) }
    const bytes = Buffer.concat(chunks)
    const identity = verify(request.headers.authorization?.replace(/^Bearer /, '') ?? '', bytes)
    if (!identity) return fail(401, 'Invalid connector assertion')
    let body
    try { body = JSON.parse(bytes.toString('utf8')) } catch { return fail(400, 'Invalid JSON') }
    const owner = await resolveOwner({ issuer: identity.identity_issuer, subject: identity.sub })
    if (!owner) return fail(409, 'account_link_required')
    const publicEnabled = typeof readPublishedSnapshot === 'function'
    const write = identity.scope.split(' ').includes('unlinked:write')
    if (write && !publicEnabled) return fail(403, 'Connection actions unavailable')
    const scope = write ? ACCOUNT_WRITE_SCOPE : publicEnabled ? 'owner_network_and_public' : 'owner_network'
    const grant = { ...owner, grantId:`ideaflow:${identity.jti}`, version:CURRENT_ACCOUNT_GRANT_VERSION, scope, tools:[...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] }
    authenticated.set(request, { identity, grant })
    return await hosted(request, response, body)
    } catch {
      if (!response.headersSent) return fail(503, 'Unlinked connector is temporarily unavailable')
      response.end()
    }
  }
}
