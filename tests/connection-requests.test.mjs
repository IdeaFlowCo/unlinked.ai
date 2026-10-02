import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ConnectionError, createConnectionRequests, createMemoryConnectionStore, createNeo4jConnectionStore, pairKey, CONNECTION_REQUESTS_PER_DAY } from '../mcp-server/member-connections.mjs'
import { createNotifications, createMemoryNotificationStore, createNeo4jNotificationStore, NOTIFICATION_KINDS } from '../mcp-server/member-notifications.mjs'
import { createMemberInvitations, createMemoryInvitationStore } from '../mcp-server/member-invitations.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { renderInvitations, renderNotifications, renderPerson, fillNavAlerts, NAV_ALERTS_SLOT } from '../mcp-server/private-onboarding-views.mjs'

const jacob = { ownerId: 'jacob-owner', userId: 'jacob-user' }, ada = { ownerId: 'ada-owner', userId: 'ada-user' }, grace = { ownerId: 'grace-owner', userId: 'grace-user' }
const code = expected => error => error instanceof ConnectionError && error.code === expected
const setup = (options = {}) => {
  let clock = 1_000_000_000
  const notificationStore = createMemoryNotificationStore(), notifications = createNotifications({ store: notificationStore, now: () => clock })
  const store = createMemoryConnectionStore(), requests = createConnectionRequests({ store, notifications, now: () => clock, ...options })
  return { store, requests, notifications, notificationStore, tick: ms => { clock += ms }, now: () => clock }
}
const send = (requests, from, to, extra = {}) => requests.send({ sender: from, senderName: from === jacob ? 'Jacob Cole' : from === ada ? 'Ada Lovelace' : 'Grace Hopper', senderProfileId: `${from.ownerId}-profile`,
  recipient: to, recipientName: to === jacob ? 'Jacob Cole' : to === ada ? 'Ada Lovelace' : 'Grace Hopper', recipientProfileId: `${to.ownerId}-profile`, ...extra })

test('a request is pending once per pair, accepted by the recipient only, and then connects both accounts', async () => {
  const { requests, notifications } = setup()
  const sent = await send(requests, jacob, ada, { note: '  Met you   at the conference ' })
  assert.equal(sent.status, 'pending'); assert.equal(sent.request.direction, 'sent'); assert.equal(sent.request.note, 'Met you at the conference')
  // Duplicates either way round are not new requests.
  await assert.rejects(send(requests, jacob, ada), code('connection_pending'))
  assert.deepEqual((await requests.between(jacob, ada)).state, 'outgoing')
  const incoming = await requests.between(ada, jacob)
  assert.deepEqual([incoming.state, incoming.note], ['incoming', 'Met you at the conference'])
  assert.equal(await requests.pendingCount(ada), 1); assert.equal(await requests.pendingCount(jacob), 0)
  const [received] = await requests.received(ada)
  assert.deepEqual([received.name, received.profileId, received.direction], ['Jacob Cole', 'jacob-owner-profile', 'received'])
  // Nobody but the recipient can answer; nobody but the sender can withdraw. Both look like "not found".
  await assert.rejects(requests.respond(jacob, sent.request.id, 'accept'), code('connection_not_found'))
  await assert.rejects(requests.respond(grace, sent.request.id, 'accept'), code('connection_not_found'))
  await assert.rejects(requests.withdraw(ada, sent.request.id), code('connection_not_found'))
  await assert.rejects(requests.withdraw(grace, sent.request.id), code('connection_not_found'))
  await assert.rejects(requests.respond(ada, sent.request.id, 'block'), code('connection_action_invalid'))
  await assert.rejects(requests.respond(ada, 'not-a-uuid', 'accept'), code('connection_not_found'))
  // Ada was told; accepting tells Jacob and settles Ada's item.
  const [adaItem] = await notifications.list(ada)
  assert.deepEqual([adaItem.kind, adaItem.actorName, adaItem.actorProfileId, adaItem.subjectId, adaItem.read], ['connection_request_received', 'Jacob Cole', 'jacob-owner-profile', sent.request.id, false])
  const accepted = await requests.respond(ada, sent.request.id, 'accept')
  assert.equal(accepted.status, 'accepted')
  assert.equal((await notifications.list(ada))[0].read, true)
  const [jacobItem] = await notifications.list(jacob)
  assert.deepEqual([jacobItem.kind, jacobItem.actorName, jacobItem.actorProfileId], ['connection_request_accepted', 'Ada Lovelace', 'ada-owner-profile'])
  await assert.rejects(requests.respond(ada, sent.request.id, 'accept'), code('connection_unavailable'))
  await assert.rejects(requests.withdraw(jacob, sent.request.id), code('connection_unavailable'))
  assert.equal((await requests.between(jacob, ada)).state, 'connected')
  await assert.rejects(send(requests, ada, jacob), code('connection_exists'))
  assert.deepEqual((await requests.connections(jacob)).map(value => [value.other, value.name]), [[ada, 'Ada Lovelace']])
  assert.deepEqual((await requests.connections(ada)).map(value => [value.other, value.name]), [[jacob, 'Jacob Cole']])
  assert.deepEqual((await requests.accepted()).map(value => [value.sender, value.recipient]), [[jacob, ada]])
  assert.equal(await requests.pendingCount(ada), 0)
})

