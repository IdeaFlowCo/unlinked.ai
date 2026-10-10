import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { projectConversation, projectMessage, REACTION_EMOJI } from '../mcp-server/messaging-proxy.mjs'
import { connectOpenChatSocket, encodeEvent, parseEventPacket } from '../mcp-server/openchat-socket.mjs'

const TOKEN = 'fixture-embedded-openchat-jwt'
const ME = 'oc-me', OTHER = 'oc-other', CONV = 'conv_1'
const person = (id, name) => ({ id, name, email: `${id}@private.example`, legacyEmail: `${id}@legacy.example`, avatarUrl: 'https://cdn.example/a.png', presenceStatus: 'available', lastSeenAt: '2026-10-10T10:00:00.000000000Z', isBot: false, statusMessage: 'private status' })
const message = (id, content, at, senderId = OTHER) => ({ id, conversationId: CONV, senderId, sender: { ...person(senderId, senderId === ME ? 'Me' : 'Avery') }, content, messageType: 'text', createdAt: at, reactions: [{ emoji: '👍', count: 2, byMe: true, kind: null, href: null }], replyTo: null, attachments: [{ url: 'https://storage.example/secret.png', mimeType: 'image/png', name: 'a.png', size: 10 }], linkPreviews: [{ url: 'https://example.com/', title: 'Example', image: 'https://img.example/x.png', siteName: 'Example' }, { url: 'javascript:alert(1)', title: 'bad' }] })

test('projection whitelists fields: no email, legacy email, avatar URL, status message or attachment URL', () => {
  const conversation = projectConversation({ id: CONV, type: 'direct', title: null, lastMessageAt: '2026-10-10T10:00:00.123456789Z', lastMessage: { id: 'm1', content: 'hi', senderId: OTHER, createdAt: '2026-10-10T10:00:00Z', email: 'x@y' }, participants: [{ user: person(ME, 'Me'), role: 'member' }, { user: { ...person(OTHER, 'Avery'), presenceStatus: 'invisible' }, role: 'owner' }], unreadCount: 3, lastReadAt: null, mutedUntil: 'always', containsBot: false, inviteToken: 'secret-invite' })
  const json = JSON.stringify(conversation)
  assert.doesNotMatch(json, /@|avatar|cdn\.example|private status|secret-invite/)
  assert.equal(conversation.lastMessageAt, '2026-10-10T10:00:00.123Z')
  assert.equal(conversation.participants[1].presence, 'offline', 'invisible reads as offline to others')
  assert.equal(conversation.mutedUntil, 'always')
  const projected = projectMessage(message('m1', 'hello', '2026-10-10T10:00:00Z'))
  assert.doesNotMatch(JSON.stringify(projected), /@|avatar|storage\.example|img\.example|javascript:|"kind"|"href"/)
  assert.deepEqual(projected.reactions, [{ emoji: '👍', count: 2, byMe: true }])
  assert.deepEqual(projected.linkPreviews, [{ url: 'https://example.com/', title: 'Example', description: null, siteName: 'Example' }])
  assert.equal(projectMessage({ ...message('m2', 'secret body', '2026-10-10T10:00:00Z'), deletedAt: '2026-10-10T11:00:00Z' }).content, '')
  assert.equal(projectMessage({ id: '../x', conversationId: CONV }), null)
  assert.deepEqual(REACTION_EMOJI, ['👍', '❤️', '😂', '😮', '😢', '🙏'])
})

