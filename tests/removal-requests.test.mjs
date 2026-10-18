// unlinked-ac9.3: anyone can ask Unlinked to remove a profile imported from
// members' LinkedIn connections ("Not on Unlinked"). The request is stored for
// the operator and emailed to the support inbox; the operator removes the
// profile with a reversible `remove` profile decision. All people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createSafetyReports, createMemorySafetyReportStore, createNeo4jSafetyReportStore, safetyReportRecord, supportReportEmail, SafetyReportError, SUPPORT_INBOX } from '../mcp-server/safety-reports.mjs'
import { operateSafetyReports } from '../mcp-server/safety-reports-operator.mjs'
import { operateProfileDecisions } from '../mcp-server/profile-decisions-operator.mjs'
import { applyProfileDecisions, validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const base = () => ({ state: 'published', complete: true, revision: 'removal-test',
  profiles: [profile('member', 'Avery Lee'), profile('imported', 'Morgan Singh', { headline: 'Engineer at Northwind' }), profile('copy', 'Morgan Singh'), profile('other', 'Sasha Baptiste'), profile('legacy', 'Lena Ito')],
  connections: [{ fromId: 'member', toId: 'imported' }, { fromId: 'member', toId: 'copy' }, { fromId: 'member', toId: 'other' }, { fromId: 'other', toId: 'imported' }],
  members: ['member'], legacyMembers: ['legacy'] })

async function site(t, { safetyReports, snapshot = base() } = {}) {
  const owner = { ownerId: 'removal-owner', userId: 'removal-user' }
  let handler
  const audits = []
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test', verifiedEmail: 'jordan@example.invalid', displayName: 'Jordan Rivera' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null }),
    readPublishedSnapshot: async () => snapshot, audit: async event => { audits.push(event) }, ...(safetyReports ? { safetyReports } : {}) })
  const go = (path, init = {}) => fetch(endpoint + path, { redirect: 'manual', ...init })
  const post = (path, fields, { cookie, origin = baseUrl } = {}) => go(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields) })
  const signIn = async () => {
    const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await go('/auth/callback/ideaflow?state=test&code=test', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { go, post, signIn, audits, owner }
}
const fakeTransport = () => { const sent = []; return { sent, send: async message => { sent.push(message); return { id: 'email-1' } } } }

test('a visitor without an account can request removal of an imported profile; it is stored and emailed to support', async t => {
  const store = createMemorySafetyReportStore(), transport = fakeTransport()
  const app = await site(t, { safetyReports: createSafetyReports({ store, transport, from: 'Unlinked <noreply@id.ideaflow.app>', origin: 'https://www.unlinked.ai' }) })
  const form = await app.go('/people/imported/removal')
  assert.equal(form.status, 200)
  assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  const page = await form.text()
  assert.match(page, /<h1 class="hq">Request removal<\/h1>/)
  assert.match(page, /Morgan Singh/)
  assert.match(page, /<form class="safety-form" method="post" action="\/people\/imported\/removal">/)
  assert.doesNotMatch(page, /name="csrf"/)
  for (const value of ['about_me', 'representative', 'other']) assert.match(page, new RegExp(`name="reason" value="${value}"`))
  // The profile links to the form.
  assert.match(await (await app.go('/people/imported')).text(), /href="\/people\/imported\/removal">Request removal<\/a>/)

  // Missing confirmation and invalid input re-show the form with the answers kept.
  const unconfirmed = await app.post('/people/imported/removal', { reason: 'about_me', details: 'This is me.' })
  assert.equal(unconfirmed.status, 400); assert.match(await unconfirmed.text(), /Please confirm the information is accurate/)
  const badEmail = await app.post('/people/imported/removal', { reason: 'about_me', contact: 'not-an-email', confirm: 'yes', details: 'kept text' })
  assert.equal(badEmail.status, 400)
  const badPage = await badEmail.text()
  assert.match(badPage, /That email address does not look right/); assert.match(badPage, />kept text<\/textarea>/)
  assert.equal((await app.post('/people/imported/removal', { confirm: 'yes' })).status, 400)
  assert.equal((await app.post('/people/imported/removal', { reason: 'other', confirm: 'yes' })).status, 400, '"Something else" needs details')
  // Unknown fields, a stray CSRF field without a session, or another origin are refused.
  assert.equal((await app.post('/people/imported/removal', { reason: 'about_me', confirm: 'yes', extra: 'x' })).status, 400)
  assert.equal((await app.post('/people/imported/removal', { reason: 'about_me', confirm: 'yes', csrf: 'x' })).status, 400)
  assert.equal((await app.post('/people/imported/removal', { reason: 'about_me', confirm: 'yes' }, { origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await store.list({ status: 'all' })).length, 0)

  const sent = await app.post('/people/imported/removal', { reason: 'about_me', details: 'I never joined.', contact: 'Morgan@Example.invalid', confirm: 'yes' })
  assert.equal(sent.status, 200)
  const done = await sent.text()
  assert.match(done, /<h1 class="hq">Request received<\/h1>/)
  const [report] = await store.list()
  assert.equal(report.kind, 'removal'); assert.equal(report.targetType, 'profile'); assert.equal(report.targetId, 'imported')
  assert.equal(report.targetName, 'Morgan Singh'); assert.equal(report.targetPresence, 'shadow'); assert.equal(report.reason, 'about_me')
  assert.equal(report.details, 'I never joined.'); assert.equal(report.contact, 'Morgan@Example.invalid'); assert.equal(report.reporterOwnerHash, null); assert.equal(report.status, 'open')
  assert.match(done, new RegExp(`Reference <b>${report.id.slice(0, 8).toUpperCase()}</b>`))
  assert.equal(transport.sent.length, 1)
  const [email] = transport.sent
  assert.equal(email.to, SUPPORT_INBOX); assert.equal(email.replyTo, 'Morgan@Example.invalid'); assert.equal(email.from, 'Unlinked <noreply@id.ideaflow.app>')
  assert.match(email.subject, /Unlinked removal request: This profile is about me · Morgan Singh/)
  assert.match(email.text, /https:\/\/www\.unlinked\.ai\/people\/imported/); assert.match(email.text, /profile-decisions-operator\.mjs remove imported/)
  assert.equal(email.idempotencyKey, `unlinked-safety-report-${report.id}`)
  // The audit names the event, never the person or the address.
  const audit = app.audits.find(event => event.event === 'safety_report_received')
  assert.deepEqual(Object.keys(audit).sort(), ['at', 'emailed', 'event', 'kind', 'origin', 'reference'])
})

test('a member profile is not removable this way; a honeypot answer stores nothing; signed-in requests carry CSRF and the reporter', async t => {
  const store = createMemorySafetyReportStore()
  const app = await site(t, { safetyReports: createSafetyReports({ store, origin: 'https://www.unlinked.ai' }) })
  const member = await app.go('/people/member/removal')
  assert.equal(member.status, 200); assert.match(await member.text(), /This person manages their own profile/)
  assert.equal((await app.post('/people/member/removal', { reason: 'about_me', confirm: 'yes' })).status, 200)
  assert.equal((await app.go('/people/nobody/removal')).status, 404)
  assert.equal((await app.go('/people/legacy/removal')).status, 200)
  const bot = await app.post('/people/imported/removal', { reason: 'about_me', confirm: 'yes', website: 'https://spam.invalid' })
  assert.equal(bot.status, 200); assert.match(await bot.text(), /Request received/)
  assert.equal((await store.list({ status: 'all' })).length, 0)

  const cookie = await app.signIn()
  const page = await (await app.go('/people/imported/removal', { headers: { Cookie: cookie } })).text()
  const csrf = page.match(/<form class="safety-form"[^>]*><input type="hidden" name="csrf" value="([^"]+)">/)?.[1]
  assert.ok(csrf)
  assert.equal((await app.post('/people/imported/removal', { reason: 'representative', confirm: 'yes' }, { cookie })).status, 400, 'CSRF required when signed in')
  assert.equal((await app.post('/people/imported/removal', { csrf, reason: 'representative', confirm: 'yes' }, { cookie })).status, 200)
  const [report] = await store.list()
  assert.match(report.reporterOwnerHash, /^[a-f0-9]{64}$/); assert.equal(report.reporterLabel, 'jordan@example.invalid')
  // Deleting the reporter's account keeps the request without who sent it.
  await store.forgetReporter(report.reporterOwnerHash)
  const kept = await store.read(report.id)
  assert.equal(kept.reporterOwnerHash, null); assert.equal(kept.reporterLabel, null); assert.equal(kept.targetId, 'imported')
})

test('without a report store the page says to email support; the site-wide budget bounds submissions', async t => {
  const plain = await site(t)
  const page = await (await plain.go('/people/imported/removal')).text()
  assert.match(page, /mailto:support@ideaflow\.app/); assert.doesNotMatch(page, /class="safety-form"/)
  const store = createMemorySafetyReportStore()
  const app = await site(t, { safetyReports: createSafetyReports({ store, origin: 'https://www.unlinked.ai' }) })
  const statuses = []
  for (let index = 0; index < 22; index++) statuses.push((await app.post('/people/imported/removal', { reason: 'about_me', confirm: 'yes' })).status)
  assert.equal(statuses.filter(status => status === 200).length, 20); assert.equal(statuses.at(-1), 429)
  assert.equal((await store.list({ limit: 100 })).length, 20)
})

test('a failed or slow email never loses a stored request', async () => {
  const store = createMemorySafetyReportStore(), errors = []
  const failing = createSafetyReports({ store, origin: 'https://www.unlinked.ai', from: 'Unlinked <noreply@id.ideaflow.app>', transport: { send: async () => { throw Object.assign(new Error('x'), { code: 'email_transport_status_500' }) } }, onError: event => errors.push(event) })
  const receipt = await failing.submit({ kind: 'removal', targetType: 'profile', targetId: 'imported', reason: 'about_me' })
  assert.equal(receipt.emailed, false); assert.equal((await store.list()).length, 1)
  assert.deepEqual(errors, [{ event: 'safety_report_email_failed', code: 'email_transport_status_500' }])
  const slow = createSafetyReports({ store, origin: 'https://www.unlinked.ai', from: 'x <noreply@id.ideaflow.app>', notifyTimeoutMs: 20, transport: { send: () => new Promise(() => {}) } })
  // The notify timeout is unref'd so it never holds a server open. A bare test
  // process has nothing else pending, and Node 22 (the release image) would end
  // the run before it fires, so keep the loop alive for this one call.
  const keepAlive = setInterval(() => {}, 1000)
  try { assert.equal((await slow.submit({ kind: 'removal', targetType: 'profile', targetId: 'imported', reason: 'about_me' })).emailed, false) }
  finally { clearInterval(keepAlive) }
  assert.equal((await store.list()).length, 2)
})

test('report records are validated and bounded; the email text is escaped', () => {
  const record = safetyReportRecord({ kind: 'removal', targetType: 'profile', targetId: 'imported', reason: 'about_me', details: ` a\u0000b\r\n${'x'.repeat(3000)}`, contact: '' }, { now: () => 7, id: () => 'fixed' })
  assert.equal(record.details.length, 2000); assert.ok(!record.details.includes('\u0000')); assert.equal(record.contact, null); assert.equal(record.createdAt, 7)
  for (const [input, code] of [[{ kind: 'nope' }, 'report_kind_invalid'], [{ kind: 'removal', reason: 'spam', targetType: 'profile', targetId: 'x' }, 'report_reason_required'], [{ kind: 'removal', reason: 'about_me', targetType: 'message', targetId: 'x' }, 'report_target_invalid'], [{ kind: 'removal', reason: 'about_me', targetType: 'profile', targetId: '' }, 'report_target_invalid'], [{ kind: 'removal', reason: 'about_me', targetType: 'profile', targetId: 'x', details: 'y'.repeat(5000) }, 'report_details_too_long']])
    assert.throws(() => safetyReportRecord(input), error => error instanceof SafetyReportError && error.code === code, code)
  const email = supportReportEmail({ ...record, targetName: '<b>Morgan</b>', details: '<script>' }, { origin: 'https://www.unlinked.ai' })
  assert.doesNotMatch(email.html, /<script>|<b>Morgan/); assert.match(email.html, /&lt;script&gt;/)
  assert.ok(LABELS.includes('UnlinkedSafetyReport'))
})

test('the operator lists, shows and decides reports, recording who decided', async () => {
  const store = createMemorySafetyReportStore()
  const reports = createSafetyReports({ store, origin: 'https://www.unlinked.ai' })
  const { id } = await reports.submit({ kind: 'removal', targetType: 'profile', targetId: 'imported', reason: 'about_me' })
  assert.equal((await operateSafetyReports({ args: ['list'], store })).reports.length, 1)
  assert.equal((await operateSafetyReports({ args: ['show', id], store })).report.id, id)
  const resolved = await operateSafetyReports({ args: ['resolve', id, 'jacob', 'removed with decision d1'], store, now: () => 9 })
  assert.equal(resolved.report.status, 'resolved'); assert.equal(resolved.report.decidedBy, 'jacob'); assert.equal(resolved.report.decidedAt, 9)
  assert.equal((await operateSafetyReports({ args: ['list'], store })).reports.length, 0)
  assert.equal((await operateSafetyReports({ args: ['list', 'resolved'], store })).reports.length, 1)
  for (const args of [['list', 'bogus'], ['resolve', id, 'jacob'], ['show'], ['delete', id]]) await assert.rejects(operateSafetyReports({ args, store }), /arguments_invalid/)
  await assert.rejects(operateSafetyReports({ args: ['show', 'missing'], store }), /not_found/)
})

test('a remove decision drops an imported profile, its edges and addresses merged into it; members are never removed; revoking restores it', async () => {
  const before = base()
  const merged = { id: 'm1', kind: 'merge', profileId: 'copy', survivorId: 'imported' }
  const after = applyProfileDecisions(before, [merged, { id: 'r1', kind: 'remove', profileId: 'imported' }, { id: 'r2', kind: 'remove', profileId: 'member' }, { id: 'r3', kind: 'remove', profileId: 'legacy' }])
  assert.deepEqual(after.profiles.map(value => value.id), ['member', 'other'])
  assert.deepEqual(after.connections, [{ fromId: 'member', toId: 'other' }])
  assert.deepEqual(after.aliases, {}); assert.deepEqual(after.members, ['member']); assert.deepEqual(after.legacyMembers, [])
  assert.notEqual(after.revision, applyProfileDecisions(before, [merged]).revision)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => after })
  assert.equal(await reader.profile({ id: 'imported' }), null); assert.equal(await reader.profile({ id: 'copy' }), null)
  assert.deepEqual((await reader.list()).profiles.map(value => value.id), ['member', 'other'])
  // Removing by a merged address removes the profile it resolves to.
  assert.deepEqual(applyProfileDecisions(base(), [merged, { id: 'r1', kind: 'remove', profileId: 'copy' }]).profiles.map(value => value.id), ['member', 'other', 'legacy'])
  assert.deepEqual(applyProfileDecisions(base(), []), base())
  assert.throws(() => validateProfileDecisions([{ id: 'a', kind: 'remove', profileId: 'x' }, { id: 'b', kind: 'remove', profileId: 'x' }]), /profile_decisions_invalid/)
  assert.throws(() => validateProfileDecisions([{ id: 'a', kind: 'remove' }]), /profile_decisions_invalid/)
})