test('asking someone who already asked you accepts their request; self requests and bad notes are refused', async () => {
  const { requests, notifications } = setup()
  await assert.rejects(send(requests, jacob, jacob), code('connection_self'))
  await assert.rejects(send(requests, jacob, ada, { note: 'x'.repeat(301) }), code('connection_note_invalid'))
  await assert.rejects(send(requests, jacob, ada, { note: 'bell\u0007' }), code('connection_note_invalid'))
  await assert.rejects(send(requests, jacob, ada, { note: 42 }), code('connection_note_invalid'))
  const first = await send(requests, ada, jacob)
  const reverse = await send(requests, jacob, ada)
  assert.equal(reverse.status, 'accepted'); assert.equal(reverse.request.id, first.request.id)
  assert.equal((await requests.between(jacob, ada)).state, 'connected')
  // Ada's request was answered by Jacob's Connect: Ada hears it was accepted, nobody gets a stray request item.
  assert.deepEqual((await notifications.list(ada)).map(value => value.kind), ['connection_request_accepted'])
  assert.deepEqual((await notifications.list(jacob)).map(value => [value.kind, value.read]), [['connection_request_received', true]])
})

test('an ignore is private: the sender still sees pending, cannot resend, and the recipient can still connect later', async () => {
  const { requests, notifications } = setup()
  const sent = await send(requests, jacob, ada)
  const ignored = await requests.respond(ada, sent.request.id, 'ignore')
  assert.equal(ignored.status, 'ignored')
  assert.deepEqual(await requests.received(ada), [])
  assert.equal(await requests.pendingCount(ada), 0)
  const [mine] = await requests.sent(jacob)
  assert.equal(mine.status, 'pending')
  assert.deepEqual((await notifications.list(jacob)), [])
  assert.equal((await requests.between(jacob, ada)).state, 'outgoing')
  assert.equal((await requests.between(ada, jacob)).state, 'none')
  await assert.rejects(send(requests, jacob, ada), code('connection_pending'))
  await assert.rejects(requests.respond(ada, sent.request.id, 'ignore'), code('connection_unavailable'))
  // Ada changes her mind: Connect on Jacob accepts the request she set aside.
  assert.equal((await send(requests, ada, jacob)).status, 'accepted')
  assert.equal((await requests.between(jacob, ada)).state, 'connected')
})

test('withdrawing removes the recipient’s notification and starts a resend cooldown; the daily limit stops bursts', async () => {
  const { requests, notifications, tick } = setup({ perDay: 3 })
  const sent = await send(requests, jacob, ada)
  assert.equal((await notifications.counts(ada)).unseen, 1)
  await requests.withdraw(jacob, sent.request.id)
  assert.deepEqual(await notifications.list(ada), []); assert.deepEqual(await requests.received(ada), []); assert.deepEqual(await requests.sent(jacob), [])
  await assert.rejects(requests.withdraw(jacob, sent.request.id), code('connection_unavailable'))
  await assert.rejects(send(requests, jacob, ada), code('connection_cooldown'))
  // The other person is not held to Jacob's cooldown.
  const back = await send(requests, ada, jacob)
  await requests.withdraw(ada, back.request.id)
  tick(21 * 24 * 60 * 60 * 1000 + 1)
  assert.equal((await send(requests, jacob, ada)).status, 'pending')
  const others = [1, 2, 3].map(index => ({ ownerId: `o${index}`, userId: `u${index}` }))
  await send(requests, jacob, others[0]); await send(requests, jacob, others[1])
  await assert.rejects(send(requests, jacob, others[2]), code('connection_rate_limited'))
  tick(24 * 60 * 60 * 1000)
  assert.equal((await send(requests, jacob, others[2])).status, 'pending')
  assert.equal(CONNECTION_REQUESTS_PER_DAY, 50)
})