test('socket framing: Engine.IO open, namespace auth, ping/pong, events, connect errors', async () => {
  assert.deepEqual(parseEventPacket('2["message:new",{"id":"m1"}]'), { event: 'message:new', args: [{ id: 'm1' }] })
  assert.deepEqual(parseEventPacket('212["typing:start","c"]'), { event: 'typing:start', args: ['c'] })
  assert.equal(parseEventPacket('2/admin,["x"]'), null); assert.equal(parseEventPacket('2{bad'), null)
  assert.equal(encodeEvent('typing:start', 'c1'), '42["typing:start","c1"]')
  class FakeSocket extends EventTarget {
    static last; sent = []; readyState = 0
    constructor(url) { super(); FakeSocket.last = this; this.url = url; queueMicrotask(() => { this.readyState = 1; this.serve('0{"sid":"s","pingInterval":25000,"pingTimeout":20000}') }) }
    serve(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event) }
    send(data) { this.sent.push(data); if (data.startsWith('40')) queueMicrotask(() => this.serve(JSON.parse(data.slice(2)).token === TOKEN ? '40{"sid":"n"}' : '44{"message":"Invalid token"}')) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  await assert.rejects(connectOpenChatSocket({ token: 'expired', url: 'ws://fixture', WebSocketImpl: FakeSocket }), /connect_error/)
  const events = []; let closed
  const socket = await connectOpenChatSocket({ token: TOKEN, url: 'ws://fixture', WebSocketImpl: FakeSocket, onEvent: (...args) => events.push(args), onClose: reason => { closed = reason } })
  const fake = FakeSocket.last
  assert.equal(fake.sent[0], `40{"token":"${TOKEN}"}`)
  fake.serve('2'); assert.equal(fake.sent.at(-1), '3')
  fake.serve('42["message:new",{"id":"m1"}]'); assert.deepEqual(events, [['message:new', { id: 'm1' }]])
  socket.emit('conversation:join', CONV); assert.equal(fake.sent.at(-1), `42["conversation:join","${CONV}"]`)
  fake.serve('41'); assert.equal(closed, 'server_disconnect'); assert.equal(socket.open, false)
})

// A signed-in browser session against a mocked OpenChat (fetch + socket).
async function harness(t, { upstream = {}, sockets = [] } = {}) {
  const calls = [], minted = []
  const owner = { ownerId: 'owner', userId: 'user' }
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    calls.push({ method: options.method, path: parsed.pathname + parsed.search, body: options.body ? JSON.parse(options.body) : undefined, auth: options.headers.Authorization, redirect: options.redirect, signal: Boolean(options.signal) })
    const key = `${options.method} ${parsed.pathname}`
    const handler = upstream[key]
    if (!handler) return new Response(JSON.stringify({ error: 'not mocked' }), { status: 500 })
    const [status, body] = await handler({ url: parsed, body: options.body ? JSON.parse(options.body) : undefined, auth: options.headers.Authorization, calls })
    return new Response(body === undefined ? '' : JSON.stringify(body), { status })
  }
  const connectSocket = async options => {
    const fake = { options, emitted: [], open: true, emit(...args) { this.emitted.push(args) }, close() { this.open = false } }
    sockets.push(fake)
    return fake
  }
  let handler
  const server = createServer((req, res) => handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl: origin, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://id.example.invalid/auth', transaction: { state: 'fixture-state' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: 'verified', displayName: 'Avery' }) },
    resolveOwner: async () => owner, getBackend: async () => ({ adapter: {} }),
    createMessagingSession: async session => { minted.push(session.owner); return { token: `${TOKEN}-${minted.length}`, user: { userId: ME, name: 'Me', email: 'shared-inbox@ideaflow.invalid' } } },
    messagingOptions: { apiOrigin: 'https://chat.test', fetchImpl, connectSocket, heartbeatMs: 50, lingerMs: 10 },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const start = await request('/login?next=%2Fmessages'), transaction = start.headers.getSetCookie().find(value => value.startsWith('__Host-ul-login=')).split(';')[0]
  const finish = await request('/auth/callback/ideaflow?state=fixture-state&code=fixture', { headers: { Cookie: transaction } })
  const cookie = finish.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await request('/messages', { headers: { Cookie: cookie } })
  const markup = await page.text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(markup)[1]
  const get = (path, headers = {}) => request(path, { headers: { Cookie: cookie, ...headers } })
  const post = (path, body, headers = {}) => request(path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Unlinked-CSRF': csrf, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { calls, minted, sockets, request, get, post, cookie, csrf, origin, page, markup }
}

const conversations = [{ id: CONV, type: 'direct', lastMessageAt: '2026-10-10T10:00:00Z', lastMessage: { id: 'm1', content: 'hi', senderId: OTHER, createdAt: '2026-10-10T10:00:00Z' }, participants: [{ user: person(ME, 'Me') }, { user: person(OTHER, 'Avery') }], unreadCount: 1 }]

test('native inbox page has no iframe, frame-src or camera delegation, and never contains the OpenChat token', async t => {
  const h = await harness(t, { upstream: { 'GET /api/chat/unread-total': () => [200, { unreadTotal: 4 }] } })
  assert.equal(h.page.status, 200)
  assert.doesNotMatch(h.markup, /<iframe|fixture-embedded-openchat-jwt|embed=unlinked/)
  assert.doesNotMatch(h.page.headers.get('content-security-policy'), /frame-src/)
  assert.match(h.page.headers.get('content-security-policy'), /connect-src 'self'/)
  assert.equal(h.page.headers.get('permissions-policy'), null)
  // The old browser token exchange is gone.
  assert.notEqual((await h.request('/messages/session', { method: 'POST', headers: { Cookie: h.cookie, Origin: h.origin }, body: `csrf=${h.csrf}` })).status, 200)
  const alerts = await (await h.get('/api/nav-alerts')).json()
  assert.equal(alerts.messages, 4)
})

test('REST relay: list, page, send with derived id, read; bearer stays server-side; responses projected', async t => {
  const h = await harness(t, { upstream: {
    'GET /api/chat/conversations': () => [200, conversations],
    'GET /api/chat/unread-total': () => [200, { unreadTotal: 1 }],
    [`GET /api/chat/conversations/${CONV}/messages`]: ({ url }) => [200, { messages: [message('m1', 'hi', '2026-10-10T10:00:00Z')], hasMore: url.searchParams.get('before') === null }],
    [`POST /api/chat/conversations/${CONV}/messages`]: ({ body }) => [201, { ...message(body.id, body.content, '2026-10-10T10:05:00Z', ME), replyToId: body.replyToId ?? null }],
    [`PATCH /api/chat/conversations/${CONV}/read`]: () => [200, { ok: true, lastReadAt: '2026-10-10T10:06:00.000Z', readMap: { [ME]: '2026-10-10T10:06:00.000Z', [OTHER]: null, 'bad id!': 'x' }, onlineMap: { [OTHER]: true } }],
  } })
  const list = await h.get('/messages/api/conversations')
  assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store, private')
  const listed = await list.json()
  assert.equal(listed.me.id, ME); assert.equal(listed.conversations[0].participants[1].name, 'Avery')
  const page = await (await h.get(`/messages/api/conversations/${CONV}/messages?before=2026-10-10T10:00:00.000Z`)).json()
  assert.equal(page.messages[0].content, 'hi'); assert.equal(page.hasMore, false)
  assert.equal(h.calls.at(-1).path, `/api/chat/conversations/${CONV}/messages?limit=50&before=2026-10-10T10%3A00%3A00.000Z`)
  const clientId = '0b5c2c51-6f7e-4b8a-9d3c-1f2e3d4c5b6a'
  const sent = await h.post(`/messages/api/conversations/${CONV}/messages`, { content: '  hello  ', clientId })
  assert.equal(sent.status, 201)
  const body = await sent.json()
  assert.equal(body.clientId, clientId); assert.equal(body.message.content, 'hello')
  const upstreamSend = h.calls.find(call => call.method === 'POST' && call.path.endsWith('/messages'))
  assert.match(upstreamSend.body.id, /^ul_[0-9a-f]{32}$/); assert.notEqual(upstreamSend.body.id, clientId)
  assert.deepEqual(Object.keys(upstreamSend.body).sort(), ['content', 'id'])
  // A retry with the same clientId reaches OpenChat with the same id (idempotent MERGE).
  await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'hello', clientId })
  assert.equal(h.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).at(-1).body.id, upstreamSend.body.id)
  const read = await (await h.post(`/messages/api/conversations/${CONV}/read`, {})).json()
  assert.deepEqual(read.readMap, { [ME]: '2026-10-10T10:06:00.000Z', [OTHER]: null })
  for (const call of h.calls) { assert.equal(call.redirect, 'error'); assert.equal(call.signal, true); assert.match(call.auth, /^Bearer fixture-embedded-openchat-jwt-\d$/) }
  assert.equal(h.minted.length, 1, 'one credential is minted and reused')
})

