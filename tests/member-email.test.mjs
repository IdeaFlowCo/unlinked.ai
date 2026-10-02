import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { accountKey, createMemberEmail, createMemoryEmailStore, createNeo4jEmailStore, createResendTransport, createUnsubscribeTokens, emailAddress, emailConfig, headerText, inviteEmail, senderName,
  DEFAULT_EMAIL_FROM, INVITE_EMAILS_PER_DAY, INVITE_RECIPIENT_COOLDOWN_MS, RESEND_ENDPOINT } from '../mcp-server/member-email.mjs'
import { createNotifications, createMemoryNotificationStore, createNeo4jNotificationStore } from '../mcp-server/member-notifications.mjs'
import { createMemberInvitations, createMemoryInvitationStore } from '../mcp-server/member-invitations.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const origin = 'https://www.unlinked.ai'
const secret = new Uint8Array(32).fill(7)
const jacob = { ownerId: 'jacob-owner', userId: 'jacob-user' }, ada = { ownerId: 'ada-owner', userId: 'ada-user' }, grace = { ownerId: 'grace-owner', userId: 'grace-user' }
const MINUTE = 60 * 1000, DAY = 24 * 60 * MINUTE
const on = emailConfig({ RESEND_API_KEY: 're_synthetic_key' })
const fakeTransport = ({ fail = 0 } = {}) => {
  const sent = []
  let failures = fail
  return { sent, async send(message) { if (failures > 0) { failures--; throw Object.assign(new Error('email_transport_status_500'), { code: 'email_transport_status_500' }) } sent.push(structuredClone(message)); return { id: `fake-${sent.length}` } } }
}
const TOKEN = 'A'.repeat(43)

function setup({ config = on, transport = fakeTransport(), clock = { now: 10 * DAY }, ...options } = {}) {
  const store = createMemoryEmailStore(), notificationStore = createMemoryNotificationStore()
  const notifications = createNotifications({ store: notificationStore, now: () => clock.now })
  const errors = []
  const email = createMemberEmail({ config, transport, store, notificationStore, secret, origin, now: () => clock.now, onError: event => { errors.push(event) }, ...options })
  return { store, notificationStore, notifications, email, transport, clock, errors }
}
const request = (notifications, recipient, actorName, key, kind = 'connection_request_received') => notifications.notify({ recipient, kind, actor: grace, actorName, dedupeKey: key })

test('configuration: the flag defaults on, "false"/"0" turn it off, no key sends nothing, and the key never serializes', () => {
  assert.equal(on.enabled, true); assert.deepEqual(on.from, { name: 'Unlinked', address: 'noreply@id.ideaflow.app' })
  assert.equal(DEFAULT_EMAIL_FROM, 'Unlinked <noreply@id.ideaflow.app>')
  for (const flag of ['false', '0', 'off', 'NO', ' False ']) assert.equal(emailConfig({ RESEND_API_KEY: 'k', UNLINKED_EMAIL_ENABLED: flag }).enabled, false)
  for (const flag of ['true', '1', '', undefined]) assert.equal(emailConfig({ RESEND_API_KEY: 'k', UNLINKED_EMAIL_ENABLED: flag }).enabled, true)
  assert.equal(emailConfig({}).enabled, false); assert.equal(emailConfig({ RESEND_API_KEY: '  ' }).enabled, false)
  assert.equal(emailConfig({ RESEND_API_KEY: 'k', UNLINKED_EMAIL_FROM: 'Evil\r\nBcc: x@y.z <a@b.co>' }).enabled, false)
  assert.deepEqual(emailConfig({ RESEND_API_KEY: 'k', UNLINKED_EMAIL_FROM: 'Ideaflow <hello@id.ideaflow.app>' }).from, { name: 'Ideaflow', address: 'hello@id.ideaflow.app' })
  assert.doesNotMatch(JSON.stringify(on), /re_synthetic_key/); assert.equal(on.apiKey, 're_synthetic_key')
  assert.throws(() => createResendTransport({}), /email_transport_key_required/)
})