test('storage refuses a racing duplicate and a second accepted connection for the same pair', async () => {
  const store = createMemoryConnectionStore(), requests = createConnectionRequests({ store })
  const pair = pairKey(jacob, ada)
  assert.equal(pair, pairKey(ada, jacob))
  // Simulate a request that lands between another sender's check and insert.
  const original = store.listPair
  let raced = false
  store.listPair = async key => { if (!raced) { raced = true; await store.insert({ id: '00000000-0000-4000-8000-000000000001', pairKey: key, openKey: key, senderOwnerId: ada.ownerId, senderUserId: ada.userId, senderName: 'Ada', recipientOwnerId: jacob.ownerId, recipientUserId: jacob.userId, recipientName: 'Jacob', status: 'pending', createdAt: 1 }); return [] } return original(key) }
  await assert.rejects(send(requests, jacob, ada), code('connection_pending'))
  store.listPair = original
  await store.insert({ id: '00000000-0000-4000-8000-000000000002', pairKey: pair, connectedKey: pair, senderOwnerId: 'x', senderUserId: 'x', senderName: 'X', recipientOwnerId: 'y', recipientUserId: 'y', recipientName: 'Y', status: 'accepted', createdAt: 2 })
  await assert.rejects(requests.respond(jacob, '00000000-0000-4000-8000-000000000001', 'accept'), code('connection_exists'))
})

test('deleting an account removes its requests both ways, its feed, and its name from other feeds', async () => {
  const { requests, notifications, notificationStore } = setup()
  const toAda = await send(requests, jacob, ada)
  await requests.respond(ada, toAda.request.id, 'accept')
  await send(requests, grace, jacob)
  await send(requests, jacob, grace).catch(() => {})
  assert.ok((await notifications.list(ada)).length + (await notifications.list(jacob)).length > 0)
  assert.equal(await requests.removeOwner(jacob), 2)
  await notifications.removeOwner(jacob)
  assert.deepEqual(await requests.connections(ada), []); assert.deepEqual(await requests.received(grace), []); assert.deepEqual(await requests.accepted(), [])
  assert.ok(![...notificationStore.records.values()].some(value => JSON.stringify(value).includes('jacob')))
})

test('notifications dedupe, never notify the actor, and track seen and read separately per account', async () => {
  let clock = 5000
  const store = createMemoryNotificationStore(), feed = createNotifications({ store, now: () => clock, keep: 3 })
  const event = (key, extra = {}) => feed.notify({ recipient: ada, kind: 'invite_accepted', actor: jacob, actorName: 'Jacob <Cole>', subjectId: 'inv', dedupeKey: key, ...extra })
  assert.equal(await event('a'), true); assert.equal(await event('a'), false)
  assert.equal(await feed.notify({ recipient: jacob, kind: 'invite_accepted', actor: jacob, actorName: 'Jacob', dedupeKey: 'self' }), false)
  await assert.rejects(feed.notify({ recipient: ada, kind: 'party', actorName: 'x', dedupeKey: 'k' }), /notification_kind_invalid/)
  await assert.rejects(feed.notify({ recipient: ada, kind: 'invite_accepted', actorName: 'x', dedupeKey: '' }), /notification_key_invalid/)
  const [item] = await feed.list(ada)
  // A name that is not a plain name is not kept.
  assert.equal(item.actorName, 'An Unlinked member')
  clock += 10; await event('b', { actorName: 'Grace Hopper' }); clock += 10; await event('c')
  assert.deepEqual(await feed.counts(ada), { unseen: 3, unread: 3 })
  await feed.markSeen(ada)
  assert.deepEqual(await feed.counts(ada), { unseen: 0, unread: 3 })
  // Someone else's id opens nothing and changes nothing.
  assert.equal(await feed.open(jacob, item.id), null); assert.equal(await feed.open(ada, 'nope'), null)
  assert.equal((await feed.open(ada, item.id)).read, true)
  assert.deepEqual(await feed.counts(ada), { unseen: 0, unread: 2 })
  await feed.markAllRead(ada)
  assert.deepEqual(await feed.counts(ada), { unseen: 0, unread: 0 })
  // Each account keeps its newest `keep` items.
  clock += 10; await event('d')
  assert.deepEqual((await feed.list(ada)).map(value => value.actorName), ['An Unlinked member', 'An Unlinked member', 'Grace Hopper'])
  await feed.retract('d'); assert.equal((await feed.list(ada)).length, 2)
  assert.equal((await feed.list(jacob)).length, 0)
  assert.deepEqual(Object.keys(NOTIFICATION_KINDS).sort(), ['connection_request_accepted', 'connection_request_received', 'invite_accepted', 'profile_claimed'])
  await assert.rejects(feed.list(ada, { limit: 1000 }), /notification_limit_invalid/)
})

