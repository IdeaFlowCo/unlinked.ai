// unlinked-ac9.1 (App Store guideline 1.2): Report on profiles, messages and
// conversations; Block on members and conversations. Reports are stored for
// the operator and emailed to support. A block is kept by Unlinked, refuses
// connection requests both ways, hides the conversation and drops the person's
// messages here, and applies OpenChat's own block. All people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createSafetyReports, createMemorySafetyReportStore } from '../mcp-server/safety-reports.mjs'
import { createMemberBlocks, createMemoryBlockStore, createNeo4jBlockStore, blockRecord, BlockError } from '../mcp-server/member-blocks.mjs'
import { createConnectionRequests, createMemoryConnectionStore, ConnectionError } from '../mcp-server/member-connections.mjs'
import { createNotifications, createMemoryNotificationStore } from '../mcp-server/member-notifications.mjs'
import { MESSAGES_CLIENT_SOURCE } from '../mcp-server/messages-client.mjs'
import { renderPerson } from '../mcp-server/private-onboarding-views.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const ALEX = '11111111-1111-4111-8111-111111111111', BLAKE = '22222222-2222-4222-8222-222222222222', CASEY = '33333333-3333-4333-8333-333333333333'
const A = { ownerId: 'owner-alex', userId: 'user-alex' }, B = { ownerId: 'owner-blake', userId: 'user-blake' }
const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = { state: 'published', complete: true, revision: 'report-block-test', members: [ALEX, BLAKE],
  profiles: [profile(ALEX, 'Alex Rivera'), profile(BLAKE, 'Blake Moreau', { headline: 'Founder at Fieldstone' }), profile(CASEY, 'Casey Ito')], connections: [{ fromId: ALEX, toId: CASEY }] }

// A small OpenChat: two users, a direct conversation and a group, blocks, reports.
function fakeOpenChat() {
  const calls = [], blocks = new Set()
  const conversations = [
    { id: 'c_direct', type: 'direct', participants: [{ user: { id: 'oc_alex', name: 'Alex Rivera' } }, { user: { id: 'oc_blake', name: 'Blake Moreau' } }], lastMessageAt: '2026-10-17T10:00:00.000Z' },
    { id: 'c_group', type: 'group', title: 'Climate friends', participants: [{ user: { id: 'oc_alex', name: 'Alex Rivera' } }, { user: { id: 'oc_blake', name: 'Blake Moreau' } }, { user: { id: 'oc_casey', name: 'Casey Ito' } }], lastMessageAt: '2026-10-17T09:00:00.000Z' },
  ]
  const messages = { c_direct: [{ id: 'm_hi', conversationId: 'c_direct', senderId: 'oc_blake', sender: { id: 'oc_blake', name: 'Blake Moreau' }, content: 'Buy my course now!!! http://spam.invalid', createdAt: '2026-10-17T10:00:00.000Z' }] }
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname, method = options.method ?? 'GET'
    calls.push({ method, path, token: options.headers?.Authorization, body: options.body ? JSON.parse(options.body) : undefined })
    if (method === 'GET' && path === '/api/chat/conversations') return json(conversations)
    let match
    if (method === 'GET' && (match = /^\/api\/chat\/conversations\/([^/]+)\/messages$/.exec(path))) return json({ messages: messages[match[1]] ?? [], hasMore: false })
    if (method === 'POST' && (match = /^\/api\/chat\/conversations\/([^/]+)\/messages$/.exec(path))) return json({ id: 'sent', conversationId: match[1], senderId: 'oc_alex', content: 'x', createdAt: '2026-10-17T11:00:00.000Z' }, 201)
    if (method === 'POST' && path === '/api/unlinked/recipient') return json({ status: 'ready', recipient: { id: 'oc_blake', name: 'Blake Moreau' } })
    if (method === 'POST' && path === '/api/chat/conversations') return json(conversations[0], 201)
    if ((match = /^\/api\/chat\/users\/([^/]+)\/block$/.exec(path))) { if (method === 'POST') blocks.add(match[1]); else blocks.delete(match[1]); return json({ blocked: method === 'POST' }, method === 'POST' ? 201 : 200) }
    if (method === 'POST' && path === '/api/chat/reports') return json({ id: 'oc-report' }, 201)
    if (path === '/api/chat/unread-total') return json({ unreadTotal: 0 })
    return json({ error: 'not found' }, 404)
  }
  return { calls, blocks, fetchImpl }
}

