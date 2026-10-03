import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { EXPORT_AGENT_PROMPT, EXPORT_DELAY_MS, exportCalendarLink, exportCalendarIcs, icsEscape, hasCompletedExport } from '../mcp-server/export-onboarding.mjs'
import { renderLanding, renderExportWaiting, renderBringArchive, agentSetupCopyScript, EXPORT_WAIT_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'
import { accountKey, createMemberEmail, createMemoryEmailStore, createNeo4jEmailStore, createUnsubscribeTokens, emailConfig } from '../mcp-server/member-email.mjs'
import { ADDED_PERSON } from '../src/utils/private-import/background-job.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const member = { ownerId: 'example-owner', userId: 'example-user' }
const secret = new Uint8Array(32).fill(8)
const config = emailConfig({ RESEND_API_KEY: 'fictional', UNLINKED_EMAIL_SECRET: Buffer.from(secret).toString('hex') })
const origin = 'https://www.unlinked.ai'
const decode = text => text.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
function mailer({ store = createMemoryEmailStore(), clock = { now: 1000 }, completed = async () => false, enabled = config, transport } = {}) {
  const sent = []
  const email = createMemberEmail({ config: enabled, store, secret, origin, now: () => clock.now, hasCompletedImport: completed, transport: transport ?? { send: async value => { sent.push(value) } } })
  return { email, store, clock, sent }
}
const signup = email => email.rememberAddress(member, { address: 'member@example.test', verified: true, newAccount: true })

test('landing emits the approved export CTA, fictional demo and mobile self-email link', () => {
  const { content } = renderLanding()
  assert.match(content, /href="https:\/\/www.linkedin.com\/mypreferences\/d\/download-my-data" target="_blank" rel="noopener noreferrer">Start my LinkedIn export ↗/)
  const mailto = new URL(decode(content.match(/href="(mailto:[^"]+)"/)[1]))
  assert.equal(mailto.pathname, '', 'anonymous email is addressed by the member to themself')
  assert.match(mailto.searchParams.get('body'), /https:\/\/www.linkedin.com\/mypreferences\/d\/download-my-data/)
  assert.match(mailto.searchParams.get('body'), /https:\/\/www.unlinked.ai\/join/)
  assert.match(content, /or join now and do the export later/)
  assert.equal((content.match(/<li><span>[1-4]<\/span>/g) ?? []).length, 4)
  for (const name of ['Maya Chen', 'Priya Shah', 'Marcus Reed', 'Jordan Ellis', 'Elena Torres']) assert.ok(content.includes(name))
  assert.match(content, /example with fictional people/)
  assert.doesNotMatch(content, /style="|onclick=|(?:href|src)="data:|private\.unlinked\.ai/)
})

test('calendar exports a CRLF, folded RFC 5545 event 48 hours later with the canonical upload URL', () => {
  const at = Date.parse('2026-10-02T12:34:56Z'), ics = exportCalendarIcs(at)
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/)
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75)
  const unfolded = ics.replace(/\r\n /g, '')
  assert.match(unfolded, /DTSTART:20261004T123456Z\r\nDTEND:20261004T124456Z/)
  assert.match(unfolded, /URL:https:\/\/www.unlinked.ai\/import/)
  assert.match(unfolded, /SUMMARY:Upload your LinkedIn file to Unlinked/)
  assert.equal(exportCalendarIcs(at), ics)
  assert.equal(icsEscape('one,two;three\\four\r\nfive'), 'one\\,two\\;three\\\\four\\nfive')
  const calendar = new URL(exportCalendarLink(at))
  assert.equal(calendar.hostname, 'calendar.google.com')
  assert.equal(calendar.searchParams.get('dates'), '20261004T123456Z/20261004T124456Z')
  assert.match(calendar.searchParams.get('details'), /https:\/\/www.unlinked.ai\/import/)
})

