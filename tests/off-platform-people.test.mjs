import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createMemberInvitations, createMemoryInvitationStore, createNeo4jInvitationStore, InvitationError } from '../mcp-server/member-invitations.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const inviter = { ownerId: 'inviter-owner', userId: 'inviter-user' }, invitee = { ownerId: 'invitee-owner', userId: 'invitee-user' }
const code = expected => error => error instanceof InvitationError && error.code === expected

test('an invite stores only its hash, works once, expires, and never lets the inviter answer it', async () => {
  let clock = 1_000_000
  const store = createMemoryInvitationStore(), invites = createMemberInvitations({ store, now: () => clock, ttlMs: 1000 })
  const { token, invitation } = await invites.create({ inviter, inviterName: 'Jacob Cole', inviteeName: '  Ada   Lovelace ' })
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(invitation.inviteeName, 'Ada Lovelace'); assert.equal(invitation.status, 'pending')
  const [stored] = store.records.values()
  assert.equal(stored.tokenHash, createHash('sha256').update(token).digest('hex')); assert.ok(!JSON.stringify(stored).includes(token))
  assert.deepEqual(await invites.open(token), { inviterName: 'Jacob Cole', inviteeName: 'Ada Lovelace', status: 'pending', expiresAt: 1_001_000 })
  assert.equal(await invites.open('x'.repeat(43)), null); assert.equal(await invites.open('../etc'), null)
  await assert.rejects(invites.respond(token, inviter, 'accept'), code('invitation_own'))
  assert.deepEqual(await invites.respond(token, invitee, 'accept'), { status: 'accepted', inviterName: 'Jacob Cole' })
  await assert.rejects(invites.respond(token, invitee, 'accept'), code('invitation_unavailable'))
  await assert.rejects(invites.respond(token, { ownerId: 'third', userId: 'third' }, 'decline'), code('invitation_unavailable'))
  assert.equal((await invites.list(inviter))[0].status, 'accepted')
  const later = await invites.create({ inviter, inviterName: 'Jacob Cole', inviteeName: 'Grace Hopper' })
  clock += 1000
  assert.equal((await invites.open(later.token)).status, 'expired')
  await assert.rejects(invites.respond(later.token, invitee, 'accept'), code('invitation_unavailable'))
  await assert.rejects(invites.respond(later.token, invitee, 'join'), code('invitation_action_invalid'))
})

test('only the inviter revokes a pending invite; names are plain; limits and account removal hold', async () => {
  const store = createMemoryInvitationStore(), invites = createMemberInvitations({ store, maxPerDay: 2, maxPending: 5 })
  const first = await invites.create({ inviter, inviterName: 'Jacob', inviteeName: 'Ada' })
  await assert.rejects(invites.revoke(invitee, first.invitation.id), code('invitation_unavailable'))
  await invites.revoke(inviter, first.invitation.id)
  assert.equal((await invites.open(first.token)).status, 'revoked')
  await assert.rejects(invites.revoke(inviter, first.invitation.id), code('invitation_unavailable'))
  for (const name of ['<script>', 'Ada\u0000', '', ' ', 'x'.repeat(121), 42]) await assert.rejects(invites.create({ inviter, inviterName: 'Jacob', inviteeName: name }), code('invitation_name_invalid'))
  await invites.create({ inviter, inviterName: 'Jacob', inviteeName: 'Grace' })
  await assert.rejects(invites.create({ inviter, inviterName: 'Jacob', inviteeName: 'Third' }), code('invitation_limit'))
  await invites.create({ inviter: invitee, inviterName: 'Other', inviteeName: 'Someone' })
  assert.equal(await invites.removeOwner(inviter), 2); assert.equal(store.records.size, 1)
  assert.deepEqual(await invites.list(inviter), [])
})

