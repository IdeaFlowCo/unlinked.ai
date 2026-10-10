import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { connectOpenChatSocket, OPENCHAT_SOCKET_URL } from './openchat-socket.mjs'
import { parseUnlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'

// Unlinked-native Messages over OpenChat (docs/openchat-message.md).
//
// OpenChat is the only message store. The browser talks only to this origin;
// this module holds each member's short-lived embedded OpenChat credential on
// the server, relays a fixed set of REST calls with validated ids and
// re-encoded bodies, projects every upstream response through a whitelist
// (never an email or legacy email field), and bridges OpenChat's socket events
// to Server-Sent Events. Bodies and credentials are never logged.

export const OPENCHAT_ORIGIN = 'https://chat.ideaflow.app'
// OpenChat's own reaction allowlist (chat.ts ALLOWED_EMOJI); anything else is rejected there.
export const REACTION_EMOJI = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏'])
export const MAX_CONTENT = 8000
// OpenChat attachments are capability URLs in one public bucket (DECISIONS.md 16).
// Only this exact grammar is ever fetched or shown, through /messages/api/file.
export const ATTACHMENT_URL = /^https:\/\/storage\.googleapis\.com\/openchat-attachments\/attachments\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9._-]{1,128}$/
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/m4a', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const FILE_MAX_BYTES = 20 * 1024 * 1024, UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const fileSrc = url => typeof url === 'string' && ATTACHMENT_URL.test(url) ? `/messages/api/file?u=${encodeURIComponent(url)}` : null
const ID = /^[A-Za-z0-9_-]{1,80}$/
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PRESENCE = new Set(['available', 'away', 'busy', 'offline'])
const CREDENTIAL_FRESH_MS = 8 * 60000, CREDENTIAL_FAILURE_MS = 5000
const BADGE_FRESH_MS = 15000, BADGE_FAILURE_MS = 60000
const UPSTREAM_TIMEOUT_MS = 8000, UPSTREAM_MAX_BYTES = 4 * 1024 * 1024, BODY_MAX_BYTES = 64 * 1024

export const validId = value => typeof value === 'string' && ID.test(value)
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
const bool = value => value === true
export const iso = value => {
  if (typeof value !== 'string' || value.length > 64) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const array = value => Array.isArray(value) ? value : []

// ── Projection: whitelist every field that reaches the browser ──────────────

export function projectUser(user) {
  if (!user || !validId(user.id)) return null
  const presence = user.presenceStatus === 'invisible' ? 'offline' : PRESENCE.has(user.presenceStatus) ? user.presenceStatus : 'offline'
  return { id: user.id, name: text(user.name, 160).trim() || 'OpenChat member', presence, lastSeenAt: iso(user.lastSeenAt), isBot: bool(user.isBot) }
}

const mute = value => value === 'always' ? 'always' : iso(value)

export function projectConversation(value) {
  if (!value || !validId(value.id)) return null
  const last = value.lastMessage && validId(value.lastMessage.id) ? value.lastMessage : null
  return {
    id: value.id,
    type: value.type === 'direct' ? 'direct' : 'group',
    title: text(value.title, 160) || null,
    lastMessageAt: iso(value.lastMessageAt) ?? iso(last?.createdAt) ?? iso(value.createdAt),
    lastMessage: last ? { id: last.id, senderId: validId(last.senderId) ? last.senderId : null, content: text(last.content, 280), createdAt: iso(last.createdAt) } : null,
    participants: array(value.participants).map(entry => { const user = projectUser(entry?.user); return user ? { ...user, role: entry.role === 'owner' ? 'owner' : 'member' } : null }).filter(Boolean).slice(0, 200),
    unreadCount: count(value.unreadCount),
    lastReadAt: iso(value.lastReadAt),
    mutedUntil: mute(value.mutedUntil),
    containsBot: bool(value.containsBot),
  }
}

export const projectReactions = (reactions, { withMine = true } = {}) => array(reactions)
  .filter(value => typeof value?.emoji === 'string' && value.emoji.length <= 16 && count(value.count) > 0)
  .map(value => ({ emoji: value.emoji, count: count(value.count), ...(withMine ? { byMe: bool(value.byMe) } : {}) })).slice(0, 32)

const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && value.length <= 2048 ? url.href : null } catch { return null } }