test('wait page defaults email on, toggles independently and copies the exact approved prompt under a nonce-ready script', async () => {
  const { email } = mailer(); await signup(email)
  const content = renderExportWaiting({ csrf: 'safe', reminder: await email.settings(member), at: 1000 }).content
  assert.match(content, /On ✓ \(default\)/)
  assert.match(content, /name="enabled" value="off"/)
  assert.match(content, /Download .ics/)
  assert.doesNotMatch(content, /style="|onclick=|<script/)
  const value = decode(content.match(/id="export-agent-prompt"[^>]*>(.*?)<\/textarea>/s)[1])
  assert.equal(value, EXPORT_AGENT_PROMPT)
  let click, copied
  const field = { value, focus() {}, select() {} }, help = { textContent: '' }
  vm.runInNewContext(agentSetupCopyScript(), { document: { querySelectorAll: () => [{ getAttribute: key => key === 'data-copy-target' ? 'prompt' : 'help', addEventListener: (_, handler) => { click = handler } }], getElementById: id => id === 'prompt' ? field : help }, navigator: { clipboard: { writeText: async text => { copied = text } } } })
  await click(); assert.equal(copied, EXPORT_AGENT_PROMPT); assert.equal(help.textContent, 'Copied.')
  await email.setExportReminder(member, false)
  assert.match(renderExportWaiting({ reminder: await email.settings(member) }).content, /name="enabled" value="on"/)
  assert.equal((await email.settings(member)).preferences.connection_request_received, true)
  assert.match(renderBringArchive({}).content, /Link expired\? <a[^>]*>Request a new one from LinkedIn ↗/)
})

test('banner dismissal survives navigation in the session and is accessible', () => {
  let click
  const values = new Map(), banner = { hidden: false }, button = { addEventListener: (_, handler) => { click = handler } }
  const context = { document: { getElementById: id => id === 'export-wait-banner' ? banner : button }, sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } }
  vm.runInNewContext(EXPORT_WAIT_SCRIPT, context); click(); assert.equal(banner.hidden, true)
  banner.hidden = false; vm.runInNewContext(EXPORT_WAIT_SCRIPT, context); assert.equal(banner.hidden, true)
})

test('one email at signup+48h, including overlapping workers and a restarted service', async () => {
  const { email, store, clock, sent } = mailer()
  await signup(email)
  clock.now += EXPORT_DELAY_MS - 1
  assert.equal((await email.runExportReminders()).sent, 0)
  clock.now++
  const other = mailer({ store, clock, transport: { send: async message => sent.push(message) } }).email
  await Promise.all([email.runExportReminders(), other.runExportReminders(), email.runExportReminders()])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /https:\/\/www.unlinked.ai\/import/)
  assert.ok(sent[0].headers['List-Unsubscribe'])
  assert.equal(store.recipients.get(accountKey(member)).exportReminderOutcome, 'sent')
  clock.now += EXPORT_DELAY_MS
  await signup(other); await other.runExportReminders(); assert.equal(sent.length, 1)
})

test('completed imports, disabled preference, unverified addresses and old logins are never reminded', async () => {
  for (const reason of ['completed', 'unsubscribed', 'unverified', 'old']) {
    const { email, store, clock, sent } = mailer({ completed: async () => reason === 'completed' })
    await email.rememberAddress(member, { address: 'member@example.test', verified: reason !== 'unverified', newAccount: reason !== 'old' })
    if (reason === 'unsubscribed') {
      const tokens = createUnsubscribeTokens({ key: createHmac('sha256', secret).update('unlinked-email-unsubscribe-key-v1').digest(), now: () => clock.now })
      assert.ok(await email.unsubscribe(tokens.issue({ scope: 'member', subject: accountKey(member), kinds: ['export_reminder'] })))
    }
    clock.now += EXPORT_DELAY_MS
    await email.runExportReminders(); assert.equal(sent.length, 0, reason)
    if (reason !== 'old') assert.equal(store.recipients.get(accountKey(member)).exportReminderOutcome, 'skipped')
  }
})