test('with email switched off or no key, nothing is sent and no address is recorded', async () => {
  for (const config of [emailConfig({ RESEND_API_KEY: 'k', UNLINKED_EMAIL_ENABLED: 'false' }), emailConfig({ UNLINKED_EMAIL_ENABLED: 'true' }), emailConfig({})]) {
    const { email, store, notifications, transport, clock } = setup({ config })
    assert.equal(email.sending, false)
    assert.equal(await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true }), false)
    assert.equal(store.recipients.size, 0)
    assert.deepEqual(await email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Ada', address: 'ada@example.com', token: TOKEN }), { sent: false, reason: 'off' })
    await request(notifications, jacob, 'Grace', 'k1'); clock.now += 5 * MINUTE
    assert.deepEqual(await email.runNotifications(), { sent: 0, skipped: 0, waiting: 0, failed: 0 })
    assert.equal(email.start(), false)
    assert.equal(transport.sent.length, 0)
  }
})

test('the invite email carries the exact link, comes from the member, replies to their verified address and can be unsubscribed', async () => {
  const { email, transport, store } = setup()
  await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true })
  const result = await email.sendInvite({ inviter: jacob, inviterName: 'Jacob Cole', inviteeName: 'Ada Lovelace', address: ' ada@example.com ', token: TOKEN, invitationId: 'inv-1' })
  assert.deepEqual(result, { sent: true })
  const [sent] = transport.sent
  assert.equal(sent.to, 'ada@example.com'); assert.equal(sent.replyTo, 'jacob@example.com')
  assert.equal(sent.from, '"Jacob Cole via Unlinked" <noreply@id.ideaflow.app>')
  assert.equal(sent.subject, 'Jacob Cole invited you to Unlinked')
  assert.ok(sent.text.includes(`${origin}/i/${TOKEN}`)); assert.ok(sent.html.includes(`${origin}/i/${TOKEN}`))
  assert.match(sent.text, /You got this email because Jacob Cole entered your address/); assert.match(sent.text, /Reply to this email/)
  assert.match(sent.headers['List-Unsubscribe'], /^<https:\/\/www\.unlinked\.ai\/email\/unsubscribe\?t=v1\.[A-Za-z0-9_.-]+>$/)
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.equal(sent.idempotencyKey, 'unlinked-invite-inv-1')
  // Only a keyed hash of the invitee's address is kept, never the address.
  assert.doesNotMatch(JSON.stringify([...store.sends.values()]), /ada@example\.com/)
  // An unverified sender address is never used as Reply-To.
  const other = setup()
  await other.email.rememberAddress(jacob, { address: 'jacob@example.com', verified: false })
  await other.email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Ada', address: 'ada@example.com', token: TOKEN })
  assert.equal(other.transport.sent[0].replyTo, undefined); assert.doesNotMatch(other.transport.sent[0].text, /Reply to this email/)
  // Unsubscribing from an invite suppresses that address for every member.
  const token = decodeURIComponent(sent.headers['List-Unsubscribe'].match(/t=([^>]+)/)[1])
  assert.equal((await email.unsubscribe(token)).scope, 'address')
  assert.deepEqual(await email.sendInvite({ inviter: ada, inviterName: 'Ada', inviteeName: 'Ada', address: 'ADA@example.com', token: TOKEN }), { sent: false, reason: 'unavailable' })
})

