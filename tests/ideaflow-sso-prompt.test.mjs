import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'

// Silent SSO: a normal sign-in sends no prompt. Only an explicit sign-out,
// Switch account or account deletion asks Ideaflow ID for its account chooser.
const ISSUER_ORIGIN = 'https://id.example.invalid'

async function site(t) {
  const owner = { ownerId: 'sso-owner', userId: 'sso-user' }, begins = []
  let handler
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl,
    login: { authorizationOrigin: ISSUER_ORIGIN,
      begin: async (options = {}) => {
        begins.push(options)
        const location = new URL(`${ISSUER_ORIGIN}/authorize`)
        if (options.prompt) location.searchParams.set('prompt', options.prompt)
        return { location: location.href, transaction: { state: `state-${begins.length}` } }
      },
      finish: async () => ({ issuer: ISSUER_ORIGIN, subject: 'sso-subject', verifiedEmail: 'member@example.invalid' }) },
    resolveOwner: async () => owner, signup: async () => owner,
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }),
    issueAccountGrant: async () => 'grant', revokeAccountGrant: async () => {},
    sessionStore: createMemorySessionStore(),
  })
  const go = (path, init = {}) => fetch(endpoint + path, { redirect: 'manual', ...init })
  const cookieFrom = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))
  // Returns the provider URL /login redirected to, and the cookie jar after the callback.
  const signIn = async (jar = '', next) => {
    const start = await go(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, { headers: jar ? { Cookie: jar } : {} })
    assert.equal(start.status, 303)
    const provider = new URL(start.headers.get('location'))
    const callback = await go(`/auth/callback/ideaflow?code=c&state=state-${begins.length}`, { headers: { Cookie: [jar, cookieFrom(start, '__Host-ul-login').split(';')[0]].filter(Boolean).join('; ') } })
    assert.equal(callback.status, 303)
    return { provider, callback, session: cookieFrom(callback, '__Host-ul-session').split(';')[0] }
  }
  const csrfOf = async session => (await (await go('/settings', { headers: { Cookie: session } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
  const post = (path, session, form) => go(path, { method: 'POST', headers: { Cookie: session, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  return { begins, go, signIn, csrfOf, post, cookieFrom }
}

test('a normal sign-in sends no prompt; after sign-out the next one asks for the account chooser, once', async t => {
  const s = await site(t)
  const first = await s.signIn()
  assert.equal(first.provider.searchParams.has('prompt'), false)
  assert.deepEqual(s.begins, [{}])

  const signOut = await s.post('/logout', first.session, { csrf: await s.csrfOf(first.session) })
  assert.equal(signOut.status, 303); assert.equal(signOut.headers.get('location'), '/')
  const marker = s.cookieFrom(signOut, '__Host-ul-signed-out')
  // Short-lived, host-only, script-proof, and carrying no URL or identity.
  assert.match(marker, /^__Host-ul-signed-out=1; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600$/)
  const jar = marker.split(';')[0]

  const second = await s.signIn(jar)
  assert.equal(second.provider.searchParams.get('prompt'), 'select_account')
  // A successful sign-in clears the marker, so the following one is silent again.
  assert.match(s.cookieFrom(second.callback, '__Host-ul-signed-out'), /^__Host-ul-signed-out=; .*Max-Age=0$/)
  const third = await s.signIn()
  assert.equal(third.provider.searchParams.has('prompt'), false)

  // Only the exact marker value counts.
  assert.equal((await s.signIn('__Host-ul-signed-out=login')).provider.searchParams.has('prompt'), false)
})

test('Switch account signs out, then starts sign-in with the account chooser and a validated return page', async t => {
  const s = await site(t)
  const { session } = await s.signIn()
  const csrf = await s.csrfOf(session)

  // CSRF-protected: without the token nothing changes and the session survives.
  assert.equal((await s.post('/switch-account', session, {})).status, 400)
  assert.equal((await s.post('/switch-account', session, { csrf: 'wrong' })).status, 400)
  assert.equal((await s.go('/switch-account', { headers: { Cookie: session } })).status, 404)
  assert.equal((await s.go('/settings', { headers: { Cookie: session } })).status, 200)

  const switched = await s.post('/switch-account', session, { csrf, next: '/network' })
  assert.equal(switched.status, 303)
  assert.equal(switched.headers.get('location'), '/login?next=%2Fnetwork')
  assert.match(s.cookieFrom(switched, '__Host-ul-session'), /^__Host-ul-session=; .*Max-Age=0$/)
  const marker = s.cookieFrom(switched, '__Host-ul-signed-out').split(';')[0]
  // The old session is gone.
  assert.equal((await s.go('/settings', { headers: { Cookie: session } })).status, 401)

  const login = await s.go(switched.headers.get('location'), { headers: { Cookie: marker } })
  assert.equal(new URL(login.headers.get('location')).searchParams.get('prompt'), 'select_account')
  assert.equal(new URL(login.headers.get('location')).origin, ISSUER_ORIGIN)
})

test('Switch account never redirects off-site or to an unlisted page', async t => {
  const s = await site(t)
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/login?next=https://evil.example', '/oauth/authorize?x=1', 'javascript:alert(1)', '/settings#x', '']) {
    const { session } = await s.signIn()
    const switched = await s.post('/switch-account', session, { csrf: await s.csrfOf(session), next })
    assert.equal(switched.status, 303)
    assert.equal(switched.headers.get('location'), '/login', next)
  }
  // Repeated next fields are refused rather than guessed at.
  const { session } = await s.signIn()
  const doubled = await s.post('/switch-account', session, [['csrf', await s.csrfOf(session)], ['next', '/network'], ['next', '/settings']])
  assert.equal(doubled.headers.get('location'), '/login')
})

test('the Me menu offers Switch account and every page lets that form reach Ideaflow ID', async t => {
  const s = await site(t)
  const { session } = await s.signIn()
  for (const path of ['/', '/settings', '/agents', '/meet']) {
    const response = await s.go(path, { headers: { Cookie: session } })
    assert.equal(response.status, 200, path)
    const text = await response.text()
    assert.match(text, /<form method="post" action="\/switch-account" role="none"><input type="hidden" name="csrf" value="[^"]+"><button type="submit" class="me-out" role="menuitem">Switch account<\/button><\/form>/, path)
    // The form's redirect chain ends at the configured provider origin, and nowhere else.
    assert.match(response.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${ISSUER_ORIGIN.replace(/[.]/g, '\\.')}(?: https:)?;`), path)
  }
})

test('deleting the account also makes the next sign-in show the account chooser', async t => {
  const s = await site(t)
  const { session } = await s.signIn()
  const deleted = await s.post('/delete-account', session, { csrf: await s.csrfOf(session), confirm: 'delete everything' })
  assert.equal(deleted.status, 200)
  assert.match(s.cookieFrom(deleted, '__Host-ul-signed-out'), /^__Host-ul-signed-out=1;/)
})