test('email flag suppresses sends, preserves signup time, and an eligibility read failure can be retried safely', async () => {
  const { email, store, clock, sent } = mailer({ enabled: { ...config, enabled: false } })
  await signup(email); clock.now += EXPORT_DELAY_MS
  await email.runExportReminders(); assert.equal(sent.length, 0)
  assert.equal(store.recipients.get(accountKey(member)).accountCreatedAt, 1000)
  const failed = mailer({ completed: async () => { throw new Error('backend_unavailable') } })
  await signup(failed.email); failed.clock.now += EXPORT_DELAY_MS
  assert.equal((await failed.email.runExportReminders()).failed, 1)
  assert.equal(failed.store.recipients.get(accountKey(member)).exportReminderClaimedAt, undefined)
  const recovered = mailer({ store: failed.store, clock: failed.clock })
  assert.equal((await recovered.email.runExportReminders()).sent, 1)
})

test('the runtime timer sends the due reminder without page requests, then stops cleanly', async () => {
  const { email, clock, sent } = mailer()
  await signup(email); clock.now += EXPORT_DELAY_MS
  assert.equal(email.start({ intervalMs: 2 }), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  await email.stop()
  assert.equal(sent.length, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sent.length, 1)
})

test('existing recipient signup timestamps never create a pre-feature reminder backlog', async () => {
  const { email, store, clock, sent } = mailer()
  store.recipients.set(accountKey(member), { accountKey: accountKey(member), ...member, address: 'member@example.test', verified: true, accountCreatedAt: 1 })
  await signup(email); clock.now += EXPORT_DELAY_MS
  await email.runExportReminders(); assert.equal(sent.length, 0)
  assert.equal(store.recipients.get(accountKey(member)).exportReminderDueAt, undefined)
})

test('an uncertain provider failure never repeats after restart, and reminder sweep is bounded', async () => {
  let attempts = 0
  const { email, store, clock } = mailer({ transport: { send: async () => { attempts++; throw new Error('timeout') } } })
  await signup(email); clock.now += EXPORT_DELAY_MS
  await email.runExportReminders()
  await mailer({ store, clock, transport: { send: async () => { attempts++ } } }).email.runExportReminders()
  assert.equal(attempts, 1)
  for (let i = 0; i < 105; i++) await email.rememberAddress({ ownerId: `o${i}`, userId: `u${i}` }, { address: 'member@example.test', verified: true, newAccount: true })
  clock.now += EXPORT_DELAY_MS; attempts = 0
  await email.runExportReminders(); assert.equal(attempts, 100)
})

test('only completed owner exports suppress the wait state, excluding added people and foreign, failed or deleted imports', async () => {
  let row
  const read = () => hasCompletedExport(member, async () => ({ listImportJobIds: async () => ['id'], readResource: async () => row }))
  const valid = { sourceId: 'id', sourceOwnerId: member.ownerId, payload: { id: 'id', ownerId: member.ownerId, status: 'indexed' } }
  row = valid; assert.equal(await read(), true)
  row = { ...valid, payload: { ...valid.payload, status: 'partial', counts: { indexed: 10, rejected: 2, failedFiles: 0 } } }; assert.equal(await read(), true)
  for (const invalid of [{ ...valid, deleted: true }, { ...valid, sourceOwnerId: 'foreign' }, { ...valid, payload: { ...valid.payload, ownerId: 'foreign' } }, { ...valid, payload: { ...valid.payload, status: 'failed' } }, { ...valid, payload: { ...valid.payload, status: 'partial', counts: { indexed: 10, rejected: 2, failedFiles: 1 } } }, { ...valid, payload: { ...valid.payload, receiptOf: 'other' } }, { ...valid, payload: { ...valid.payload, origin: { kind: ADDED_PERSON } } }]) { row = invalid; assert.equal(await read(), false) }
})

test('graph claims lock the recipient before checking eligibility and writing the permanent marker', async () => {
  const queries = [], data = { ...member, accountKey: accountKey(member), address: 'member@example.test', verified: true }
  const driver = { session: () => ({ close: async () => {}, executeWrite: async work => work({ run: async query => { queries.push(query); return { records: query.includes('RETURN') ? [{ get: () => data }] : [] } } }) }) }
  const result = await createNeo4jEmailStore(driver).claimExportReminder(accountKey(member), 500)
  assert.equal(result.address, data.address)
  assert.match(queries[0], /SET e\._emailLock/)
  assert.match(queries[1], /exportReminderClaimedAt IS NULL SET e.exportReminderClaimedAt/)
})

async function site(t) {
  let handler, signedUp = false
  const resources = new Map(), { email } = mailer()
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, memberEmail: email, dataMode: 'private_live', login: { begin: async () => ({ location: 'https://id.example.test/', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://id.example.test', subject: 'member', verifiedEmail: 'member@example.test', providerEmailVerified: true }) }, resolveOwner: async () => signedUp ? member : null, signup: async () => { signedUp = true; return member }, getBackend: async () => ({ adapter: {}, listImportJobIds: async () => [...resources.keys()], readResource: async (_, id) => resources.get(id) }), revokeAccountGrant: async () => {}, issueAccountGrant: async () => ({ id: 'grant', token: 'example' }) })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  assert.equal((await request('/export-reminder.ics')).status, 401)
  const begin = await request('/login'), loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: loginCookie } })
  assert.equal(callback.headers.get('location'), '/while-you-wait')
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  return { request: (path, options = {}) => request(path, { ...options, headers: { Cookie: cookie, ...options.headers } }), baseUrl, resources, email }
}

test('runtime serves wait page, authenticated calendar download, CSRF toggle, nonce copy script and banner until completed', async t => {
  const { request, resources, email, baseUrl } = await site(t)
  const waiting = await request('/while-you-wait'), content = await waiting.text()
  assert.equal(waiting.status, 200); assert.match(content, /Next: watch for LinkedIn’s email/)
  const nonce = waiting.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1]
  assert.ok(content.includes(`<script nonce="${nonce}">`)); assert.match(content, /navigator.clipboard.writeText/)
  const csrf = content.match(/name="csrf" value="([^"]+)"/)[1]
  assert.equal((await request('/export-reminder', { method: 'POST', headers: { Origin: baseUrl }, body: new URLSearchParams({ csrf: 'wrong', enabled: 'off' }) })).status, 400)
  assert.equal((await request('/export-reminder', { method: 'POST', headers: { Origin: baseUrl }, body: new URLSearchParams({ csrf, enabled: 'off' }) })).status, 303)
  assert.equal((await email.settings(member)).preferences.export_reminder, false)
  await email.setExportReminder(member, true)
  const tokens = createUnsubscribeTokens({ key: createHmac('sha256', secret).update('unlinked-email-unsubscribe-key-v1').digest(), now: () => 1000 })
  const token = tokens.issue({ scope: 'member', subject: accountKey(member), kinds: ['export_reminder'] })
  assert.equal((await request(`/email/unsubscribe?t=${token}`, { method: 'POST', body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) })).status, 200)
  assert.equal((await email.settings(member)).preferences.export_reminder, false)
  const calendar = await request('/export-reminder.ics')
  assert.equal(calendar.headers.get('content-type'), 'text/calendar; charset=utf-8'); assert.match(calendar.headers.get('content-disposition'), /attachment/)
  assert.match(await calendar.text(), /BEGIN:VCALENDAR\r\n/)
  assert.match(await (await request('/import')).text(), /id="export-wait-banner"/)
  resources.set('id', { sourceId: 'id', sourceOwnerId: member.ownerId, payload: { id: 'id', ownerId: member.ownerId, status: 'indexed' } })
  assert.doesNotMatch(await (await request('/import')).text(), /id="export-wait-banner"/)
  assert.equal((await request('/while-you-wait')).headers.get('location'), '/network')
})