async function site(t, { reports = true, blocks = true } = {}) {
  const openChat = fakeOpenChat()
  const blockService = blocks ? createMemberBlocks({ store: createMemoryBlockStore() }) : undefined
  const notifications = createNotifications({ store: createMemoryNotificationStore() })
  const memberConnections = createConnectionRequests({ store: createMemoryConnectionStore(), notifications, ...(blockService ? { blocked: (a, b) => blockService.between(a, b) } : {}) })
  const reportStore = createMemorySafetyReportStore()
  const transport = { sent: [], send: async message => { transport.sent.push(message); return { id: 'e' } } }
  let handler, nextSubject = 'alex'
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const owners = { alex: A, blake: B }, profiles = new Map([[ALEX, A], [BLAKE, B]])
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: nextSubject, verifiedEmail: `${nextSubject}@example.invalid`, displayName: nextSubject === 'alex' ? 'Alex Rivera' : 'Blake Moreau' }) },
    resolveOwner: async identity => owners[identity.subject] ?? null, signup: async identity => owners[identity.subject], issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null }),
    readPublishedSnapshot: async () => snapshot, accountForProfile: async id => profiles.get(id) ?? null, ownProfileId: async owner => owner.ownerId === A.ownerId ? ALEX : BLAKE,
    memberConnections, notifications,
    createMessagingSession: async session => ({ token: `token-${session.owner.ownerId}`, user: { userId: session.owner.ownerId === A.ownerId ? 'oc_alex' : 'oc_blake' } }),
    messagingIdentities: async (_session, ids) => ids.filter(id => id === 'oc_blake').map(userId => ({ userId, issuer: 'https://identity.invalid', subject: 'blake' })),
    messagingOptions: { fetchImpl: openChat.fetchImpl, connectSocket: async () => { throw new Error('no socket in tests') } },
    ...(reports ? { safetyReports: createSafetyReports({ store: reportStore, transport, from: 'Unlinked <noreply@id.ideaflow.app>', origin: 'https://www.unlinked.ai' }) } : {}),
    ...(blockService ? { memberBlocks: blockService } : {}) })
  const go = (path, init = {}) => fetch(endpoint + path, { redirect: 'manual', ...init })
  const signIn = async subject => {
    nextSubject = subject
    const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await go('/auth/callback/ideaflow?state=test&code=test', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  }
  const page = async (path, cookie) => { const response = await go(path, { headers: cookie ? { Cookie: cookie } : {} }); return { status: response.status, location: response.headers.get('location'), body: await response.text() } }
  const csrfOf = body => body.match(/name="csrf" value="([^"]+)"/)?.[1]
  const post = (path, fields, cookie) => go(path, { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields) })
  const api = (path, cookie, csrf, body) => go(`/messages/api${path}`, body === undefined ? { headers: { Cookie: cookie } } : { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Unlinked-CSRF': csrf }, body: JSON.stringify(body) })
  return { go, page, post, api, signIn, csrfOf, openChat, reportStore, transport, blockService, memberConnections, notifications }
}

test('anyone can report a profile from its ••• menu; the report is stored, emailed, and offers Block to a signed-in member', async t => {
  const app = await site(t)
  const casey = await app.page(`/people/${CASEY}`)
  assert.match(casey.body, new RegExp(`<a href="/people/${CASEY}/report">Report Casey Ito</a>`))
  assert.match(casey.body, new RegExp(`<a href="/people/${CASEY}/removal">Request removal</a>`))
  assert.doesNotMatch(casey.body, /\/block">Block/, 'signed out: no Block')
  const form = await app.page(`/people/${CASEY}/report`)
  assert.equal(form.status, 200); assert.match(form.body, /<h1 class="hq">Report Casey Ito<\/h1>/)
  for (const reason of ['spam', 'harassment', 'hate', 'sexual', 'impersonation', 'other']) assert.match(form.body, new RegExp(`name="reason" value="${reason}"`))
  assert.equal((await app.post(`/people/${CASEY}/report`, {})).status, 400)
  const sent = await app.post(`/people/${CASEY}/report`, { reason: 'impersonation', details: 'Uses my photo.' })
  assert.equal(sent.status, 200)
  const done = await sent.text()
  assert.match(done, /Thanks for reporting/); assert.doesNotMatch(done, /Block Casey/)
  const [report] = await app.reportStore.list()
  assert.equal(report.kind, 'report'); assert.equal(report.targetType, 'profile'); assert.equal(report.targetId, CASEY); assert.equal(report.reason, 'impersonation'); assert.equal(report.reporterOwnerHash, null)
  assert.equal(app.transport.sent.length, 1); assert.match(app.transport.sent[0].subject, /Unlinked report: Fake profile or impersonation · Casey Ito/)

  const alex = await app.signIn('alex')
  const blake = await app.page(`/people/${BLAKE}`, alex)
  assert.match(blake.body, new RegExp(`<a href="/people/${BLAKE}/report">Report Blake Moreau</a><a href="/people/${BLAKE}/block">Block Blake Moreau</a>`))
  assert.doesNotMatch(blake.body, /\/removal">Request removal/)
  // Your own profile has no Report or Block.
  assert.doesNotMatch((await app.page(`/people/${ALEX}`, alex)).body, /\/report">Report|\/block">Block/)
  const reportPage = await app.page(`/people/${BLAKE}/report`, alex)
  const csrf = app.csrfOf(reportPage.body.slice(reportPage.body.indexOf('safety-form')))
  assert.equal((await app.post(`/people/${BLAKE}/report`, { reason: 'spam' }, alex)).status, 400, 'CSRF required when signed in')
  const signedIn = await (await app.post(`/people/${BLAKE}/report`, { csrf, reason: 'spam' }, alex)).text()
  assert.match(signedIn, new RegExp(`href="/people/${BLAKE}/block">Block Blake Moreau</a>`))
  assert.match((await app.reportStore.list())[0].reporterOwnerHash, /^[a-f0-9]{64}$/)
})

test('blocking a member: confirm, then connection requests are refused both ways, Messages hides them, and OpenChat blocks too', async t => {
  const app = await site(t)
  const blake = await app.signIn('blake'), alex = await app.signIn('alex')
  // Blake asked to connect before the block.
  await app.memberConnections.send({ sender: B, senderName: 'Blake Moreau', senderProfileId: BLAKE, recipient: A, recipientName: 'Alex Rivera', recipientProfileId: ALEX })
  assert.equal(await app.memberConnections.pendingCount(A), 1)
  // Signed out, Block asks to sign in; an imported profile cannot be blocked.
  assert.equal((await app.page(`/people/${BLAKE}/block`)).location, `/login?next=${encodeURIComponent(`/people/${BLAKE}`)}`)
  assert.equal((await app.page(`/people/${CASEY}/block`, alex)).location, `/people/${CASEY}`)
  const confirm = await app.page(`/people/${BLAKE}/block`, alex)
  assert.equal(confirm.status, 200); assert.match(confirm.body, /<h1 class="hq">Block Blake Moreau\?<\/h1>/)
  assert.equal((await app.post(`/people/${BLAKE}/block`, {}, alex)).status, 400)
  assert.equal(app.openChat.blocks.size, 0)
  const done = await app.post(`/people/${BLAKE}/block`, { csrf: app.csrfOf(confirm.body) }, alex)
  assert.equal(done.status, 200); assert.match(await done.text(), /You blocked Blake Moreau/)
  const [record] = await app.blockService.list(A)
  assert.deepEqual(record.blocked, B); assert.equal(record.blockedProfileId, BLAKE); assert.equal(record.openChatUserId, 'oc_blake'); assert.equal(record.name, 'Blake Moreau')
  // OpenChat's own block, as Alex.
  assert.deepEqual([...app.openChat.blocks], ['oc_blake'])
  assert.equal(app.openChat.calls.find(call => call.path === '/api/chat/users/oc_blake/block').token, 'Bearer token-owner-alex')
  // The open request was set aside; new requests either way are refused.
  assert.equal(await app.memberConnections.pendingCount(A), 0)
  await assert.rejects(app.memberConnections.send({ sender: B, recipient: A }), error => error instanceof ConnectionError && error.code === 'connection_not_available')
  await assert.rejects(app.memberConnections.send({ sender: A, recipient: B }), error => error instanceof ConnectionError && error.code === 'connection_not_available')
  const tryConnect = await app.page(`/people/${ALEX}`, blake)
  const refused = await app.post('/connections/request', { csrf: app.csrfOf(tryConnect.body), profileId: ALEX }, blake)
  assert.equal(refused.headers.get('location'), `/people/${ALEX}?connect=connection_not_available`)
  assert.match((await app.page(`/people/${ALEX}?connect=connection_not_available`, blake)).body, /You can’t connect with this person/)
  // Blake's profile now says blocked, with Unblock instead of Connect and Message.
  const blocked = await app.page(`/people/${BLAKE}`, alex)
  assert.match(blocked.body, /You blocked Blake Moreau/); assert.match(blocked.body, /action="\/blocks\/unblock"/)
  assert.doesNotMatch(blocked.body, /action="\/connections\/request"|href="\/messages\?profile=/)
  // Messages: the direct conversation is hidden, its history is not served and nothing can be sent there.
  const inbox = await (await app.api('/conversations', alex)).json()
  assert.deepEqual(inbox.conversations.map(value => value.id), ['c_group'])
  assert.deepEqual(await (await app.api('/conversations/c_direct/messages', alex)).json(), { messages: [], hasMore: false, blocked: true })
  const csrf = app.csrfOf(confirm.body)
  const send = await app.api('/conversations/c_direct/messages', alex, csrf, { content: 'hello', clientId: randomUUID() })
  assert.equal(send.status, 403); assert.deepEqual(await send.json(), { error: 'blocked' })
  // A profile Message link to Blake says they are blocked.
  const message = await app.page(`/messages?profile=${encodeURIComponent(`https://www.unlinked.ai/people/${BLAKE}`)}`, alex)
  assert.match(message.body, /You blocked Blake Moreau/)
  // Settings lists the block; Unblock lifts it everywhere.
  const settings = await app.page('/settings', alex)
  assert.match(settings.body, /<h2 id="blocked">Blocked people<\/h2>/); assert.match(settings.body, new RegExp(`<a href="/people/${BLAKE}">Blake Moreau</a>`))
  const unblock = await app.post('/blocks/unblock', { csrf: app.csrfOf(settings.body), id: record.id, next: '/settings#blocked' }, alex)
  assert.equal(unblock.headers.get('location'), '/settings?blocks=unblocked#blocked')
  assert.deepEqual(await app.blockService.list(A), []); assert.equal(app.openChat.blocks.size, 0)
  assert.deepEqual((await (await app.api('/conversations', alex)).json()).conversations.map(value => value.id), ['c_direct', 'c_group'])
  await app.memberConnections.send({ sender: A, senderName: 'Alex', recipient: B, recipientName: 'Blake' })
})

test('reporting a message keeps the message as evidence, forwards it to OpenChat, and blocking from the conversation finds their account', async t => {
  const app = await site(t)
  const alex = await app.signIn('alex')
  assert.equal((await app.page('/messages/report?conversation=c_direct&message=m_hi')).status, 401)
  assert.equal((await app.page('/messages/report?conversation=bad%2Fid', alex)).location, '/messages')
  assert.equal((await app.page('/messages/report?conversation=c_direct&message=missing', alex)).status, 404)
  const form = await app.page('/messages/report?conversation=c_direct&message=m_hi', alex)
  assert.equal(form.status, 200); assert.match(form.body, /Report a message/); assert.match(form.body, /Buy my course now!!!/)
  assert.match(form.body, /action="\/messages\/report\?conversation=c_direct&amp;message=m_hi"/)
  const csrf = app.csrfOf(form.body.slice(form.body.indexOf('safety-form')))
  const sent = await app.post('/messages/report?conversation=c_direct&message=m_hi', { csrf, reason: 'spam', details: 'Unwanted ads' }, alex)
  assert.equal(sent.status, 200)
  assert.match(await sent.text(), /href="\/messages\/block\?conversation=c_direct">Block Blake Moreau<\/a>/)
  const [report] = await app.reportStore.list()
  assert.equal(report.targetType, 'message'); assert.equal(report.targetId, 'm_hi'); assert.equal(report.targetName, 'Blake Moreau')
  const evidence = JSON.parse(report.evidence)
  assert.equal(evidence.message.content, 'Buy my course now!!! http://spam.invalid'); assert.equal(evidence.message.senderId, 'oc_blake'); assert.equal(evidence.conversation.id, 'c_direct')
  assert.deepEqual(app.openChat.calls.find(call => call.path === '/api/chat/reports').body, { targetType: 'message', targetId: 'm_hi', reason: 'spam', freeform: 'Unwanted ads' })
  // A conversation report keeps its latest messages.
  const conversationForm = await app.page('/messages/report?conversation=c_group', alex)
  assert.match(conversationForm.body, /Report a conversation/)
  await app.post('/messages/report?conversation=c_group', { csrf, reason: 'harassment', details: 'x' }, alex)
  assert.equal((await app.reportStore.list())[0].targetType, 'conversation')
  // A group cannot be blocked from here; a direct conversation can.
  assert.equal((await app.page('/messages/block?conversation=c_group', alex)).status, 404)
  const confirm = await app.page('/messages/block?conversation=c_direct', alex)
  assert.match(confirm.body, /Block Blake Moreau\?/)
  const blocked = await app.post('/messages/block?conversation=c_direct', { csrf: app.csrfOf(confirm.body) }, alex)
  assert.equal(blocked.status, 200)
  const [record] = await app.blockService.list(A)
  assert.equal(record.openChatUserId, 'oc_blake'); assert.equal(record.blockedProfileId, BLAKE); assert.deepEqual(record.blocked, B)
  assert.equal(await app.blockService.between(B, A), true)
})

test('notifications from a blocked member are hidden; account deletion removes blocks both ways', async t => {
  const app = await site(t)
  const alex = await app.signIn('alex')
  await app.notifications.notify({ recipient: A, kind: 'connection_request_received', actor: B, actorName: 'Blake Moreau', actorProfileId: BLAKE, subjectId: 'x', dedupeKey: 'k1' })
  assert.match((await app.page('/notifications', alex)).body, /Blake Moreau/)
  await app.blockService.block(A, { blocked: B, profileId: BLAKE, name: 'Blake Moreau' })
  assert.doesNotMatch((await app.page('/notifications', alex)).body, /Blake Moreau/)
  const settings = await app.page('/settings', alex)
  await app.post('/delete-account', { csrf: app.csrfOf(settings.body), confirm: 'delete everything' }, alex)
  assert.deepEqual(await app.blockService.list(A), [])
  assert.equal(await app.blockService.between(A, B), false)
})

test('without report or block services the menu still offers Report, which points to support', async t => {
  const app = await site(t, { reports: false, blocks: false })
  const alex = await app.signIn('alex')
  const blake = await app.page(`/people/${BLAKE}`, alex)
  assert.match(blake.body, /\/report">Report Blake Moreau/); assert.doesNotMatch(blake.body, /\/block">Block/)
  assert.equal((await app.page(`/people/${BLAKE}/report`, alex)).location, '/support#report')
  assert.equal((await app.page(`/people/${BLAKE}/block`, alex)).location, `/people/${BLAKE}`)
})

test('block records, the memory store and the Messages client', async () => {
  assert.throws(() => blockRecord(A, { blocked: A }), error => error instanceof BlockError && error.code === 'block_self')
  assert.throws(() => blockRecord(A, {}), /block_target_invalid/)
  assert.throws(() => blockRecord(A, { openChatUserId: 'bad/id' }), /block_target_invalid/)
  const blocks = createMemberBlocks({ store: createMemoryBlockStore() })
  // Blocking the same person from a profile and from a conversation is one block that learns both.
  const first = await blocks.block(A, { blocked: B, profileId: BLAKE, name: 'Blake' })
  const again = await blocks.block(A, { blocked: B, openChatUserId: 'oc_blake' })
  assert.equal(again.id, first.id); assert.equal(again.openChatUserId, 'oc_blake'); assert.equal(again.blockedProfileId, BLAKE)
  assert.equal((await blocks.list(A)).length, 1)
  assert.deepEqual([...(await blocks.hidden(A)).users], ['oc_blake'])
  assert.equal(await blocks.between(B, A), true); assert.equal(await blocks.between(A, A), false)
  assert.equal(await blocks.unblock(B, first.id), null, 'only the blocker unblocks')
  assert.equal((await blocks.unblock(A, first.id)).id, first.id)
  assert.ok(LABELS.includes('UnlinkedMemberBlock'))
  // The Messages client offers Report on others' messages and Report/Block in the conversation menu.
  assert.match(MESSAGES_CLIENT_SOURCE, /act\('Report', '⚑'/)
  assert.match(MESSAGES_CLIENT_SOURCE, /'Report conversation'/); assert.match(MESSAGES_CLIENT_SOURCE, /\/messages\/block\?conversation=/)
  assert.doesNotMatch(MESSAGES_CLIENT_SOURCE, /Block or report in OpenChat/)
  // A blocked profile view never offers Connect or Message.
  const view = renderPerson({ csrf: 'c', profile: { id: BLAKE, name: 'Blake', presence: 'member', positions: [], education: [], skills: [], connections: [] }, connect: { state: 'none' }, blocked: { id: first.id }, canBlock: true }).content
  assert.doesNotMatch(view, /connections\/request|messages\?profile|\/block">Block/); assert.match(view, /You blocked Blake/)
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('real Neo4j blocks: one per person, merge of what is known, both-direction check, owner removal', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const store = createNeo4jBlockStore(driver)
  const x = { ownerId: randomUUID(), userId: 'u-' + randomUUID() }, y = { ownerId: randomUUID(), userId: 'u-' + randomUUID() }
  t.after(async () => { try { await store.removeOwner(x) } finally { await driver.close() } })
  await store.initialize(); await store.initialize()
  const blocks = createMemberBlocks({ store })
  const first = await blocks.block(x, { blocked: y, profileId: 'profile-y', name: 'Y' })
  const merged = await blocks.block(x, { blocked: y, openChatUserId: 'oc_y' })
  assert.equal(merged.id, first.id); assert.equal(merged.openChatUserId, 'oc_y'); assert.equal(merged.blockedProfileId, 'profile-y'); assert.equal(merged.name, 'Y')
  assert.equal(await blocks.between(y, x), true); assert.equal(await blocks.between(x, { ownerId: 'other', userId: 'other' }), false)
  assert.equal((await blocks.list(x)).length, 1)
  await blocks.removeOwner(y)
  assert.deepEqual(await blocks.list(x), [])
})
