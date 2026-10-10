import { createHash, timingSafeEqual } from 'node:crypto'

export const MESSAGING_PATH = '/api/messaging/v1/recipient'
export const IDEAFLOW_ISSUER = 'https://id.ideaflow.app/api/auth'

// Only the published profile's live owner can identify its inbox. Public names,
// imported addresses and caller-supplied subjects never establish ownership.
export function createMessagingResolver({ readPublishedSnapshot, accountForProfile, identityForOwner }) {
  return async profileId => {
    const snapshot = await readPublishedSnapshot()
    if (snapshot?.state !== 'published' || snapshot.complete !== true) throw Error('publication_unavailable')
    const profile = snapshot.profiles.find(value => value.id === profileId)
    if (!profile) return { status: 'unavailable' }
    const owner = await accountForProfile(profileId)
    if (!owner) return { status: 'unclaimed', name: profile.name }
    const identity = await identityForOwner(owner)
    if (!identity || identity.issuer !== IDEAFLOW_ISSUER || typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 512 || /[\x00-\x1f\x7f]/.test(identity.subject)) return { status: 'unavailable' }
    return { status: 'member', name: profile.name, identity: { issuer: identity.issuer, subject: identity.subject } }
  }
}

// A dedicated server credential: never an agent grant or browser credential.
// No CORS, no redirects, no identity in URLs, no logging of request/response.
export function createMessagingHandler({ origin, secret, resolveRecipient }) {
  if (secret !== undefined && (typeof secret !== 'string' || secret.length < 32 || typeof resolveRecipient !== 'function')) throw Error('messaging_configuration_required')
  const expected = createHash('sha256').update(secret ?? '').digest()
  let window = 0, requests = 0
  return async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)) }
    if (!secret) return send(503, { error: 'messaging_unavailable' })
    if (request.headers.host !== new URL(origin).host || request.headers.origin) return send(403, { error: 'forbidden' })
    const header = request.headers.authorization ?? ''
    const presented = createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest()
    if (!timingSafeEqual(expected, presented)) return send(401, { error: 'unauthorized' })
    if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' })
    if (Date.now() - window >= 60000) { window = Date.now(); requests = 0 }
    if (++requests > 120) return send(429, { error: 'rate_limited' })
    try {
      const parts = []; let length = 0
      for await (const part of request) { length += part.length; if (length > 2048) return send(413, { error: 'body_too_large' }); parts.push(part) }
      let body
      try { body = JSON.parse(Buffer.concat(parts).toString()) } catch { return send(400, { error: 'invalid_input' }) }
      if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'profileId') || typeof body.profileId !== 'string' || !body.profileId || body.profileId.length > 160 || /[\s/\\?#\x00-\x1f\x7f]/.test(body.profileId) || ['.', '..'].includes(body.profileId)) return send(400, { error: 'invalid_input' })
      return send(200, await resolveRecipient(body.profileId))
    } catch { return send(503, { error: 'messaging_unavailable' }) }
  }
}

// The session's owner is resolved from the HttpOnly Unlinked cookie by the
// browser handler. Names/email from the browser never select an identity.
export function createMessagingSession({ secret, identityForOwner, fetchImpl = fetch }) {
  return async ({ owner, displayName }) => {
    if (!secret || secret.length < 32) throw Error('messaging_unavailable')
    const identity = await identityForOwner(owner)
    if (!identity || identity.issuer !== IDEAFLOW_ISSUER || typeof identity.subject !== 'string' || !identity.subject) throw Error('messaging_unavailable')
    const response = await fetchImpl('https://chat.ideaflow.app/api/unlinked/session', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ issuer: identity.issuer, subject: identity.subject, name: String(displayName || 'Unlinked member').slice(0, 160) }),
    })
    if (!response.ok) throw Error('messaging_unavailable')
    const text = await response.text()
    if (text.length > 12000) throw Error('messaging_unavailable')
    const value = JSON.parse(text)
    if (typeof value?.token !== 'string' || !value.token || typeof value?.user?.userId !== 'string') throw Error('messaging_unavailable')
    return value
  }
}