test('the graph store receives only the token hash and answers with compare-and-set', async () => {
  const calls = []
  const driver = { session: () => ({ close: async () => {}, executeWrite: work => work({ run: async (query, params) => { calls.push({ query, params }); return { records: /SET i \+= \$patch/.test(query) ? [{ get: () => 'id' }] : [] } } }),
    executeRead: work => work({ run: async (query, params) => { calls.push({ query, params }); return { records: [{ get: () => 0 }] } } }) }) }
  const invites = createMemberInvitations({ store: createNeo4jInvitationStore(driver) })
  const { token } = await invites.create({ inviter, inviterName: 'Jacob', inviteeName: 'Ada' })
  const insert = calls.find(call => /CREATE \(i:UnlinkedMemberInvitation\)/.test(call.query))
  assert.match(insert.params.record.tokenHash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(calls).includes(token))
  const transition = await createNeo4jInvitationStore(driver).transition('h'.repeat(64), 'pending', { status: 'accepted' }, 5)
  assert.equal(transition, true); assert.match(calls.at(-1).query, /WHERE i\.status = \$from AND \(\$unexpiredAt IS NULL OR i\.expiresAt > \$unexpiredAt\)/)
})

// Two accounts on one handler: whoever the identity provider returns next signs in.
async function site(t, { invites, adapterStore }) {
  const owners = { 'inviter-subject': inviter, 'invitee-subject': invitee }
  let next = 'inviter-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const jobs = new Map()
  const backend = owner => ({ adapter: { withImport: async (ownerId, id, work) => { assert.equal(ownerId, owner.ownerId); return work(adapterStore(jobs, owner)) } },
    listImportIds: async () => [], listImportJobIds: async () => [...jobs.keys()], listAccountGrantIds: async () => [],
    readResource: async (type, id) => type === 'import' && jobs.has(id) ? { sourceId: id, sourceOwnerId: owner.ownerId, deleted: false, payload: jobs.get(id) } : null })
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', memberInvitations: invites,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: next, verifiedEmail: `${next}@example.invalid`, displayName: next === 'inviter-subject' ? 'Jacob Cole' : 'Ada Lovelace' }) },
    resolveOwner: async identity => owners[identity.subject], signup: async identity => owners[identity.subject], issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async owner => backend(owner) })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async (subject, after = '') => {
    next = subject
    const begin = await request(`/login${after ? `?next=${encodeURIComponent(after)}` : ''}`)
    const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    return { cookie: callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0], location: callback.headers.get('location') }
  }
  const csrfOf = async cookie => (await (await request('/settings', { headers: { Cookie: cookie } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
  const post = (path, cookie, form) => request(path, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  return { request, signIn, csrfOf, post, jobs, baseUrl }
}
const memoryJobs = (jobs, owner) => ({ getJob: async id => jobs.get(id) ?? null, putAsset: async (sha, bytes) => { memoryJobs.assets.set(sha, bytes) }, saveJob: async job => { assert.equal(job.ownerId, owner.ownerId); jobs.set(job.id, job) } })
memoryJobs.assets = new Map()

test('an invite link is created once, opens signed out, and is accepted once by another signed-in account', async t => {
  const invites = createMemberInvitations({ store: createMemoryInvitationStore() })
  const { request, signIn, csrfOf, post, baseUrl } = await site(t, { invites, adapterStore: memoryJobs })
  const jacob = await signIn('inviter-subject'), jacobCsrf = await csrfOf(jacob.cookie)
  const created = await (await post('/invites', jacob.cookie, { csrf: jacobCsrf, inviteeName: 'Ada <Lovelace>' })).text()
  assert.match(created, /Use a plain name/)
  const page = await (await post('/invites', jacob.cookie, { csrf: jacobCsrf, inviteeName: 'Ada Lovelace' })).text()
  const token = page.match(new RegExp(`${baseUrl.replace(/[.]/g, '\\.')}/i/([A-Za-z0-9_-]{43})`))[1]
  assert.doesNotMatch(await (await request('/invites', { headers: { Cookie: jacob.cookie } })).text(), new RegExp(token))
  assert.equal((await post('/invites', jacob.cookie, { csrf: 'wrong', inviteeName: 'Ada' })).status >= 400, true)
  const landing = await request(`/i/${token}`)
  assert.equal(landing.status, 200); assert.equal(landing.headers.get('referrer-policy'), 'no-referrer')
  const landingHtml = await landing.text()
  assert.match(landingHtml, /Jacob Cole invited Ada Lovelace to Unlinked/); assert.match(landingHtml, new RegExp(`/login\\?next=%2Fi%2F${token}`))
  assert.equal((await request(`/i/${'z'.repeat(43)}`)).status, 404)
  const own = await post(`/i/${token}`, jacob.cookie, { csrf: jacobCsrf, action: 'accept' })
  assert.equal(own.status, 409); assert.match(await own.text(), /your own invite/)
  const ada = await signIn('invitee-subject', `/i/${token}`)
  assert.equal(ada.location, `/i/${token}`)
  const adaCsrf = (await (await request(`/i/${token}`, { headers: { Cookie: ada.cookie } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
  const accepted = await post(`/i/${token}`, ada.cookie, { csrf: adaCsrf, action: 'accept' })
  assert.equal(accepted.status, 200); assert.match(await accepted.text(), /You accepted Jacob Cole's invite/)
  assert.equal((await post(`/i/${token}`, ada.cookie, { csrf: adaCsrf, action: 'accept' })).status, 409)
  assert.match(await (await request('/invites', { headers: { Cookie: jacob.cookie } })).text(), /Ada Lovelace<\/span><b>Accepted/)
})

test('adding a person stages a private one-row import that Settings labels and the import status ignores', async t => {
  const { request, signIn, csrfOf, post, jobs } = await site(t, { invites: undefined, adapterStore: memoryJobs })
  const jacob = await signIn('inviter-subject'), csrf = await csrfOf(jacob.cookie)
  const bad = await post('/people/add', jacob.cookie, { csrf, firstName: 'Ada', lastName: 'Lovelace', linkedinUrl: 'https://example.com/ada', company: '', position: '' })
  assert.equal(bad.status, 400); assert.match(await bad.text(), /Use a LinkedIn profile address/); assert.equal(jobs.size, 0)
  assert.equal((await post('/people/add', jacob.cookie, { csrf, firstName: 'Ada', lastName: '', linkedinUrl: 'linkedin.com/in/ada' })).status, 400)
  const added = await post('/people/add', jacob.cookie, { csrf, firstName: 'Ada', lastName: 'Love"lace', linkedinUrl: 'linkedin.com/in/ada-lovelace/', company: 'Analytical, Inc.', position: 'Engineer' })
  assert.equal(added.status, 303); assert.equal(added.headers.get('location'), '/network?added=1')
  assert.match(await (await request('/network?added=1', { headers: { Cookie: jacob.cookie } })).text(), /Added to your people\./)
  const [job] = jobs.values()
  assert.deepEqual(job.consent, COMBINED_UPLOAD_CONSENT); assert.equal(job.filename, 'Connections.csv')
  assert.deepEqual(job.origin, { kind: 'added-person', label: 'Ada Love"lace' })
  const csv = memoryJobs.assets.get(job.archiveSha256).toString('utf8')
  assert.equal(csv, 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n"Ada","Love""lace","https://www.linkedin.com/in/ada-lovelace","","Analytical, Inc.","Engineer",""\n')
  const settings = await (await request('/settings', { headers: { Cookie: jacob.cookie } })).text()
  assert.match(settings, /Added by you: Ada Love&quot;lace/)
  assert.doesNotMatch(settings, /class="import-status"/)
  // No invites configured: the routes do not exist.
  assert.equal((await request('/invites', { headers: { Cookie: jacob.cookie } })).status, 404)
})