test('invite emails are limited per member per day and per recipient per week; a failed send does not count', async () => {
  const clock = { now: 10 * DAY }, { email, transport, store } = setup({ clock })
  for (let index = 0; index < INVITE_EMAILS_PER_DAY; index++) assert.equal((await email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'P', address: `p${index}@example.com`, token: TOKEN })).sent, true)
  assert.deepEqual(await email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'P', address: 'one-more@example.com', token: TOKEN }), { sent: false, reason: 'member_limit' })
  // Another member cannot email someone invited in the last seven days.
  assert.deepEqual(await email.sendInvite({ inviter: ada, inviterName: 'Ada', inviteeName: 'P', address: 'P0@Example.com', token: TOKEN }), { sent: false, reason: 'unavailable' })
  clock.now += DAY + 1
  assert.equal((await email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'P', address: 'one-more@example.com', token: TOKEN })).sent, true)
  assert.deepEqual(await email.sendInvite({ inviter: ada, inviterName: 'Ada', inviteeName: 'P', address: 'p0@example.com', token: TOKEN }), { sent: false, reason: 'unavailable' })
  clock.now += INVITE_RECIPIENT_COOLDOWN_MS
  assert.equal((await email.sendInvite({ inviter: ada, inviterName: 'Ada', inviteeName: 'P', address: 'p0@example.com', token: TOKEN })).sent, true)
  assert.equal(transport.sent.length, INVITE_EMAILS_PER_DAY + 2)
  // Failures release their reservation, so the member can try again.
  const failing = setup({ transport: fakeTransport({ fail: 1 }) })
  assert.deepEqual(await failing.email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Ada', address: 'ada@example.com', token: TOKEN }), { sent: false, reason: 'failed' })
  assert.equal(failing.store.sends.size, 0); assert.deepEqual(failing.errors, [{ event: 'email_invite_failed', code: 'email_invite_error' }])
  assert.equal((await failing.email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Ada', address: 'ada@example.com', token: TOKEN })).sent, true)
  // Malformed input never reaches the transport.
  assert.deepEqual(await email.sendInvite({ inviter: grace, inviterName: 'G', inviteeName: 'x', address: 'not an address', token: TOKEN }), { sent: false, reason: 'invalid' })
  assert.deepEqual(await email.sendInvite({ inviter: grace, inviterName: 'G', inviteeName: 'x', address: 'a@b.co', token: '../x' }), { sent: false, reason: 'invalid' })
  assert.ok(store.sends.size <= INVITE_EMAILS_PER_DAY + 2)
})

test('CR/LF and markup in names, subjects and addresses never reach a header', async () => {
  for (const value of ['a@b.co\r\nBcc: x@y.z', 'a@b.co, c@d.co', 'A <a@b.co>', 'a@b', '@b.co', 'a..b@c.co', 'a b@c.co', `${'a'.repeat(250)}@b.co`]) assert.equal(emailAddress(value), null)
  assert.equal(headerText('Hi\r\nBcc: x@y.z there'), 'Hi Bcc: x@y.z there')
  assert.equal(senderName('Evil"\r\nBcc: x@y.z <z>'), 'An Unlinked member')
  assert.equal(senderName('Ada "The" <Countess>; Lovelace'), 'Ada The Countess Lovelace')
  assert.doesNotMatch(senderName('jacob@example.com'), /@/); assert.equal(senderName('\r\n'), 'An Unlinked member')
  const { email, transport, notifications, clock } = setup()
  await email.sendInvite({ inviter: jacob, inviterName: 'Jacob\r\nBcc: victim@example.com', inviteeName: 'Ada\r\nX-Evil: 1', address: 'ada@example.com', token: TOKEN })
  const [sent] = transport.sent
  for (const value of [sent.from, sent.subject, sent.to, ...Object.values(sent.headers)]) assert.doesNotMatch(value, /[\r\n]/)
  assert.doesNotMatch(sent.from, /victim@/)
  assert.equal(sent.from, '"An Unlinked member via Unlinked" <noreply@id.ideaflow.app>')
  await email.sendInvite({ inviter: jacob, inviterName: 'Jacob\r\nX-Evil: 1', inviteeName: 'Ada', address: 'ada2@example.com', token: TOKEN })
  assert.equal(transport.sent.at(-1).from, '"Jacob X-Evil 1 via Unlinked" <noreply@id.ideaflow.app>')
  const content = inviteEmail({ inviterName: '<b>Jacob</b>', inviteeName: '<i>Ada</i>', link: `${origin}/i/${TOKEN}`, unsubscribeUrl: `${origin}/email/unsubscribe?t=x` })
  assert.doesNotMatch(content.html, /<b>Jacob|<i>Ada/)
  // Notification subjects carry the actor's name; it is a single safe line.
  await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true })
  await request(notifications, jacob, 'Grace\r\nBcc: x', 'crlf'); clock.now += 5 * MINUTE
  await email.runNotifications()
  assert.doesNotMatch(transport.sent.at(-1).subject, /[\r\n]/)
})