test('an accepted off-platform invite notifies the inviter once, with the name the invitee joined with', async () => {
  const feed = createNotifications({ store: createMemoryNotificationStore() })
  const invites = createMemberInvitations({ store: createMemoryInvitationStore(), onAccepted: value => feed.notify({ recipient: value.inviter, kind: 'invite_accepted', actor: value.invitee, actorName: value.inviteeName, subjectId: value.invitationId, dedupeKey: `invite-accepted:${value.invitationId}` }) })
  const { token } = await invites.create({ inviter: jacob, inviterName: 'Jacob Cole', inviteeName: 'Ada' })
  assert.deepEqual(await invites.respond(token, ada, 'accept', 'Ada Lovelace'), { status: 'accepted', inviterName: 'Jacob Cole' })
  const items = await feed.list(jacob)
  assert.deepEqual(items.map(value => [value.kind, value.actorName]), [['invite_accepted', 'Ada Lovelace']])
  // A failing hook never stops accepting.
  const broken = createMemberInvitations({ store: createMemoryInvitationStore(), onAccepted: () => { throw new Error('down') } })
  const again = await broken.create({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Grace' })
  assert.equal((await broken.respond(again.token, grace, 'accept')).status, 'accepted')
})

test('graph stores add only their own constraints and use compare-and-set transitions', async () => {
  const calls = []
  const run = async (query, params) => { calls.push({ query, params }); return { records: /RETURN r\.id AS id/.test(query) ? [{ get: () => 'id' }] : /RETURN created/.test(query) ? [{ get: () => true }] : [] } }
  const driver = { session: () => ({ close: async () => {}, executeWrite: work => work({ run }), executeRead: work => work({ run }) }) }
  await createNeo4jConnectionStore(driver).initialize(); await createNeo4jNotificationStore(driver).initialize()
  assert.ok(calls.every(call => /^CREATE (CONSTRAINT|INDEX) unlinked_(connection_request|notification)_[a-z_]+ IF NOT EXISTS FOR \((r:UnlinkedConnectionRequest|n:UnlinkedNotification)\)/.test(call.query)))
  calls.length = 0
  assert.equal(await createNeo4jConnectionStore(driver).transition('id-1', ['pending', 'ignored'], { status: 'accepted', connectedKey: 'k' }, ['openKey']), true)
  assert.match(calls[0].query, /WHERE r\.status IN \$from SET r \+= \$patch REMOVE r\.openKey RETURN r\.id AS id/)
  const conflicting = { session: () => ({ close: async () => {}, executeWrite: async () => { throw Object.assign(new Error('exists'), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' }) } }) }
  await assert.rejects(createNeo4jConnectionStore(conflicting).insert({ id: 'x' }), /connection_conflict/)
  assert.equal(await createNeo4jNotificationStore(conflicting).insertOnce({ id: 'x', dedupeKey: 'k' }), false)
  assert.equal(await createNeo4jNotificationStore(driver).insertOnce({ id: 'x', dedupeKey: 'k', kind: 'invite_accepted' }), true)
  assert.match(calls.at(-1).query, /^MERGE \(n:UnlinkedNotification \{dedupeKey: \$dedupeKey\}\) ON CREATE SET/)
  await createNeo4jNotificationStore(driver).list(ada, 50)
  assert.match(calls.at(-1).query, /LIMIT 50$/)
  await assert.rejects(createNeo4jNotificationStore(driver).list(ada, 1.5), /notification_limit_invalid/)
})

test('an accepted request is a connection in People you know, linked to the other member’s public profile', async () => {
  const getBackend = async () => ({ listImportIds: async () => [], readMemberConnections: async () => [{ requestId: 'req-1', other: ada, name: 'Ada Lovelace', publicProfileId: 'ada-profile' }, { requestId: 'req-2', other: grace, name: 'Grace Hopper', publicProfileId: null }] })
  const network = await createAccountNetwork({ owner: jacob, getBackend }).readNetwork()
  assert.deepEqual(network.assertions.map(row => [row.fields['first name'], row.category, row.provenance]), [['Ada Lovelace', 'connections', { source: 'unlinked-connection', requestId: 'req-1', toId: 'ada-profile' }], ['Grace Hopper', 'connections', { source: 'unlinked-connection', requestId: 'req-2' }]])
})

test('the public reader says whether two profiles are already linked, either direction and through merges', async () => {
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'r1', profiles: [person('a', 'A'), person('b', 'B'), person('c', 'C')], connections: [{ fromId: 'a', toId: 'b' }], aliases: { old: 'b' } }) })
  assert.equal(await reader.linked({ fromId: 'b', toId: 'a' }), true)
  assert.equal(await reader.linked({ fromId: 'a', toId: 'old' }), true)
  assert.equal(await reader.linked({ fromId: 'a', toId: 'c' }), false)
  assert.equal(await reader.linked({ fromId: 'a', toId: 'a' }), false)
  await assert.rejects(reader.linked({ fromId: '', toId: 'a' }), { status: 400 })
})

test('views: escaped names, inline answers, header badges only for configured features', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const invitations = renderInvitations({ csrf: 'tok', now, received: [{ id: 'r1', name: 'Ada <Lovelace>', profileId: 'ada profile', note: 'Hi "there"', createdAt: now - 7200000 }], sent: [{ id: 's1', name: 'Grace', createdAt: now - 60000 }] }).content
  assert.match(invitations, /<a href="\/people\/ada%20profile"><b>Ada &lt;Lovelace&gt;<\/b><\/a> wants to connect/)
  assert.match(invitations, /<q>Hi &quot;there&quot;<\/q>/); assert.match(invitations, /2h/)
  assert.match(invitations, /name="id" value="r1">.*?value="ignore">Ignore<\/button><button class="sm" name="action" value="accept">Accept/)
  assert.match(invitations, /aria-current="page">Received · 1<\/a><a href="\/invitations\?tab=sent">Sent · 1<\/a><a href="\/invites">Off-platform invites/)
  assert.doesNotMatch(invitations, /Withdraw/)
  const sentTab = renderInvitations({ csrf: 'tok', now, tab: 'sent', sent: [{ id: 's1', name: 'Grace', createdAt: now - 60000 }] }).content
  assert.match(sentTab, /Sent 1m · Pending/); assert.match(sentTab, /action="\/connections\/withdraw".*?name="id" value="s1"/)
  const items = [{ id: 'n1', kind: 'connection_request_received', actorName: 'Ada <L>', subjectId: 'r1', createdAt: now - 1000, read: false }, { id: 'n2', kind: 'connection_request_received', actorName: 'Old', subjectId: 'gone', createdAt: now - 9 * 86400000, read: true }, { id: 'n3', kind: 'mystery', actorName: 'x', createdAt: now }]
  const feed = renderNotifications({ csrf: 'tok', now, items, pending: new Map([['r1', {}]]), pendingCount: 1 }).content
  assert.match(feed, /<li class="note unread"><a class="note-open" href="\/notifications\/n1">.*?<b>Ada &lt;L&gt;<\/b> wants to connect with you<span class="vh"> \(unread\)<\/span>/)
  assert.equal((feed.match(/action="\/connections\/respond"/g) ?? []).length, 1)
  assert.match(feed, /Mark all as read/); assert.match(feed, /1 pending invitation</); assert.doesNotMatch(feed, /mystery|n3/)
  assert.match(feed, /<li class="note"><a class="note-open" href="\/notifications\/n2">/)
  assert.doesNotMatch(renderNotifications({ csrf: 'tok', items: [] }).content, /Mark all as read|pending invitation/)
  // The header slot is filled per request; an unconfigured feature shows nothing.
  const page = renderInvitations({ csrf: 'tok' }).content
  assert.ok(page.includes(NAV_ALERTS_SLOT))
  assert.doesNotMatch(fillNavAlerts(page, null), /class="nav-ico"/)
  const filled = fillNavAlerts(page, { network: 2, notifications: 140 })
  assert.match(filled, /<a class="nav-ico" href="\/invitations" title="My Network" aria-label="My Network, 2 pending">.*?<span class="badge" aria-hidden="true">2<\/span><\/a>/)
  assert.match(filled, /aria-label="Notifications, 99\+ new">.*?>99\+<\/span>/)
  assert.match(fillNavAlerts(page, { notifications: 0 }), /aria-label="Notifications">/); assert.doesNotMatch(fillNavAlerts(page, { notifications: 0 }), /class="badge"|title="My Network"/)
  assert.doesNotMatch(renderInvitations({}).content, /nav-alerts/)
  // Profiles: each relation renders its control.
  const profile = { id: 'ada', name: 'Ada Lovelace', presence: 'member', positions: [], connections: [] }
  const control = connect => renderPerson({ csrf: 'tok', profile, connect }).content
  assert.match(control({ state: 'none' }), /<form class="connect" method="post" action="\/connections\/request">.*?name="profileId" value="ada">.*?Connect<\/button><details><summary>Add a note<\/summary>.*?A short note for Ada/)
  assert.match(control({ state: 'outgoing', requestId: 'r9' }), /Pending<\/span><form method="post" action="\/connections\/withdraw">.*?value="r9"><input type="hidden" name="next" value="\/people\/ada">.*?Withdraw/)
  assert.match(control({ state: 'incoming', requestId: 'r9', note: 'Hello <b>' }), /Ada wants to connect with you\. <q>Hello &lt;b&gt;<\/q>.*?Accept invitation/)
  assert.match(control({ state: 'connected' }), /✓ Connected/); assert.match(control({ state: 'self' }), /This is you/)
  assert.match(control({ state: 'invite' }), /href="\/invites">Invite to Unlinked/)
  assert.match(renderPerson({ profile, connect: { state: 'signed-out' } }).content, /href="\/login\?next=%2Fpeople%2Fada">Sign in to connect/)
  assert.match(renderPerson({ csrf: 'tok', profile, connect: { state: 'none' }, connectNotice: 'sent' }).content, /role="status">Invitation sent\./)
  assert.doesNotMatch(renderPerson({ csrf: 'tok', profile, connectNotice: '<script>' }).content, /script>/)
})

// Two members with public profiles, plus a shadow, on one handler.
async function site(t) {
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const snapshot = { state: 'published', complete: true, revision: 'connect-fixture', profiles: [person('jacob-profile', 'Jacob Cole'), person('ada-profile', 'Ada Lovelace'), person('grace-profile', 'Grace Hopper'), person('shadow', 'Shadow Person')], connections: [{ fromId: 'jacob-profile', toId: 'grace-profile' }], members: ['jacob-profile', 'ada-profile', 'grace-profile'] }
  const accounts = { 'jacob-profile': jacob, 'ada-profile': ada, 'grace-profile': grace }
  const owners = { 'jacob-subject': jacob, 'ada-subject': ada, 'grace-subject': grace }
  const names = { 'jacob-subject': 'jacob@example.invalid', 'ada-subject': 'Ada Lovelace', 'grace-subject': 'Grace Hopper' }
  const notifications = createNotifications({ store: createMemoryNotificationStore() })
  const memberConnections = createConnectionRequests({ store: createMemoryConnectionStore(), notifications })
  const memberInvitations = createMemberInvitations({ store: createMemoryInvitationStore() })
  let next = 'jacob-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null })
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', memberInvitations, memberConnections, notifications,
    accountForProfile: async id => accounts[id] ?? null, ownProfileId: async owner => Object.keys(accounts).find(id => accounts[id].ownerId === owner.ownerId && accounts[id].userId === owner.userId) ?? null,
    readPublishedSnapshot: async () => snapshot,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: next, verifiedEmail: `${next}@example.invalid`, displayName: names[next] }) },
    resolveOwner: async identity => owners[identity.subject], signup: async identity => owners[identity.subject], issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async () => backend() })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async subject => {
    next = subject
    const begin = await request('/login')
    const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
    const csrf = (await (await request('/settings', { headers: { Cookie: cookie } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
    return { cookie, csrf }
  }
  const get = async (path, member) => { const response = await request(path, { headers: { Cookie: member.cookie } }); return { status: response.status, location: response.headers.get('location'), text: await response.text() } }
  const post = (path, member, form) => request(path, { method: 'POST', headers: { Cookie: member.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: member.csrf, ...form }) })
  return { request, signIn, get, post, notifications, memberConnections, memberInvitations }
}

test('end to end: Connect with a note, badges, the feed, answering, and cross-account refusals', async t => {
  const { request, signIn, get, post, notifications } = await site(t)
  const me = await signIn('jacob-subject'), her = await signIn('ada-subject'), third = await signIn('grace-subject')
  // Signed out: members offer sign-in, shadows offer nothing.
  assert.match(await (await request('/people/ada-profile')).text(), /Sign in to connect/)
  assert.doesNotMatch(await (await request('/people/shadow')).text(), /Sign in to connect|connections\/request/)
  // Signed in: Connect on a member; an invite link on a shadow; already linked through an import; yourself.
  const adaPage = await get('/people/ada-profile', me)
  assert.match(adaPage.text, /action="\/connections\/request"/)
  assert.match(adaPage.text, /class="nav-ico" href="\/invitations" title="My Network" aria-label="My Network"/)
  assert.match((await get('/people/shadow', me)).text, /Invite to Unlinked/)
  assert.match((await get('/people/grace-profile', me)).text, /✓ Connected/)
  assert.match((await get('/people/jacob-profile', me)).text, /This is you/)
  // Refused without a valid CSRF token or from another origin.
  assert.equal((await post('/connections/request', { ...me, csrf: 'wrong' }, { profileId: 'ada-profile' })).status, 400)
  assert.equal((await request('/connections/request', { method: 'POST', headers: { Cookie: me.cookie, Origin: 'https://evil.invalid', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${me.csrf}&profileId=ada-profile` })).status, 403)
  const sent = await post('/connections/request', me, { profileId: 'ada-profile', note: 'Loved your talk' })
  assert.equal(sent.status, 303); assert.equal(sent.headers.get('location'), '/people/ada-profile?connect=sent')
  assert.match((await get('/people/ada-profile?connect=sent', me)).text, /Invitation sent\..*?Pending<\/span>/s)
  assert.equal((await post('/connections/request', me, { profileId: 'ada-profile' })).headers.get('location'), '/people/ada-profile?connect=connection_pending')
  assert.equal((await post('/connections/request', me, { profileId: 'shadow' })).headers.get('location'), '/people/shadow?connect=connection_not_member')
  assert.equal((await post('/connections/request', me, { profileId: 'jacob-profile' })).headers.get('location'), '/people/jacob-profile?connect=connection_self')
  assert.equal((await post('/connections/request', me, { profileId: 'grace-profile' })).headers.get('location'), '/people/grace-profile?connect=connection_exists')
  assert.equal((await post('/connections/request', me, { profileId: 'nobody' })).status, 404)
  // Ada's header counts the request and the notification.
  const home = await get('/invitations', her)
  assert.match(home.text, /aria-label="My Network, 1 pending">.*?<span class="badge" aria-hidden="true">1<\/span>/)
  assert.match(home.text, /aria-label="Notifications, 1 new"/)
  // The sender is named by their public profile, never their sign-in email.
  assert.match(home.text, /<a href="\/people\/jacob-profile"><b>Jacob Cole<\/b><\/a> wants to connect/); assert.match(home.text, /<q>Loved your talk<\/q>/)
  assert.doesNotMatch(home.text, /jacob@example/)
  const feed = await get('/notifications', her)
  assert.match(feed.text, /<li class="note unread">.*?<b>Jacob Cole<\/b> wants to connect with you/)
  const requestId = feed.text.match(/action="\/connections\/respond"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="id" value="([^"]+)"/)[1]
  assert.match(feed.text, /aria-label="Notifications"/) // opening the feed clears the bell for this view
  assert.match((await get('/notifications', her)).text, /aria-label="Notifications">/)
  // Nobody else can answer or withdraw it, or open Ada's items.
  assert.equal((await post('/connections/respond', third, { id: requestId, action: 'accept' })).headers.get('location'), '/invitations?notice=connection_not_found')
  assert.equal((await post('/connections/respond', me, { id: requestId, action: 'accept' })).headers.get('location'), '/invitations?notice=connection_not_found')
  assert.equal((await post('/connections/withdraw', her, { id: requestId })).headers.get('location'), '/invitations?notice=connection_not_found')
  const itemId = feed.text.match(/href="\/notifications\/([0-9a-f-]{36})"/)[1]
  assert.equal((await get(`/notifications/${itemId}`, third)).location, '/notifications')
  assert.equal((await notifications.counts(ada)).unread, 1)
  assert.equal((await get(`/notifications/${itemId}`, her)).location, '/invitations')
  assert.equal((await notifications.counts(ada)).unread, 0)
  assert.equal((await post('/connections/respond', her, { id: requestId, action: 'accept', next: '/notifications', extra: 'x' })).status, 400)
  const accepted = await post('/connections/respond', her, { id: requestId, action: 'accept', next: '/people/jacob-profile' })
  assert.equal(accepted.headers.get('location'), '/people/jacob-profile?connect=accepted')
  assert.match((await get('/people/jacob-profile?connect=accepted', her)).text, /You are now connected\..*?✓ Connected/s)
  assert.match((await get('/people/ada-profile', me)).text, /✓ Connected/)
  const jacobFeed = await get('/notifications', me)
  assert.match(jacobFeed.text, /<b>Ada Lovelace<\/b> accepted your invitation to connect/)
  const acceptedItem = jacobFeed.text.match(/href="\/notifications\/([0-9a-f-]{36})"/)[1]
  assert.equal((await get(`/notifications/${acceptedItem}`, me)).location, '/people/ada-profile')
  assert.equal((await post('/notifications/read-all', me, {})).headers.get('location'), '/notifications')
  assert.doesNotMatch((await get('/notifications', me)).text, /Mark all as read/)
})

test('end to end: withdraw from Sent, ignore privately, and account deletion clears everything', async t => {
  const { signIn, get, post, memberConnections, notifications } = await site(t)
  const me = await signIn('jacob-subject'), her = await signIn('ada-subject'), third = await signIn('grace-subject')
  await post('/connections/request', me, { profileId: 'ada-profile' })
  const sentTab = await get('/invitations?tab=sent', me)
  const id = sentTab.text.match(/action="\/connections\/withdraw"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="id" value="([^"]+)"/)[1]
  assert.equal((await post('/connections/withdraw', me, { id, next: '/invitations?tab=sent' })).headers.get('location'), '/invitations?tab=sent&notice=withdrawn')
  assert.match((await get('/invitations?tab=sent&notice=withdrawn', me)).text, /Invitation withdrawn\./)
  assert.match((await get('/notifications', her)).text, /Nothing yet/)
  assert.equal((await post('/connections/request', me, { profileId: 'ada-profile' })).headers.get('location'), '/people/ada-profile?connect=connection_cooldown')
  // Grace asks Ada; Ada ignores; Grace still sees it pending.
  await post('/connections/request', third, { profileId: 'ada-profile' })
  const [graceRequest] = await memberConnections.received(ada)
  assert.equal((await post('/connections/respond', her, { id: graceRequest.id, action: 'ignore' })).headers.get('location'), '/invitations?notice=ignored')
  assert.match((await get('/people/ada-profile', third)).text, /Pending<\/span>/)
  assert.doesNotMatch((await get('/invitations', her)).text, /Grace Hopper/)
  // Unknown query keys on /invitations are dropped.
  assert.equal((await get('/invitations?x=1', her)).location, '/invitations')
  const deleted = await post('/delete-account', third, { confirm: 'delete everything' })
  assert.equal(deleted.status, 200)
  assert.deepEqual(await memberConnections.sent(grace), [])
  assert.equal((await notifications.list(ada)).some(value => value.actorName === 'Grace Hopper'), false)
})