export function projectMessage(value) {
  if (!value || !validId(value.id) || !validId(value.conversationId)) return null
  const deletedAt = iso(value.deletedAt)
  const sender = value.sender && validId(value.sender.id) ? { id: value.sender.id, name: text(value.sender.name, 160).trim() || 'OpenChat member' } : null
  const reply = value.replyTo && validId(value.replyTo.id) ? value.replyTo : null
  return {
    id: value.id,
    conversationId: value.conversationId,
    senderId: validId(value.senderId) ? value.senderId : sender?.id ?? null,
    sender,
    content: deletedAt ? '' : text(value.content, 20000),
    messageType: value.messageType === 'text' || !value.messageType ? 'text' : 'other',
    createdAt: iso(value.createdAt),
    editedAt: iso(value.editedAt),
    deletedAt,
    replyToId: validId(value.replyToId) ? value.replyToId : null,
    replyTo: reply ? { id: reply.id, senderId: validId(reply.senderId) ? reply.senderId : null, senderName: text(reply.senderName ?? reply.sender?.name, 160) || null, content: text(reply.content, 200) } : null,
    reactions: projectReactions(value.reactions),
    // Attachment URLs are served in phase 3 through a restricted same-origin route.
    attachments: deletedAt ? [] : array(value.attachments).filter(item => item && typeof item.mimeType === 'string').slice(0, 10)
      .map(item => { const mimeType = text(item.mimeType, 100), src = FILE_TYPES.has(mimeType) ? fileSrc(item.url) : null; return { mimeType, name: text(item.name ?? item.filename, 200) || null, size: count(item.size ?? item.sizeBytes) || null, ...(src ? { src } : {}) } }),
    linkPreviews: deletedAt ? [] : array(value.linkPreviews).map(item => { const url = httpsUrl(item?.url); return url ? { url, title: text(item.title, 300) || null, description: text(item.description, 500) || null, siteName: text(item.siteName, 120) || null } : null }).filter(Boolean).slice(0, 3),
  }
}

const projectReadMap = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([key]) => validId(key)).slice(0, 200).map(([key, at]) => [key, iso(at)]))
const projectOnlineMap = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([key]) => validId(key)).slice(0, 200).map(([key, online]) => [key, bool(online)]))

// ── Errors ───────────────────────────────────────────────────────────────────

export class MessagingError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const unavailable = () => new MessagingError(503, 'messaging_unavailable')
const invalid = () => new MessagingError(400, 'invalid_input')

/**
 * createMessagingProxy({ createMessagingSession }) → { handle, openProfile, unreadTotal, close }
 * `createMessagingSession(session)` is the existing confidential exchange in
 * messaging.mjs: it returns `{ token, user: { userId } }` for the session's live owner.
 */