test('unsubscribe tokens: forged, tampered, expired and out-of-scope tokens are rejected', () => {
  let now = 1000
  const tokens = createUnsubscribeTokens({ key: new Uint8Array(32).fill(1), now: () => now, ttlMs: 5000 })
  const subject = 'a'.repeat(64), token = tokens.issue({ scope: 'member', subject, kinds: ['invite_accepted'] })
  assert.deepEqual(tokens.verify(token), { scope: 'member', subject, kinds: ['invite_accepted'], expiresAt: 6000 })
  const forger = createUnsubscribeTokens({ key: new Uint8Array(32).fill(2), now: () => now })
  assert.equal(tokens.verify(forger.issue({ scope: 'member', subject, kinds: ['invite_accepted'] })), null)
  const [, body, mac] = token.split('.')
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), h: 'b'.repeat(64) })).toString('base64url')
  assert.equal(tokens.verify(`v1.${tampered}.${mac}`), null)
  assert.equal(tokens.verify(`v1.${body}.${mac.slice(0, -2)}AA`), null)
  for (const bad of [null, '', 'v2.' + body + '.' + mac, token + 'x', 'v1..', `v1.${body}`]) assert.equal(tokens.verify(bad), null)
  assert.equal(tokens.verify(tokens.issue({ scope: 'member', subject, kinds: ['invite'] })), null)
  assert.equal(tokens.verify(tokens.issue({ scope: 'address', subject, kinds: ['invite_accepted'] })), null)
  assert.equal(tokens.verify(tokens.issue({ scope: 'member', subject, kinds: [] })), null)
  assert.equal(tokens.verify(tokens.issue({ scope: 'member', subject: 'jacob@example.com', kinds: ['invite_accepted'] })), null)
  now = 6000
  assert.equal(tokens.verify(token), null)
})

test('notification emails respect preferences, skip what was already seen, and unsubscribe turns a kind off', async () => {
  const { email, transport, notifications, notificationStore, clock, store } = setup()
  await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true })
  // Defaults: profile_claimed is off, the other kinds are on.
  assert.deepEqual((await email.settings(jacob)).preferences, { connection_request_received: true, connection_request_accepted: true, invite_accepted: true, profile_claimed: false })
  await notifications.notify({ recipient: jacob, kind: 'profile_claimed', actor: grace, actorName: 'Grace', dedupeKey: 'claimed' })
  await email.savePreferences(jacob, ['connection_request_accepted'])
  await request(notifications, jacob, 'Grace', 'received')
  clock.now += 5 * MINUTE
  let result = await email.runNotifications()
  assert.deepEqual([result.sent, result.skipped], [0, 2]); assert.equal(transport.sent.length, 0)
  for (const record of notificationStore.records.values()) { assert.equal(record.emailedAt, clock.now); assert.equal(record.emailOutcome, 'skipped') }
  await notifications.notify({ recipient: jacob, kind: 'connection_request_accepted', actor: grace, actorName: 'Grace Hopper', dedupeKey: 'accepted' })
  clock.now += 5 * MINUTE
  result = await email.runNotifications()
  assert.equal(result.sent, 1)
  const [sent] = transport.sent
  assert.equal(sent.to, 'jacob@example.com'); assert.equal(sent.subject, 'Grace Hopper accepted your connection request'); assert.equal(sent.from, '"Unlinked" <noreply@id.ideaflow.app>')
  assert.match(sent.text, new RegExp(`${origin}/notifications/[0-9a-f-]{36}`)); assert.match(sent.text, /You got this email because you have an Unlinked account/)
  assert.equal(sent.replyTo, undefined)
  // One click: that kind goes off and nothing else changes.
  const token = decodeURIComponent(sent.headers['List-Unsubscribe'].match(/t=([^>]+)/)[1])
  assert.equal(email.inspectUnsubscribe(token).scope, 'member')
  assert.equal((await email.settings(jacob)).preferences.connection_request_accepted, true, 'inspecting changes nothing')
  await email.unsubscribe(token)
  assert.deepEqual((await email.settings(jacob)).preferences, { connection_request_received: false, connection_request_accepted: false, invite_accepted: false, profile_claimed: false })
  // Seen in the app before the mailer got to it: settled, not emailed.
  await email.savePreferences(jacob, ['invite_accepted'])
  await notifications.notify({ recipient: jacob, kind: 'invite_accepted', actor: ada, actorName: 'Ada', dedupeKey: 'invite' })
  await notifications.markSeen(jacob)
  clock.now += 30 * MINUTE
  assert.equal((await email.runNotifications()).sent, 0)
  // A member without a verified address is never emailed.
  await request(notifications, ada, 'Grace', 'ada-request')
  await email.rememberAddress(ada, { address: 'ada@example.com', verified: false })
  clock.now += 5 * MINUTE
  assert.deepEqual(await email.runNotifications(), { sent: 0, skipped: 1, waiting: 0, failed: 0 })
  assert.equal(transport.sent.length, 1)
  // Account deletion removes the stored address and choices.
  await email.removeOwner(jacob); assert.equal(store.recipients.has(accountKey(jacob)), false)
})

