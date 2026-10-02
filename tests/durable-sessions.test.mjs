import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'

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