test('the profile decisions operator records removals with who and why, and revokes them', async () => {
  const nodes = []
  const session = {
    executeRead: work => work({ run: async () => ({ records: nodes.filter(value => !value.revoked).map(value => ({ get: () => value })) }) }),
    executeWrite: work => work({ run: async (query, params) => {
      if (/^CREATE/.test(query)) { nodes.push({ ...params.decision }); return { records: [] } }
      const node = nodes.find(value => value.id === params.id && !value.revoked)
      if (node) Object.assign(node, { revoked: true })
      return { records: node ? [{ get: () => node.id }] : [] }
    } }),
  }
  const removed = await operateProfileDecisions({ args: ['remove', 'imported', 'jacob', 'removal request 1A2B3C4D'], session })
  assert.equal(removed.decision.kind, 'remove'); assert.equal(removed.decision.reason, 'removal request 1A2B3C4D'); assert.equal(removed.decision.decidedBy, 'jacob')
  await assert.rejects(operateProfileDecisions({ args: ['remove', 'imported', 'jacob', 'again'], session }), /profile_decisions_invalid/)
  await assert.rejects(operateProfileDecisions({ args: ['remove', 'imported', 'jacob'], session }), /arguments_invalid/)
  await operateProfileDecisions({ args: ['revoke', removed.decision.id, 'jacob'], session })
  assert.equal((await operateProfileDecisions({ args: ['list'], session })).decisions.length, 0)
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const enabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('real Neo4j safety reports: create, list by status, decide and forget the reporter', { skip: !enabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const store = createNeo4jSafetyReportStore(driver)
  const target = 'neo4j-test-' + randomUUID(), hash = 'f'.repeat(64)
  t.after(async () => { const session = driver.session(); try { await session.run('MATCH (r:UnlinkedSafetyReport {targetId: $target}) DETACH DELETE r', { target }) } finally { await session.close(); await driver.close() } })
  await store.initialize(); await store.initialize()
  const reports = createSafetyReports({ store, origin: 'https://www.unlinked.ai' })
  const first = await reports.submit({ kind: 'removal', targetType: 'profile', targetId: target, targetName: 'Morgan', reason: 'about_me', contact: 'm@example.invalid', reporterOwnerHash: hash, reporterLabel: 'r@example.invalid' })
  const stored = await store.read(first.id)
  assert.equal(stored.targetId, target); assert.equal(stored.contact, 'm@example.invalid'); assert.equal(stored.details, null); assert.equal(typeof stored.createdAt, 'number')
  assert.ok((await store.list({ status: 'open', limit: 500 })).some(value => value.id === first.id))
  const decided = await store.setStatus(first.id, { status: 'dismissed', by: 'jacob', note: 'duplicate', at: 11 })
  assert.equal(decided.status, 'dismissed'); assert.equal(decided.decidedAt, 11)
  await store.forgetReporter(hash)
  const forgotten = await store.read(first.id)
  assert.equal(forgotten.reporterOwnerHash, null); assert.equal(forgotten.contact, null); assert.equal(forgotten.reporterLabel, null)
})

// The composition's store reaches the browser only if the pilot forwards it (the 0.6.25 lesson).
test('the isolated pilot forwards the safety report service to the browser', async t => {
  const { startPrivatePilot } = await import('../mcp-server/private-pilot.mjs')
  const { randomBytes } = await import('node:crypto')
  const { createServer: createNetServer } = await import('node:net')
  let port
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    const candidate = 7000 + Math.floor(Math.random() * 3000)
    if (await new Promise(resolve => { const probe = createNetServer().once('error', () => resolve(false)).listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true))) })) port = candidate
  }
  const store = createMemorySafetyReportStore()
  const owner = { ownerId: 'pilot-owner', userId: 'pilot-user' }
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  const running = await startPrivatePilot({ baseUrl: `https://127.0.0.1:${port}`, port, host: '127.0.0.1', dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'x' }) },
    resolveOwner: async () => owner, signup: async () => owner, accountGrantKey: randomBytes(32), getBackend: async () => backend,
    complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => base(), safetyReports: createSafetyReports({ store, origin: 'https://www.unlinked.ai' }) })
  t.after(() => running.stop())
  const sent = await fetch(`http://127.0.0.1:${port}/people/imported/removal`, { method: 'POST', headers: { Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ reason: 'about_me', confirm: 'yes' }) })
  assert.equal(sent.status, 200)
  assert.equal((await store.list()).length, 1)
})