test('emailedAt is set exactly once across failures, retries, concurrent passes and stale claims', async () => {
  const transport = fakeTransport({ fail: 1 })
  const { email, notifications, notificationStore, clock, errors } = setup({ transport })
  await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true })
  await request(notifications, jacob, 'Grace', 'once')
  const [record] = notificationStore.records.values()
  // Too new: the member gets a minute to see it in the app first.
  assert.equal((await email.runNotifications()).sent, 0); assert.equal(record.emailClaim, undefined)
  clock.now += 2 * MINUTE
  assert.deepEqual(await email.runNotifications(), { sent: 0, skipped: 0, waiting: 0, failed: 1 })
  assert.equal(record.emailedAt, undefined); assert.equal(record.emailClaim, undefined)
  assert.deepEqual(errors, [{ event: 'email_notification_failed', code: 'email_notification_error' }])
  // Two passes at once: one email.
  const [first, second] = await Promise.all([email.runNotifications(), email.runNotifications()])
  assert.equal(first, second); assert.equal(first.sent, 1); assert.equal(transport.sent.length, 1)
  const stamped = record.emailedAt
  assert.equal(stamped, clock.now); assert.equal(record.emailOutcome, 'sent')
  clock.now += 60 * MINUTE
  assert.equal((await email.runNotifications()).sent, 0); assert.equal(record.emailedAt, stamped); assert.equal(transport.sent.length, 1)
  // Store-level compare-and-set: a second stamp or a foreign claim changes nothing.
  assert.equal(await notificationStore.markEmailed([record.id], { claim: null, at: 1, outcome: 'skipped' }), 0)
  await request(notifications, jacob, 'Grace', 'stale')
  const stale = [...notificationStore.records.values()].find(value => value.dedupeKey === 'stale')
  assert.deepEqual(await notificationStore.claimEmail([stale.id], { claim: 'crashed', at: clock.now, staleClaimBefore: clock.now - 10 * MINUTE }), [stale.id])
  assert.equal(await notificationStore.markEmailed([stale.id], { claim: 'other', at: clock.now, outcome: 'sent' }), 0)
  clock.now += 2 * MINUTE
  assert.equal((await email.runNotifications()).sent, 0, 'a live claim is left alone')
  clock.now += 10 * MINUTE
  assert.equal((await email.runNotifications()).sent, 1, 'a stale claim (crashed pass) is retried'); assert.ok(stale.emailedAt)
  // Retracted before sending: never emailed.
  await request(notifications, jacob, 'Grace', 'withdrawn')
  await notifications.retract('withdrawn', jacob)
  clock.now += 60 * MINUTE
  assert.equal((await email.runNotifications()).sent, 0)
  assert.equal(transport.sent.length, 2)
})

test('several notifications become one digest, and a member gets at most one email per window', async () => {
  const { email, transport, notifications, clock } = setup()
  await email.rememberAddress(jacob, { address: 'jacob@example.com', verified: true })
  await request(notifications, jacob, 'Grace', 'a'); await request(notifications, jacob, 'Ada', 'b')
  await notifications.notify({ recipient: jacob, kind: 'invite_accepted', actor: ada, actorName: 'Ada', dedupeKey: 'c' })
  clock.now += 2 * MINUTE
  assert.equal((await email.runNotifications()).sent, 1)
  assert.equal(transport.sent[0].subject, '3 new notifications on Unlinked'); assert.match(transport.sent[0].text, /Grace asked to connect/); assert.match(transport.sent[0].text, /\/notifications\n/)
  await request(notifications, jacob, 'Grace', 'd')
  clock.now += 2 * MINUTE
  assert.equal((await email.runNotifications()).waiting, 1)
  clock.now += 15 * MINUTE
  assert.equal((await email.runNotifications()).sent, 1); assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[1].subject, 'Grace wants to connect on Unlinked')
  // Old history is never emailed when email is first turned on.
  await request(notifications, ada, 'Grace', 'old')
  clock.now += 2 * DAY
  await email.rememberAddress(ada, { address: 'ada@example.com', verified: true })
  assert.equal((await email.runNotifications()).sent, 0)
})