test('writes require JSON, CSRF and same origin; ids, cursors, bodies and emoji are validated before any upstream call', async t => {
  const h = await harness(t, { upstream: {} })
  const before = h.calls.length
  const clientId = '0b5c2c51-6f7e-4b8a-9d3c-1f2e3d4c5b6a'
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId }, { 'X-Unlinked-CSRF': 'wrong' })).status, 403)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId }, { Origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId }, { 'Content-Type': 'text/plain' })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId, senderId: 'forged' })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId: 'not-a-uuid' })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: '   ', clientId })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x'.repeat(8001), clientId })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, { content: 'x', clientId, replyToId: '../../admin' })).status, 400)
  assert.equal((await h.post('/messages/api/conversations/..%2Fadmin/messages', { content: 'x', clientId })).status, 404)
  assert.equal((await h.post('/messages/api/messages/m1/reactions', { emoji: '💩', active: true })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/mute`, { mutedUntil: '1999-01-01T00:00:00Z' })).status, 400)
  assert.equal((await h.post('/messages/api/conversations', { profile: 'https://evil.example/people/x' })).status, 400)
  assert.equal((await h.post(`/messages/api/conversations/${CONV}/messages`, 'x'.repeat(70000))).status, 413)
  assert.equal((await h.get(`/messages/api/conversations/${CONV}/messages?before=yesterday`)).status, 400)
  assert.equal((await h.get('/messages/api/conversations', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal(h.calls.length, before, 'nothing reached OpenChat')
  const anonymous = await h.request('/messages/api/conversations')
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).error, 'sign_in_required')
})

test('an expired upstream credential is refreshed once; upstream failures become 503 without detail', async t => {
  let first = true
  const h = await harness(t, { upstream: {
    'GET /api/chat/conversations': ({ auth }) => { if (first) { first = false; return [401, { error: 'Invalid or expired token' }] } return [200, conversations] },
    'GET /api/chat/unread-total': () => [500, { error: 'Neo4j stack trace with secrets' }],
  } })
  assert.equal((await h.get('/messages/api/conversations')).status, 200)
  assert.equal(h.minted.length >= 2, true, 'a fresh credential was minted after 401')
  const failed = await h.get('/messages/api/unread')
  assert.equal(failed.status, 200); assert.deepEqual(await failed.json(), { unreadTotal: null })
})

test('profile Message resolves server-side to the direct conversation without sending; unclaimed shows an invite', async t => {
  let status = 'ready'
  const h = await harness(t, { upstream: {
    'POST /api/unlinked/recipient': ({ body }) => [200, status === 'ready' ? { status, recipient: { id: OTHER, name: 'Avery' } } : { status: 'unclaimed', name: 'Imported Person' }],
    'POST /api/chat/conversations': ({ body }) => { assert.deepEqual(body, { participantIds: [OTHER], type: 'direct' }); return [201, conversations[0]] },
  } })
  const profile = encodeURIComponent('https://www.unlinked.ai/people/avery-fixture')
  const ready = await h.get(`/messages?profile=${profile}`)
  assert.equal(ready.status, 303); assert.equal(ready.headers.get('location'), `/messages/c/${CONV}`)
  assert.deepEqual(h.calls.find(call => call.path === '/api/unlinked/recipient').body, { profile: 'https://www.unlinked.ai/people/avery-fixture' })
  assert.equal(h.calls.some(call => call.path.endsWith('/messages') && call.method === 'POST'), false, 'opening never sends')
  status = 'unclaimed'
  const invite = await h.get(`/messages?profile=${profile}`)
  assert.equal(invite.status, 200)
  const markup = await invite.text()
  assert.match(markup, /Imported Person/); assert.match(markup, /is not on Unlinked yet/); assert.match(markup, /href="\/invites"/)
  const thread = await h.get(`/messages/c/${CONV}`)
  assert.equal(thread.status, 200); assert.match(await thread.text(), /data-conversation="conv_1"/)
  assert.equal((await h.get('/messages/c/bad%20id')).status, 303)
})

// Read SSE frames from a streaming fetch until `until` returns true.
async function readEvents(response, until, timeoutMs = 3000) {
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !until(events)) {
    const { value, done } = await Promise.race([reader.read(), new Promise(resolve => setTimeout(resolve, 100, { value: undefined, done: false }))])
    if (done) break
    if (value) buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2)
      const event = {}
      for (const line of frame.split('\n')) { const at = line.indexOf(': '); if (at > 0) event[line.slice(0, at)] = line.slice(at + 2) }
      if (event.event) events.push({ ...event, data: JSON.parse(event.data) })
    }
  }
  await reader.cancel().catch(() => {})
  return events
}

test('event stream bridges socket events, replays Last-Event-ID from history, dedupes, and drops actor-relative byMe', async t => {
  const sockets = []
  const h = await harness(t, { sockets, upstream: {
    'GET /api/chat/messages/since': ({ url }) => [200, { messages: [message('m-replayed', 'while away', '2026-10-10T10:01:00Z')], truncated: false, since: url.searchParams.get('since') }],
  } })
  const response = await h.get('/messages/api/stream', { 'Last-Event-ID': '2026-10-10T10:00:00.000Z' })
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const events = readEvents(response, list => list.filter(event => event.event === 'message').length >= 2 && list.some(event => event.event === 'reactions') && list.some(event => event.event === 'typing'))
  // Wait for the bridge to have a socket, then push upstream events through it.
  for (let i = 0; i < 50 && !sockets.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  const socket = sockets[0]
  assert.match(socket.options.token, /^fixture-embedded-openchat-jwt/)
  await new Promise(resolve => setTimeout(resolve, 50))
  socket.options.onEvent('message:new', message('m-replayed', 'while away', '2026-10-10T10:01:00Z'))
  socket.options.onEvent('message:new', message('m-live', 'live', '2026-10-10T10:02:00Z'))
  socket.options.onEvent('message:reactions-updated', { messageId: 'm-live', conversationId: CONV, reactions: [{ emoji: '👍', count: 1, byMe: true }] })
  socket.options.onEvent('typing:start', { conversationId: CONV, userId: OTHER })
  const seen = await events
  const messages = seen.filter(event => event.event === 'message')
  assert.deepEqual(messages.map(event => event.data.id), ['m-replayed', 'm-live'], 'replayed once, then live')
  assert.equal(messages[1].id, '2026-10-10T10:02:00.000Z', 'event id is the message time for Last-Event-ID')
  assert.deepEqual(seen.find(event => event.event === 'reactions').data.reactions, [{ emoji: '👍', count: 1 }])
  assert.deepEqual(seen.find(event => event.event === 'typing').data, { conversationId: CONV, userId: OTHER, active: true })
  assert.equal(h.calls.find(call => call.path.startsWith('/api/chat/messages/since')).path, '/api/chat/messages/since?since=2026-10-10T10%3A00%3A00.000Z')
  assert.doesNotMatch(JSON.stringify(seen), /@|fixture-embedded-openchat-jwt/)
})

test('typing is relayed only into a room OpenChat confirmed joining', async t => {
  const sockets = []
  const h = await harness(t, { sockets, upstream: { 'GET /api/chat/messages/since': () => [200, { messages: [] }] } })
  const response = await h.get('/messages/api/stream')
  const events = readEvents(response, list => list.some(event => event.event === 'ready'), 1000)
  for (let i = 0; i < 50 && !sockets.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  const socket = sockets[0]
  assert.deepEqual(await (await h.post(`/messages/api/conversations/${CONV}/typing`, { active: true })).json(), { relayed: false })
  await h.post(`/messages/api/conversations/${CONV}/focus`, {})
  const sent = () => socket.emitted.filter(([event]) => event !== 'heartbeat').map(([event, id]) => `${event} ${id}`)
  assert.deepEqual(sent(), [`conversation:join ${CONV}`])
  socket.options.onEvent('conversation:joined', { conversationId: CONV })
  assert.deepEqual(await (await h.post(`/messages/api/conversations/${CONV}/typing`, { active: true })).json(), { relayed: true })
  assert.deepEqual(sent(), [`conversation:join ${CONV}`, `typing:start ${CONV}`])
  await events
})

test('a fourth stream retires the oldest with superseded; long multi-byte messages fit; socket edits carry no actor byMe', async t => {
  const sockets = []
  const h = await harness(t, { sockets, upstream: {
    'GET /api/chat/messages/since': () => [200, { messages: [] }],
    [`POST /api/chat/conversations/${CONV}/messages`]: ({ body }) => [201, message(body.id, body.content, '2026-10-10T10:05:00Z', ME)],
  } })
  const first = await h.get('/messages/api/stream')
  const firstEvents = readEvents(first, list => list.some(event => event.event === 'superseded'), 3000)
  for (let i = 0; i < 50 && !sockets.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  const others = [await h.get('/messages/api/stream'), await h.get('/messages/api/stream'), await h.get('/messages/api/stream')]
  assert.ok((await firstEvents).some(event => event.event === 'superseded'))
  assert.equal(sockets.length, 1, 'streams share one upstream socket')
  const live = readEvents(others[2], list => list.some(event => event.event === 'message-updated'), 2000)
  sockets[0].options.onEvent('message:updated', { ...message('m1', 'edited', '2026-10-10T10:00:00Z'), reactions: [{ emoji: '👍', count: 1, byMe: true }] })
  const updated = (await live).find(event => event.event === 'message-updated')
  assert.deepEqual(updated.data.reactions, [{ emoji: '👍', count: 1 }])
  for (const response of others.slice(0, 2)) await response.body.cancel()
  const long = '漢'.repeat(8000)
  const sent = await h.post(`/messages/api/conversations/${CONV}/messages`, { content: long, clientId: '0b5c2c51-6f7e-4b8a-9d3c-1f2e3d4c5b6b' })
  assert.equal(sent.status, 201)
})