export function createMessagingProxy({ createMessagingSession, apiOrigin = OPENCHAT_ORIGIN, socketUrl = OPENCHAT_SOCKET_URL, fetchImpl = fetch, connectSocket = connectOpenChatSocket, now = Date.now, pollMs = 4000, heartbeatMs = 25000, streamLifetimeMs = 30 * 60000, lingerMs = 20000, maxLinks = 500, isSessionLive = () => true } = {}) {
  const credentials = new Map(), badges = new Map(), budgets = new Map(), issued = new Map(), links = new Map(), uploads = new Map()
  const ownerKey = session => session?.owner?.ownerId
  const trim = (map, limit) => { while (map.size > limit) map.delete(map.keys().next().value) }

  // One embedded credential per member, minted through the existing exchange and
  // reused for 8 of its 10 minutes. Concurrent callers share one mint; a failure
  // is remembered briefly so a broken binding cannot hammer OpenChat.
  async function credentialFor(session, { fresh = false } = {}) {
    const key = ownerKey(session)
    if (!key || typeof createMessagingSession !== 'function') throw unavailable()
    let entry = credentials.get(key)
    if (entry?.pending) return entry.pending
    if (entry && !fresh && entry.token && now() - entry.at < CREDENTIAL_FRESH_MS) return entry
    if (entry && !entry.token && now() - entry.failedAt < CREDENTIAL_FAILURE_MS) throw unavailable()
    entry = { ...entry, pending: null }
    credentials.set(key, entry)
    entry.pending = (async () => {
      try {
        const value = await createMessagingSession(session)
        if (typeof value?.token !== 'string' || !value.token || !validId(value?.user?.userId)) throw unavailable()
        Object.assign(entry, { token: value.token, userId: value.user.userId, at: now(), failedAt: 0 })
        return entry
      } catch { Object.assign(entry, { token: null, failedAt: now() }); throw unavailable() } finally { entry.pending = null }
    })()
    trim(credentials, 5000)
    return entry.pending
  }

  // One upstream REST call. Ids are validated before they reach the path and
  // encoded anyway; a 401 refreshes the credential once.
  async function upstream(session, method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await credentialFor(session, { fresh: attempt > 0 })
      let response
      try {
        response = await fetchImpl(apiOrigin + path, {
          method, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch { throw unavailable() }
      if (response.status === 401 && attempt === 0) { await response.body?.cancel().catch(() => {}); continue }
      const raw = await response.text().catch(() => { throw unavailable() })
      if (raw.length > UPSTREAM_MAX_BYTES) throw unavailable()
      if (!response.ok) {
        if (response.status === 404) throw new MessagingError(404, 'not_found')
        if (response.status === 400) throw invalid()
        if (response.status === 403) throw new MessagingError(403, 'forbidden')
        if (response.status === 429) throw new MessagingError(429, 'rate_limited')
        throw unavailable()
      }
      try { return { status: response.status, value: raw ? JSON.parse(raw) : null, credential } } catch { throw unavailable() }
    }
    throw unavailable()
  }

  // Per member and minute: reads, writes, and typing pings are counted separately.
  function spend(session, kind) {
    const key = `${ownerKey(session)}:${kind}`, limit = { read: 300, write: 60, typing: 40, file: 600, upload: 20 }[kind]
    const budget = budgets.get(key)
    if (!budget || now() - budget.at >= 60000) { budgets.set(key, { at: now(), used: 1 }); trim(budgets, 20000); return }
    if (++budget.used > limit) throw new MessagingError(429, 'rate_limited')
  }

  // Upstream message ids are derived per member, so a retry is idempotent and a
  // member cannot direct OpenChat's MERGE at a message id they have only seen.
  const derivedId = (userId, clientId) => `ul_${createHash('sha256').update(`${userId}:${clientId}`).digest('hex').slice(0, 32)}`
  const remember = (key, id, clientId) => { let map = issued.get(key); if (!map) { map = new Map(); issued.set(key, map); trim(issued, 5000) } map.set(id, clientId); trim(map, 300) }
  const withClientId = (key, message) => { const clientId = issued.get(key)?.get(message.id); return clientId ? { ...message, clientId } : message }

  async function listConversations(session) {
    const { value, credential } = await upstream(session, 'GET', '/api/chat/conversations')
    return { me: { id: credential.userId }, conversations: array(value).map(projectConversation).filter(Boolean).slice(0, 500) }
  }

  async function listMessages(session, conversationId, before) {
    const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) })
    const { value } = await upstream(session, 'GET', `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages?${query}`)
    return { messages: array(value?.messages).map(projectMessage).filter(Boolean).map(message => withClientId(ownerKey(session), message)), hasMore: bool(value?.hasMore) }
  }

  async function send(session, conversationId, input) {
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    // Attachments are only uploads this proxy made for this member (uploadAttachment).
    if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 4 || input.attachments.some(key => typeof key !== 'string'))) throw invalid()
    const mine = uploads.get(ownerKey(session))
    const attachments = (input.attachments ?? []).map(key => mine?.get(key))
    if (attachments.some(item => !item)) throw invalid()
    if ((!content && !attachments.length) || content.length > MAX_CONTENT || !CLIENT_ID.test(input.clientId ?? '') || (input.replyToId !== undefined && input.replyToId !== null && !validId(input.replyToId))) throw invalid()
    const credential = await credentialFor(session)
    const id = derivedId(credential.userId, input.clientId)
    remember(ownerKey(session), id, input.clientId)
    const { value } = await upstream(session, 'POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`, { content, id, ...(input.replyToId ? { replyToId: input.replyToId } : {}), ...(attachments.length ? { attachments: attachments.map(({ url, mimeType, name, size }) => ({ url, mimeType, name, size })) } : {}) })
    invalidateBadge(session)
    // A send into a blocked conversation reports success without delivery (OpenChat's anti-probe rule).
    if (value?.dropped === true) return { clientId: input.clientId, message: null }
    const message = projectMessage(value)
    if (!message) throw unavailable()
    return { clientId: input.clientId, message: { ...message, clientId: input.clientId } }
  }

  async function markRead(session, conversationId) {
    const { value } = await upstream(session, 'PATCH', `/api/chat/conversations/${encodeURIComponent(conversationId)}/read`)
    invalidateBadge(session)
    return { lastReadAt: iso(value?.lastReadAt), readMap: projectReadMap(value?.readMap), onlineMap: projectOnlineMap(value?.onlineMap) }
  }

  async function setMute(session, conversationId, mutedUntil) {
    let value = null
    if (mutedUntil === 'always') value = 'always'
    else if (mutedUntil !== null) {
      const at = iso(mutedUntil)
      if (!at || Date.parse(at) <= now() || Date.parse(at) > now() + 366 * 86400000) throw invalid()
      value = at
    }
    const result = await upstream(session, 'PATCH', `/api/chat/conversations/${encodeURIComponent(conversationId)}/participants/me`, { mutedUntil: value })
    return { conversationId, mutedUntil: mute(result.value?.mutedUntil) }
  }

  async function edit(session, messageId, input) {
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    if (!content || content.length > MAX_CONTENT) throw invalid()
    const { value } = await upstream(session, 'PATCH', `/api/chat/messages/${encodeURIComponent(messageId)}`, { content })
    const message = projectMessage(value)
    if (!message) throw unavailable()
    return { message }
  }

  async function remove(session, messageId) {
    const { value } = await upstream(session, 'DELETE', `/api/chat/messages/${encodeURIComponent(messageId)}`)
    return { message: projectMessage(value) }
  }

  async function react(session, messageId, input) {
    if (!REACTION_EMOJI.includes(input.emoji) || typeof input.active !== 'boolean') throw invalid()
    const { value } = input.active
      ? await upstream(session, 'POST', `/api/chat/messages/${encodeURIComponent(messageId)}/reactions`, { emoji: input.emoji })
      : await upstream(session, 'DELETE', `/api/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(input.emoji)}`)
    return { messageId, reactions: projectReactions(value?.reactions) }
  }

  // An image from the browser: OpenChat presigns as the member, this server PUTs
  // the bytes to the bucket, and only the returned key can be attached later.
  async function uploadAttachment(request, session) {
    const mimeType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    const declared = Number(request.headers['content-length'])
    if (!UPLOAD_TYPES.has(mimeType) || !Number.isSafeInteger(declared) || declared <= 0 || declared > UPLOAD_MAX_BYTES) throw invalid()
    const filename = (String(request.headers['x-filename'] ?? 'image').normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'image')
    const parts = []; let length = 0
    for await (const part of request) { length += part.length; if (length > UPLOAD_MAX_BYTES) throw new MessagingError(413, 'body_too_large'); parts.push(part) }
    const bytes = Buffer.concat(parts)
    if (bytes.length !== declared) throw invalid()
    const { value } = await upstream(session, 'POST', '/api/chat/attachments/presign', { filename, mimeType, sizeBytes: bytes.length })
    let put
    try { put = new URL(value?.putUrl) } catch { throw unavailable() }
    if (put.protocol !== 'https:' || put.host !== 'storage.googleapis.com' || !ATTACHMENT_URL.test(value?.getUrl ?? '')) throw unavailable()
    let stored
    try { stored = await fetchImpl(put.href, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) }, body: bytes }) } catch { throw unavailable() }
    await stored.body?.cancel().catch(() => {})
    if (!stored.ok) throw unavailable()
    const key = randomBytes(18).toString('base64url')
    let mine = uploads.get(ownerKey(session))
    if (!mine) { mine = new Map(); uploads.set(ownerKey(session), mine); trim(uploads, 5000) }
    mine.set(key, { url: value.getUrl, mimeType, name: filename, size: bytes.length }); trim(mine, 50)
    return { attachment: { key, name: filename, mimeType, size: bytes.length, src: fileSrc(value.getUrl) } }
  }

  // Attachment bytes, same origin (CSP img-src 'self' stays). Only the exact
  // bucket grammar is fetched; images and audio only; size-capped; sandboxed.
  async function serveFile(request, response, url) {
    const target = url.searchParams.get('u')
    if ([...url.searchParams.keys()].some(key => key !== 'u') || url.searchParams.getAll('u').length !== 1 || !ATTACHMENT_URL.test(target ?? '')) throw invalid()
    const range = request.headers.range
    if (range !== undefined && !/^bytes=\d{0,12}-\d{0,12}$/.test(range)) throw invalid()
    let upstreamResponse
    try { upstreamResponse = await fetchImpl(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: range ? { Range: range } : {} }) } catch { throw unavailable() }
    const type = String(upstreamResponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const size = Number(upstreamResponse.headers.get('content-length'))
    if (![200, 206].includes(upstreamResponse.status)) { await upstreamResponse.body?.cancel().catch(() => {}); throw new MessagingError(upstreamResponse.status === 404 ? 404 : 503, upstreamResponse.status === 404 ? 'not_found' : 'messaging_unavailable') }
    if (!FILE_TYPES.has(type) || (Number.isFinite(size) && size > FILE_MAX_BYTES) || !upstreamResponse.body) { await upstreamResponse.body?.cancel().catch(() => {}); throw new MessagingError(415, 'unsupported_file') }
    const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes' }
    if (Number.isFinite(size)) headers['Content-Length'] = String(size)
    const contentRange = upstreamResponse.headers.get('content-range')
    if (upstreamResponse.status === 206 && contentRange && /^bytes \d+-\d+\/\d+$/.test(contentRange)) headers['Content-Range'] = contentRange
    response.writeHead(upstreamResponse.status === 206 && headers['Content-Range'] ? 206 : 200, headers)
    let sent = 0
    const body = Readable.fromWeb(upstreamResponse.body)
    body.on('data', chunk => { sent += chunk.length; if (sent > FILE_MAX_BYTES) body.destroy() })
    body.on('error', () => response.destroy())
    response.on('close', () => body.destroy())
    body.pipe(response)
  }

  async function search(session, query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw invalid()
    const { value } = await upstream(session, 'GET', `/api/chat/search?${new URLSearchParams({ q: query.trim(), scope: 'global', mode: 'keyword' })}`)
    const items = Array.isArray(value) ? value : array(value?.results ?? value?.messages)
    return { messages: items.map(item => projectMessage(item?.message ?? item)).filter(Boolean).slice(0, 50) }
  }

  /**
   * A public profile's Message action. OpenChat resolves the recipient through
   * Unlinked's confidential resolver and reuses or creates the direct
   * conversation. Never sends a message.
   */
  async function openProfile(session, profile) {
    spend(session, 'write')
    const { value } = await upstream(session, 'POST', '/api/unlinked/recipient', { profile })
    if (value?.status === 'unclaimed') return { status: 'unclaimed', name: text(value.name, 160) }
    if (value?.status !== 'ready' || !validId(value?.recipient?.id)) return { status: 'unavailable' }
    const created = await upstream(session, 'POST', '/api/chat/conversations', { participantIds: [value.recipient.id], type: 'direct' })
    const conversation = projectConversation(created.value)
    if (!conversation) return { status: 'unavailable' }
    return { status: 'ready', conversationId: conversation.id, recipient: { id: value.recipient.id, name: text(value.recipient.name, 160) } }
  }

  // ── Header badge ──────────────────────────────────────────────────────────
  function invalidateBadge(session) { badges.delete(ownerKey(session)) }
  async function unreadTotal(session) {
    const key = ownerKey(session)
    if (!key) return null
    const cached = badges.get(key)
    if (cached && now() - cached.at < (cached.value === null ? BADGE_FAILURE_MS : BADGE_FRESH_MS)) return cached.value
    if (cached?.pending) return cached.pending
    const entry = { at: cached?.at ?? 0, value: cached?.value ?? null, pending: null }
    badges.set(key, entry); trim(badges, 5000)
    entry.pending = upstream(session, 'GET', '/api/chat/unread-total')
      .then(({ value }) => count(value?.unreadTotal), () => null)
      .then(value => { Object.assign(entry, { at: now(), value, pending: null }); return value })
    return entry.pending
  }

  // ── Realtime: one upstream link per member, shared by that member's streams ─
  // The link lingers briefly after its last stream closes so a reconnecting
  // EventSource (or a page navigation) reuses it instead of opening a new socket.
  function linkFor(session) {
    const key = ownerKey(session)
    let link = links.get(key)
    if (link) { clearTimeout(link.lingerTimer); link.lingerTimer = null; link.session = session; return link }
    if (links.size >= maxLinks) throw new MessagingError(503, 'messaging_busy')
    link = { key, session, socket: null, mode: 'connecting', streams: new Set(), focus: null, joined: new Set(), lastAt: new Date(now()).toISOString(), failures: 0, timers: new Set(), refreshTimer: null, polling: false, closed: false, lingerTimer: null }
    links.set(key, link)
    void connectLink(link)
    return link
  }
  const later = (link, ms, work) => { const timer = setTimeout(() => { link.timers.delete(timer); if (!link.closed) work() }, ms); timer.unref?.(); link.timers.add(timer); return timer }
  const broadcast = (link, event, data, id) => { for (const stream of link.streams) stream.write(event, data, id) }
  const setMode = (link, mode) => { if (link.mode === mode) return; link.mode = mode; broadcast(link, 'status', { state: mode === 'socket' ? 'live' : mode }) }
  // Each stream remembers what it has been sent, so a socket echo and a history
  // replay of the same message reach the browser once.
  const deliver = (link, raw, targets = link.streams) => {
    const message = projectMessage(raw)
    if (!message) return
    if (message.createdAt && message.createdAt > link.lastAt) link.lastAt = message.createdAt
    const value = withClientId(link.key, message)
    for (const stream of targets) {
      if (stream.seen.has(message.id)) continue
      stream.seen.add(message.id); if (stream.seen.size > 1000) stream.seen.delete(stream.seen.values().next().value)
      stream.write('message', value, message.createdAt)
    }
  }
  function onUpstreamEvent(link, event, payload) {
    if (event === 'message:new') return deliver(link, payload)
    if (event === 'message:updated') { const message = projectMessage(payload); if (message) broadcast(link, 'message-updated', { ...message, reactions: message.reactions.map(({ emoji, count }) => ({ emoji, count })) }); return }
    if (event === 'message:reactions-updated') {
      // `byMe` in this event is computed for whoever reacted, so it is dropped (DECISIONS.md 5).
      if (validId(payload?.messageId) && validId(payload?.conversationId)) broadcast(link, 'reactions', { messageId: payload.messageId, conversationId: payload.conversationId, reactions: projectReactions(payload.reactions, { withMine: false }) })
      return
    }
    if (event === 'message:preview-ready') { if (validId(payload?.messageId) && validId(payload?.conversationId)) broadcast(link, 'message-changed', { messageId: payload.messageId, conversationId: payload.conversationId }); return }
    if (event === 'read:updated') { if (validId(payload?.conversationId) && validId(payload?.userId)) broadcast(link, 'read', { conversationId: payload.conversationId, userId: payload.userId, lastReadAt: iso(payload.lastReadAt), readMap: projectReadMap(payload.readMap) }); return }
    if (event === 'typing:start' || event === 'typing:stop') { if (validId(payload?.conversationId) && validId(payload?.userId)) broadcast(link, 'typing', { conversationId: payload.conversationId, userId: payload.userId, active: event === 'typing:start' }); return }
    if (event === 'presence:updated') { if (validId(payload?.userId)) broadcast(link, 'presence', { userId: payload.userId, presence: projectUser({ id: payload.userId, presenceStatus: payload.status }).presence }); return }
    if (['conversation:created', 'conversation:updated', 'participant:added', 'participant:removed'].includes(event)) {
      const conversationId = payload?.conversationId ?? payload?.conversation?.id ?? payload?.id
      if (validId(conversationId)) broadcast(link, 'conversation', { conversationId })
      return
    }
    if (event === 'conversation:joined' && validId(payload?.conversationId)) link.joined.add(payload.conversationId)
  }
  async function replay(link, since, targets) {
    const { value } = await upstream(link.session, 'GET', `/api/chat/messages/since?${new URLSearchParams({ since })}`)
    for (const message of array(value?.messages)) deliver(link, message, targets)
    if (value?.truncated === true) for (const stream of targets) stream.write('resync', {})
  }
  async function connectLink(link) {
    if (link.closed) return
    try {
      const credential = await credentialFor(link.session)
      const socket = await connectSocket({ token: credential.token, url: socketUrl, onEvent: (event, payload) => onUpstreamEvent(link, event, payload), onClose: () => {
        if (link.socket !== socket) return
        link.socket = null; link.joined.clear()
        if (!link.closed) { setMode(link, 'reconnecting'); later(link, 1000, () => connectLink(link)) }
      } })
      if (link.closed) { socket.close(); return }
      const previous = link.socket
      link.socket = socket; link.failures = 0; link.joined.clear()
      previous?.close()
      if (link.focus) socket.emit('conversation:join', link.focus)
      setMode(link, 'socket')
      // Messages that arrived while no socket was open come from OpenChat's history.
      await replay(link, link.lastAt, link.streams).catch(() => {})
      // OpenChat ends an embedded socket at token expiry; swap in a fresh one first.
      if (link.refreshTimer) { clearTimeout(link.refreshTimer); link.timers.delete(link.refreshTimer) }
      link.refreshTimer = later(link, Math.max(1000, credential.at + CREDENTIAL_FRESH_MS + 30000 - now()), () => connectLink(link))
    } catch {
      // From polling, keep retrying the socket quietly once a minute.
      if (link.mode === 'polling') { later(link, 60000, () => connectLink(link)); return }
      link.failures++
      if (link.failures >= 3) { setMode(link, 'polling'); startPolling(link); later(link, 60000, () => connectLink(link)) }
      else { setMode(link, 'reconnecting'); later(link, 1000 * 2 ** link.failures, () => connectLink(link)) }
    }
  }
  // Without a socket, OpenChat's history is read every few seconds instead.
  function startPolling(link) {
    if (link.polling) return
    link.polling = true
    const tick = async () => {
      if (link.mode !== 'polling') { link.polling = false; return }
      await replay(link, link.lastAt, link.streams).catch(() => {})
      later(link, pollMs, tick)
    }
    later(link, 0, tick)
  }
  function closeLink(link) {
    link.closed = true
    for (const timer of link.timers) clearTimeout(timer)
    clearTimeout(link.lingerTimer)
    link.socket?.close(); link.socket = null
    if (links.get(link.key) === link) links.delete(link.key)
  }
  function focus(session, conversationId) {
    const link = links.get(ownerKey(session))
    if (!link) return { joined: false }
    if (link.focus && link.focus !== conversationId) { link.socket?.emit('conversation:leave', link.focus); link.joined.delete(link.focus) }
    link.focus = conversationId
    link.socket?.emit('conversation:join', conversationId)
    return { joined: Boolean(link.socket) }
  }
  function typing(session, conversationId, active) {
    const link = links.get(ownerKey(session))
    // OpenChat relays typing to a room without checking membership, so only a
    // room OpenChat confirmed joining (membership checked there) receives it.
    if (!link?.socket || !link.joined.has(conversationId)) return { relayed: false }
    link.socket.emit(active ? 'typing:start' : 'typing:stop', conversationId)
    return { relayed: true }
  }

  function openStream(request, response, session, url) {
    const link = linkFor(session)
    // At most 3 open streams per member; a new tab or reload retires the oldest.
    if (link.streams.size >= 3) { const oldest = [...link.streams][0]; oldest.write('superseded', {}); oldest.end() }
    const since = iso(request.headers['last-event-id']) ?? iso(url.searchParams.get('since'))
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
    let ended = false
    const stream = {
      seen: new Set(),
      write(event, data, id) { if (!ended) response.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
      end() { if (ended) return; ended = true; clearInterval(heartbeat); clearTimeout(lifetime); link.streams.delete(stream); response.end(); if (!link.streams.size && !link.closed) { link.lingerTimer = setTimeout(() => closeLink(link), lingerMs); link.lingerTimer.unref?.() } },
    }
    response.write('retry: 3000\n\n')
    link.streams.add(stream)
    stream.write('ready', { state: link.mode === 'socket' ? 'live' : link.mode })
    if (since) void replay(link, since, [stream]).catch(() => {})
    const heartbeat = setInterval(() => {
      if ((session.expiresAt && session.expiresAt <= now()) || !isSessionLive(session)) { stream.write('expired', {}); stream.end(); return }
      link.socket?.emit('heartbeat')
      stream.write('heartbeat', {})
    }, heartbeatMs)
    heartbeat.unref?.()
    // Streams are recycled; EventSource reconnects with Last-Event-ID and replays the gap.
    const lifetime = setTimeout(() => stream.end(), streamLifetimeMs); lifetime.unref?.()
    request.on('close', () => stream.end())
    response.on('error', () => stream.end())
  }

  // ── Routes ──────────────────────────────────────────────────────────────
  async function readJson(request) {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw invalid()
    const parts = []; let length = 0
    for await (const part of request) { length += part.length; if (length > BODY_MAX_BYTES) throw new MessagingError(413, 'body_too_large'); parts.push(part) }
    let value
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') } catch { throw invalid() }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    return value
  }
  const only = (input, keys) => { if (Object.keys(input).some(key => !keys.includes(key))) throw invalid(); return input }
  const sendJson = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); response.end(JSON.stringify(value)) }

  // One API request → [status, body], or null once a stream has taken over the response.
  async function route(request, response, url, session, path) {
    if (!session) throw new MessagingError(401, 'sign_in_required')
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw new MessagingError(403, 'same_origin_required')
    const keys = [...url.searchParams.keys()]
    let match
    if (request.method === 'GET') {
      // Attachment bytes have their own budget, so a thread full of images never starves reads.
      if (path === '/file') { spend(session, 'file'); await serveFile(request, response, url); return null }
      spend(session, 'read')
      if (path === '/stream') { if (keys.some(key => key !== 'since')) throw invalid(); openStream(request, response, session, url); return null }
      if (path === '/conversations' && !keys.length) return [200, await listConversations(session)]
      if (path === '/unread' && !keys.length) return [200, { unreadTotal: await unreadTotal(session) }]
      if ((match = /^\/conversations\/([^/]+)\/messages$/.exec(path)) && validId(match[1])) {
        const before = url.searchParams.get('before')
        if (keys.some(key => key !== 'before') || url.searchParams.getAll('before').length > 1 || (before !== null && !iso(before))) throw invalid()
        return [200, await listMessages(session, match[1], before === null ? null : iso(before))]
      }
      if (path === '/search') { if (keys.some(key => key !== 'q') || url.searchParams.getAll('q').length !== 1) throw invalid(); return [200, await search(session, url.searchParams.get('q'))] }
      throw new MessagingError(404, 'not_found')
    }
    if (request.method !== 'POST') throw new MessagingError(405, 'method_not_allowed')
    // Same origin is already enforced for every POST; JSON writes also carry the session's CSRF token.
    if (typeof session.csrf !== 'string' || !session.csrf || request.headers['x-unlinked-csrf'] !== session.csrf) throw new MessagingError(403, 'csrf_required')
    if (keys.length) throw invalid()
    if (path === '/attachments') { spend(session, 'upload'); return [201, await uploadAttachment(request, session)] }
    const input = await readJson(request)
    if ((match = /^\/conversations\/([^/]+)\/(messages|read|mute|typing|focus)$/.exec(path)) && validId(match[1])) {
      const [, id, action] = match
      if (action === 'typing') { spend(session, 'typing'); only(input, ['active']); if (typeof input.active !== 'boolean') throw invalid(); return [200, typing(session, id, input.active)] }
      if (action === 'focus') { spend(session, 'read'); only(input, []); return [200, focus(session, id)] }
      if (action === 'read') { spend(session, 'read'); only(input, []); return [200, await markRead(session, id)] }
      spend(session, 'write')
      if (action === 'messages') return [201, await send(session, id, only(input, ['content', 'clientId', 'replyToId', 'attachments']))]
      only(input, ['mutedUntil']); if (!Object.hasOwn(input, 'mutedUntil')) throw invalid()
      return [200, await setMute(session, id, input.mutedUntil)]
    }
    if ((match = /^\/messages\/([^/]+)\/(edit|delete|reactions)$/.exec(path)) && validId(match[1])) {
      spend(session, 'write')
      const [, id, action] = match
      if (action === 'edit') return [200, await edit(session, id, only(input, ['content']))]
      if (action === 'delete') { only(input, []); return [200, await remove(session, id)] }
      return [200, await react(session, id, only(input, ['emoji', 'active']))]
    }
    if (path === '/conversations') {
      const profile = parseUnlinkedProfileContext(only(input, ['profile']).profile)
      if (!profile) throw invalid()
      return [200, await openProfile(session, profile)]
    }
    throw new MessagingError(404, 'not_found')
  }

  /** Handles `/messages/api/*` for the request's signed-in session (or none). Returns false for other paths. */
  async function handle(request, response, url, session) {
    if (!url.pathname.startsWith('/messages/api/')) return false
    try {
      const result = await route(request, response, url, session, url.pathname.slice('/messages/api'.length))
      if (result) sendJson(response, ...result)
    } catch (error) {
      if (response.headersSent) { response.end(); return true }
      const known = error instanceof MessagingError ? error : unavailable()
      sendJson(response, known.status, { error: known.code })
    }
    return true
  }

  function close() { for (const link of [...links.values()]) closeLink(link) }
  return { handle, openProfile, unreadTotal, close, _links: links }
}