test('the mailer timer never throws out of a tick, and stops cleanly', async () => {
  const broken = { ...createMemoryNotificationStore(), pendingEmail: async () => { throw new Error('graph down') } }
  const errors = []
  const email = createMemberEmail({ config: on, transport: fakeTransport(), store: createMemoryEmailStore(), notificationStore: broken, secret, origin, onError: event => { errors.push(event) } })
  assert.equal(email.start({ intervalMs: 5 }), true); assert.equal(email.start(), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  await email.stop()
  assert.ok(errors.length >= 1); assert.deepEqual(errors[0], { event: 'email_notifications_failed', code: 'email_mailer_error' })
})

test('the Resend transport posts JSON with the key only in the Authorization header', async () => {
  const calls = []
  const transport = createResendTransport({ apiKey: 're_secret', fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'email-id' }) } })
  assert.deepEqual(await transport.send({ from: '"Unlinked" <noreply@id.ideaflow.app>', to: 'a@b.co', replyTo: 'c@d.co', subject: 'S', text: 'T', html: '<p>T</p>', headers: { 'List-Unsubscribe': '<https://x>' }, idempotencyKey: 'k1' }), { id: 'email-id' })
  assert.equal(calls[0].url, RESEND_ENDPOINT); assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer re_secret'); assert.equal(calls[0].options.headers['Idempotency-Key'], 'k1')
  assert.deepEqual(JSON.parse(calls[0].options.body), { from: '"Unlinked" <noreply@id.ideaflow.app>', to: ['a@b.co'], subject: 'S', text: 'T', html: '<p>T</p>', reply_to: 'c@d.co', headers: { 'List-Unsubscribe': '<https://x>' } })
  const failing = createResendTransport({ apiKey: 're_secret', fetchImpl: async () => new Response('{"message":"bad a@b.co"}', { status: 422 }) })
  await assert.rejects(failing.send({ to: 'a@b.co' }), error => error.code === 'email_transport_status_422' && !/re_secret|a@b\.co/.test(error.message))
  const down = createResendTransport({ apiKey: 're_secret', fetchImpl: async () => { throw new Error('connect ECONNREFUSED re_secret') } })
  await assert.rejects(down.send({ to: 'a@b.co' }), error => error.code === 'email_transport_unreachable' && !/re_secret/.test(error.message))
})

