import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'
import { coordinatorFor } from '../mcp-server/owner-coordination.mjs'

test('profile claim notification finishes before owner deletion', async t => {
  const owner = { ownerId: 'claim-owner', userId: 'claim-user' }, sessionStore = createMemorySessionStore()
  let entered, resume, completed = false
  const waiting = new Promise(resolve => { entered = resolve }), proceed = new Promise(resolve => { resume = resolve })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, sessionStore,
    login: { begin: async () => ({ location: 'https://synthetic.invalid', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'sub', verifiedEmail: 'member@example.invalid', emailEvidence: 'signed-ideaflow-beta-v1' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {},
    legacyAccount: { candidate: async () => ({ profileId: 'profile-a' }), confirm: async () => {} },
    notifyProfileClaimed: async () => { entered(); await proceed; completed = true },
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }) })
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const signed = await fetch(`${endpoint}/auth/callback/ideaflow?code=x&state=s`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await fetch(`${endpoint}/legacy-account`, { headers: { Cookie: cookie } })).text()
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  const post = (path, values) => fetch(`${endpoint}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl }, body: new URLSearchParams({ csrf, ...values }) })
  const claim = post('/legacy-account', { action: 'confirm' })
  await waiting
  const deletion = post('/delete-account', { confirm: 'delete account' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  resume()
  assert.equal((await claim).status, 303)
  assert.equal((await deletion).status, 200)
  assert.equal(completed, true)
})

test('first signup delayed across deletion cannot create a session', async t => {
  const owner = { ownerId: 'new-owner', userId: 'new-user' }, sessionStore = createMemorySessionStore()
  let linked = false, entered, resume
  const waiting = new Promise(resolve => { entered = resolve }), proceed = new Promise(resolve => { resume = resolve })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, sessionStore,
    login: { begin: async () => ({ location: 'https://synthetic.invalid', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'sub' }) },
    resolveOwner: async () => linked ? owner : null, signup: async () => { linked = true; entered(); await proceed; return owner },
    issueAccountGrant: async () => {}, revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }) })
  const begin = () => fetch(`${endpoint}/login`, { redirect: 'manual' })
  const finish = response => fetch(`${endpoint}/auth/callback/ideaflow?code=x&state=s`, { redirect: 'manual', headers: { Cookie: response.headers.getSetCookie()[0].split(';')[0] } })
  const pending = finish(await begin())
  await waiting
  const other = await finish(await begin())
  const cookie = other.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).text()
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  const deleted = await fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl }, body: new URLSearchParams({ csrf, confirm: 'delete account' }) })
  assert.equal(deleted.status, 200)
  resume()
  const result = await pending
  assert.notEqual(result.status, 303)
  assert.ok(!result.headers.getSetCookie().some(value => value.startsWith('__Host-ul-session=')))
})

test('deletion waits for a pending sign-in email write', async t => {
  const owner = { ownerId: 'mail-owner', userId: 'mail-user' }, sessionStore = createMemorySessionStore()
  let address = null, writes = 0, entered, resume, deletionArrived
  const waiting = new Promise(resolve => { entered = resolve }), proceed = new Promise(resolve => { resume = resolve })
  const deleting = new Promise(resolve => { deletionArrived = resolve })
  const memberEmail = { sending: true, rememberAddress: async () => { if (++writes === 2) { entered(); await proceed } address = 'member@example.invalid' },
    settings: async () => ({}), savePreferences: async () => {}, sendInvite: async () => {}, inspectUnsubscribe: async () => {}, unsubscribe: async () => {}, exportOwner: async () => ({}), removeOwner: async () => { address = null } }
  let handler
  const server = createServer((req, res) => { if (req.url === '/delete-account') deletionArrived(); void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, sessionStore, memberEmail,
    login: { begin: async () => ({ location: 'https://synthetic.invalid', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'sub', verifiedEmail: 'member@example.invalid' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }) })
  const start = async () => fetch(`${endpoint}/login`, { redirect: 'manual' })
  const finish = async response => fetch(`${endpoint}/auth/callback/ideaflow?code=x&state=s`, { redirect: 'manual', headers: { Cookie: response.headers.getSetCookie()[0].split(';')[0] } })
  const signed = await finish(await start())
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const settings = await (await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).text()
  const csrf = settings.match(/name="csrf" value="([^"]+)"/)[1]
  const second = finish(await start())
  await waiting
  const deletion = fetch(`${endpoint}/delete-account`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl }, body: new URLSearchParams({ csrf, confirm: 'delete account' }) })
  await deleting
  assert.equal(address, 'member@example.invalid')
  resume()
  await second
  assert.equal((await deletion).status, 200)
  assert.equal(address, null)
})

test('sign-in queued across deletion cannot create a session', async t => {
  const owner = { ownerId: 'queued-owner', userId: 'queued-user' }, sessionStore = createMemorySessionStore(), coordination = coordinatorFor(sessionStore)
  let queued
  const waiting = new Promise(resolve => { queued = resolve })
  const acquire = coordination.acquire
  coordination.acquire = (key, exclusive) => { if (!exclusive && key === 'owner:queued-owner') queued(); return acquire(key, exclusive) }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, sessionStore,
    login: { begin: async () => ({ location: 'https://synthetic.invalid', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'sub' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }) })
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const release = await coordination.acquire('owner:queued-owner', true)
  const callback = fetch(`${endpoint}/auth/callback/ideaflow?code=x&state=s`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  await waiting
  coordination.deleted(owner.ownerId)
  release()
  const rejected = await callback
  assert.notEqual(rejected.status, 303)
  assert.ok(!rejected.headers.getSetCookie().some(value => value.startsWith('__Host-ul-session=')))
  const fresh = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const accepted = await fetch(`${endpoint}/auth/callback/ideaflow?code=x&state=s`, { redirect: 'manual', headers: { Cookie: fresh.headers.getSetCookie()[0].split(';')[0] } })
  assert.equal(accepted.status, 303)
})

test('durable session restore across handler instances', async t => {
  let signups = 0
  const owner = { ownerId: 'signup-owner', userId: 'signup-user' }
  const sessionStore = createMemorySessionStore(), storedKeys = []
  const put = sessionStore.put; sessionStore.put = (key, record) => { storedKeys.push([key, record]); return put(key, record) }
  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  
  const createHandler = () => createPrivateBrowserHandler({ baseUrl,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/account-choice', transaction: { state: 'synthetic-state' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'signup-sub' }) },
    resolveOwner: async identity => identity.subject === 'signup-sub' ? owner : null,
    signup: async () => { signups++; return owner },
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }),
    issueAccountGrant: async () => 'grant',
    revokeAccountGrant: async () => {},
    sessionStore
  })
  
  handler = createHandler()
  
  // Login on first handler
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const callback = await fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic&state=synthetic-state`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  assert.equal(callback.status, 303)
  
  const setCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))
  const sessionCookie = setCookie.split(';')[0]
  // Only a hash of the cookie value is stored, never the value itself.
  const rawId = sessionCookie.split('=')[1]
  assert.equal(storedKeys.length, 1); assert.match(storedKeys[0][0], /^[a-f0-9]{64}$/); assert.notEqual(storedKeys[0][0], rawId)
  assert.equal(JSON.stringify(storedKeys[0][1]).includes(rawId), false)
  
  // Verify signed-in page
  let home = await fetch(endpoint, { headers: { Cookie: sessionCookie } })
  let homeText = await home.text()
  const csrfMatch = homeText.match(/name="csrf" value="([^"]+)"/)
  assert.ok(csrfMatch, "Should be signed in and have CSRF token")
  const csrf1 = csrfMatch[1]
  
  // Re-create handler (simulate restart)
  handler = createHandler()
  
  // Request with the same cookie
  home = await fetch(endpoint, { headers: { Cookie: sessionCookie } })
  homeText = await home.text()
  const csrfMatch2 = homeText.match(/name="csrf" value="([^"]+)"/)
  assert.ok(csrfMatch2, "Should still be signed in after restart")
  assert.equal(csrfMatch2[1], csrf1, "Should have the same CSRF token restored from store")
  
  // Logout
  const logout = await fetch(`${endpoint}/logout`, { method: 'POST', headers: { Cookie: sessionCookie, Origin: baseUrl }, body: new URLSearchParams({ csrf: csrf1 }), redirect: 'manual' })
  assert.equal(logout.status, 303)
  
  // Re-create handler again
  handler = createHandler()
  
  // Request with the same cookie -> should not work anymore
  home = await fetch(endpoint, { headers: { Cookie: sessionCookie } })
  homeText = await home.text()
  assert.equal(homeText.includes('name="csrf"'), false, "Should be signed out after logout")
})