test('graph stores add only their own constraints; notification email writes are compare-and-set', async () => {
  const calls = []
  const run = async (query, params) => { calls.push({ query, params }); return { records: [] } }
  const driver = { session: () => ({ close: async () => {}, executeWrite: work => work({ run }), executeRead: work => work({ run }) }) }
  await createNeo4jEmailStore(driver).initialize()
  assert.ok(calls.every(call => /^CREATE (CONSTRAINT|INDEX) unlinked_email_[a-z_]+ IF NOT EXISTS FOR \(e:UnlinkedEmail(Recipient|Suppression|Send)\)/.test(call.query)))
  calls.length = 0
  await createNeo4jNotificationStore(driver).initialize()
  assert.ok(calls.some(call => /CREATE INDEX unlinked_notification_created IF NOT EXISTS/.test(call.query)))
  calls.length = 0
  const notificationStore = createNeo4jNotificationStore(driver)
  await notificationStore.claimEmail(['id'], { claim: 'c', at: 1, staleClaimBefore: 0 })
  assert.match(calls.at(-1).query, /WHERE coalesce\(n\.retracted, false\) = false AND n\.emailedAt IS NULL AND \(n\.emailClaim IS NULL OR n\.emailClaimAt < \$staleClaimBefore\)/)
  await notificationStore.markEmailed(['id'], { claim: 'c', at: 1, outcome: 'sent' })
  assert.match(calls.at(-1).query, /n\.emailedAt IS NULL AND \(CASE WHEN \$claim IS NULL/)
  assert.match(calls.at(-1).query, /SET n\._notificationLock/)
  await notificationStore.pendingEmail({ since: 0, before: 1, staleClaimBefore: 0, limit: 500 })
  assert.match(calls.at(-1).query, /LIMIT 500$/)
  // Only hashes of invitee addresses reach the graph.
  const email = createMemberEmail({ config: on, transport: fakeTransport(), store: createNeo4jEmailStore(driver), secret, origin })
  calls.length = 0
  await email.sendInvite({ inviter: jacob, inviterName: 'Jacob', inviteeName: 'Ada', address: 'ada@example.com', token: TOKEN })
  assert.ok(calls.length > 0); assert.doesNotMatch(JSON.stringify(calls), /ada@example\.com/)
})

// --- Browser routes ---------------------------------------------------------

async function site(t, { memberEmail, invites = createMemberInvitations({ store: createMemoryInvitationStore() }), verified = true }) {
  const owners = { 'jacob-subject': jacob, 'ada-subject': ada }
  let next = 'jacob-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  // A factory receives the test server's origin, so email links point at it.
  if (typeof memberEmail === 'function') memberEmail = memberEmail(baseUrl)
  const backend = () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null })
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', memberInvitations: invites, memberEmail,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: next, verifiedEmail: `${next.split('-')[0]}@example.com`, providerEmailVerified: verified, displayName: next === 'jacob-subject' ? 'Jacob Cole' : 'Ada Lovelace' }) },
    resolveOwner: async identity => owners[identity.subject], signup: async identity => owners[identity.subject], issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async () => backend() })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async subject => {
    next = subject
    const begin = await request('/login')
    const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  const csrfOf = async cookie => (await (await request('/settings', { headers: { Cookie: cookie } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
  const post = (path, cookie, form, headers = { Origin: baseUrl }) => request(path, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  return { request, signIn, csrfOf, post, baseUrl }
}

test('browser: invite by email sends the shown link, never echoes the address, and refuses a bad address', async t => {
  const transport = fakeTransport(), store = createMemoryEmailStore()
  const { request, signIn, csrfOf, post } = await site(t, { memberEmail: createMemberEmail({ config: on, transport, store, secret, origin }) })
  const cookie = await signIn('jacob-subject'), csrf = await csrfOf(cookie)
  const form = await (await request('/invites', { headers: { Cookie: cookie } })).text()
  assert.match(form, /name="inviteeEmail" type="email"/)
  const bad = await post('/invites', cookie, { csrf, inviteeName: 'Ada', inviteeEmail: 'ada@example.com\r\nBcc: x@y.z' })
  assert.equal(bad.status, 400); assert.match(await bad.text(), /does not look right\. Nothing was created/); assert.equal(transport.sent.length, 0)
  const created = await (await post('/invites', cookie, { csrf, inviteeName: 'Ada Lovelace', inviteeEmail: 'ada.l@example.org' })).text()
  assert.match(created, /We emailed the invite for you/); assert.doesNotMatch(created, /ada\.l@example\.org/)
  assert.equal(transport.sent.length, 1)
  const token = created.match(/\/i\/([A-Za-z0-9_-]{43})/)[1]
  assert.ok(transport.sent[0].text.includes(`${origin}/i/${token}`)); assert.equal(transport.sent[0].to, 'ada.l@example.org')
  assert.equal(transport.sent[0].replyTo, 'jacob@example.com', 'the verified sign-in address was remembered at sign-in')
  assert.equal(transport.sent[0].from, '"Jacob Cole via Unlinked" <noreply@id.ideaflow.app>')
  // No address: the old copy-a-link flow, nothing sent.
  assert.match(await (await post('/invites', cookie, { csrf, inviteeName: 'Grace' })).text(), /Send this link yourself/); assert.equal(transport.sent.length, 1)
})

test('browser: with email off, the invite form and Settings look as before and email fields are refused', async t => {
  const memberEmail = createMemberEmail({ config: emailConfig({}), transport: null, store: createMemoryEmailStore(), secret, origin })
  const { request, signIn, csrfOf, post } = await site(t, { memberEmail })
  const cookie = await signIn('jacob-subject'), csrf = await csrfOf(cookie)
  assert.doesNotMatch(await (await request('/invites', { headers: { Cookie: cookie } })).text(), /inviteeEmail/)
  assert.doesNotMatch(await (await request('/settings', { headers: { Cookie: cookie } })).text(), /id="email"/)
  assert.equal((await post('/invites', cookie, { csrf, inviteeName: 'Ada', inviteeEmail: 'ada@example.com' })).status, 400)
})

test('browser: Settings shows only the member’s own address and saves choices; unsubscribe works signed out and one-click', async t => {
  const transport = fakeTransport(), store = createMemoryEmailStore()
  let memberEmail
  const { request, signIn, csrfOf, post } = await site(t, { memberEmail: baseUrl => (memberEmail = createMemberEmail({ config: on, transport, store, secret, origin: baseUrl })) })
  const cookie = await signIn('jacob-subject'), csrf = await csrfOf(cookie)
  const settings = await (await request('/settings', { headers: { Cookie: cookie } })).text()
  assert.match(settings, /<h2 id="email">Email<\/h2>/); assert.match(settings, /Emails go to <b>jacob@example\.com<\/b>/)
  assert.match(settings, /name="kinds" value="connection_request_received" checked/); assert.match(settings, /name="kinds" value="profile_claimed">/)
  assert.equal((await post('/settings/email', cookie, { csrf, kinds: 'nonsense' })).status, 400)
  assert.equal((await post('/settings/email', cookie, { csrf: 'wrong', kinds: 'invite_accepted' })).status, 400)
  const saved = await post('/settings/email', cookie, { csrf, kinds: 'invite_accepted' })
  assert.equal(saved.status, 303); assert.equal(saved.headers.get('location'), '/settings?email=saved#email')
  assert.deepEqual(Object.entries((await memberEmail.settings(jacob)).preferences).filter(([, value]) => value).map(([kind]) => kind), ['invite_accepted'])
  assert.match(await (await request('/settings?email=saved', { headers: { Cookie: cookie } })).text(), /Email settings saved/)
  // An unsubscribe link, opened signed out: GET only confirms.
  const key = accountKey(jacob)
  const token = createUnsubscribeTokens({ key: createHmac('sha256', secret).update('unlinked-email-unsubscribe-key-v1').digest() }).issue({ scope: 'member', subject: key, kinds: ['invite_accepted'] })
  const page = await request(`/email/unsubscribe?t=${token}`)
  assert.equal(page.status, 200); assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.match(await page.text(), /Stop emails like this one\?/)
  assert.equal((await memberEmail.settings(jacob)).preferences.invite_accepted, true)
  // RFC 8058 one-click: posted by the mail provider, no Origin, no cookie.
  const oneClick = await post(`/email/unsubscribe?t=${token}`, null, { 'List-Unsubscribe': 'One-Click' }, {})
  assert.equal(oneClick.status, 200); assert.match(await oneClick.text(), /You are unsubscribed/)
  assert.equal((await memberEmail.settings(jacob)).preferences.invite_accepted, false)
  // Forged or garbage tokens change nothing.
  const forged = createUnsubscribeTokens({ key: new Uint8Array(32).fill(9) }).issue({ scope: 'member', subject: key, kinds: ['connection_request_received'] })
  assert.equal((await request(`/email/unsubscribe?t=${forged}`)).status, 400)
  assert.equal((await post('/email/unsubscribe', null, { t: forged }, {})).status, 400)
  assert.equal((await post('/email/unsubscribe', null, { t: forged, extra: '1' }, {})).status, 400)
  // The origin exemption is exact: other POSTs without Origin are still refused.
  assert.equal((await post('/settings/email', cookie, { csrf, kinds: 'invite_accepted' }, {})).status, 403)
})

test('browser: an unverified sign-in address is never shown as the email destination', async t => {
  const memberEmail = createMemberEmail({ config: on, transport: fakeTransport(), store: createMemoryEmailStore(), secret, origin })
  const { request, signIn } = await site(t, { memberEmail, verified: false })
  const cookie = await signIn('jacob-subject')
  const settings = await (await request('/settings', { headers: { Cookie: cookie } })).text()
  assert.match(settings, /We do not have a verified email address/); assert.doesNotMatch(settings, /Emails go to/)
})
