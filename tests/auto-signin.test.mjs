import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createPrivateBrowserHandler, autoSignInEnabled, autoSignInPage, autoSignInRequest, AUTO_SIGNIN_COOKIE } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'

// Automatic cross-app sign-in (docs/ideaflow-sign-in.md): a signed-out page view
// makes one silent prompt=none round trip to Ideaflow ID per browser session.
const ISSUER_ORIGIN = 'https://id.example.invalid'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': CHROME }

async function site(t, { autoSignIn = true, owner = { ownerId: 'auto-owner', userId: 'auto-user' }, legacyAccount, finish } = {}) {
  const begins = [], finishes = [], signups = [], audits = []
  let handler
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, autoSignIn, legacyAccount,
    login: { authorizationOrigin: ISSUER_ORIGIN,
      begin: async (options = {}) => {
        begins.push(options)
        const location = new URL(`${ISSUER_ORIGIN}/authorize`)
        if (options.prompt) location.searchParams.set('prompt', options.prompt)
        location.searchParams.set('state', `state-${begins.length}`)
        return { location: location.href, transaction: { state: `state-${begins.length}`, nonce: `nonce-${begins.length}`, verifier: `verifier-${begins.length}` } }
      },
      finish: async (url, transaction) => {
        finishes.push({ code: url.searchParams.get('code'), state: transaction.state })
        if (finish) return finish(url, transaction)
        return { issuer: ISSUER_ORIGIN, subject: 'auto-subject', verifiedEmail: 'member@example.invalid', emailEvidence: 'signed-ideaflow-beta-v1', clientId: 'client', verifiedAt: 1 }
      } },
    resolveOwner: async () => owner, signup: async () => { signups.push(true); return owner },
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }),
    issueAccountGrant: async () => 'grant', revokeAccountGrant: async () => {},
    sessionStore: createMemorySessionStore(),
    audit: async event => { audits.push(event) },
  })
  // node:http rather than fetch: fetch overwrites Sec-Fetch-Mode, which these guards read.
  const go = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(endpoint + path, { method, headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) }, incoming => {
      const parts = []
      incoming.on('data', part => parts.push(part)); incoming.on('error', reject)
      incoming.on('end', () => resolve({ status: incoming.statusCode,
        headers: { get: name => incoming.headers[name.toLowerCase()] ?? null, getSetCookie: () => incoming.headers['set-cookie'] ?? [] },
        text: async () => Buffer.concat(parts).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end(body === undefined ? undefined : String(body))
  })
  const visit = (path, cookie = '', headers = {}) => go(path, { headers: { ...NAVIGATE, ...(cookie ? { Cookie: cookie } : {}), ...headers } })
  const cookieFrom = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))
  const pair = (response, name) => cookieFrom(response, name)?.split(';')[0]
  const isSilentHop = response => response.status === 302 && new URL(response.headers.get('location')).origin === ISSUER_ORIGIN && new URL(response.headers.get('location')).searchParams.get('prompt') === 'none'
  return { begins, finishes, signups, audits, go, visit, cookieFrom, pair, isSilentHop, baseUrl }
}

test('a signed-out deep link makes one silent hop and lands signed in on the same page and query', async t => {
  const s = await site(t)
  const hop = await s.visit('/people/ada-lovelace?connect=sent&x=1')
  assert.ok(s.isSilentHop(hop))
  assert.deepEqual(s.begins, [{ prompt: 'none' }])
  // A browser-session marker: no Max-Age/Expires, host-only, script-proof.
  assert.equal(s.cookieFrom(hop, AUTO_SIGNIN_COOKIE), `${AUTO_SIGNIN_COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax`)
  assert.match(s.cookieFrom(hop, '__Host-ul-login'), /Max-Age=300$/)
  // No fragment in Location, so the browser carries the page's #hash across.
  assert.equal(new URL(hop.headers.get('location')).hash, '')

  const jar = [s.pair(hop, AUTO_SIGNIN_COOKIE), s.pair(hop, '__Host-ul-login')].join('; ')
  const callback = await s.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: jar } })
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.get('location'), '/people/ada-lovelace?connect=sent&x=1')
  const session = s.pair(callback, '__Host-ul-session')
  assert.ok(session && session.length > '__Host-ul-session='.length)
  assert.deepEqual(s.finishes, [{ code: 'c', state: 'state-1' }])
  assert.equal(s.signups.length, 0)
  assert.deepEqual(s.audits.filter(event => event.event === 'auth_silent_signin').map(event => event.outcome), ['signed_in'])
  // Signed in now: the page renders, no further hop.
  const settings = await s.visit('/settings', `${session}; ${s.pair(hop, AUTO_SIGNIN_COOKIE)}`)
  assert.equal(settings.status, 200)
  assert.equal(s.begins.length, 1)
})

test('without a provider session the visitor returns to the same page signed out, once per browser session', async t => {
  const s = await site(t)
  const hop = await s.visit('/settings?tab=agents')
  assert.ok(s.isSilentHop(hop))
  const marker = s.pair(hop, AUTO_SIGNIN_COOKIE)
  const back = await s.go('/auth/callback/ideaflow?error=login_required&state=state-1&iss=https%3A%2F%2Fid.example.invalid', { headers: { Cookie: `${marker}; ${s.pair(hop, '__Host-ul-login')}` } })
  assert.equal(back.status, 303)
  assert.equal(back.headers.get('location'), '/settings?tab=agents')
  assert.equal(s.cookieFrom(back, '__Host-ul-session'), undefined)
  // The marker is not cleared by login_required.
  assert.equal(s.cookieFrom(back, AUTO_SIGNIN_COOKIE), undefined)
  assert.equal(s.finishes.length, 0)
  // The page and every reload render normally, without another hop.
  for (const path of ['/settings?tab=agents', '/settings?tab=agents', '/']) {
    const page = await s.visit(path, marker)
    assert.ok([200, 401].includes(page.status), path)
    assert.equal(page.headers.get('location'), null)
  }
  assert.equal(s.begins.length, 1)
})

test('any provider error on a silent attempt returns to the page without error copy or query junk', async t => {
  for (const error of ['consent_required', 'interaction_required', 'access_denied', 'server_error']) {
    const s = await site(t)
    const hop = await s.visit('/network?q=ada')
    const back = await s.go(`/auth/callback/ideaflow?error=${error}&error_description=x&state=state-1`, { headers: { Cookie: `${s.pair(hop, AUTO_SIGNIN_COOKIE)}; ${s.pair(hop, '__Host-ul-login')}` } })
    assert.equal(back.status, 303, error)
    assert.equal(back.headers.get('location'), '/network?q=ada', error)
  }
})

test('a prompt=none answer whose attempt is gone goes home signed out; explicit errors keep the error page', async t => {
  const s = await site(t)
  const orphan = await s.go('/auth/callback/ideaflow?error=login_required&state=unknown')
  assert.equal(orphan.status, 303); assert.equal(orphan.headers.get('location'), '/')
  // Other unknown-state answers are not silent ones; they keep the existing handling.
  assert.equal((await s.go('/auth/callback/ideaflow?error=access_denied&state=unknown')).status, 400)
  assert.equal((await s.go('/auth/callback/ideaflow?code=c&state=unknown')).status, 400)
  assert.equal(s.finishes.length, 0)
})

test('a silent attempt never creates an account; the explicit sign-in still does', async t => {
  const s = await site(t, { owner: null })
  const hop = await s.visit('/people/someone')
  const back = await s.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: `${s.pair(hop, AUTO_SIGNIN_COOKIE)}; ${s.pair(hop, '__Host-ul-login')}` } })
  assert.equal(back.status, 303)
  assert.equal(back.headers.get('location'), '/people/someone')
  assert.equal(s.cookieFrom(back, '__Host-ul-session'), undefined)
  assert.equal(s.signups.length, 0)
  assert.deepEqual(s.audits.filter(event => event.event === 'auth_silent_signin').map(event => event.outcome), ['no_account'])
})

test('an unconfirmed old-account match is left for the explicit sign-in', async t => {
  const s = await site(t, { legacyAccount: { candidate: async () => ({ profileId: 'legacy-profile', linked: false }), confirm: async () => {} } })
  const hop = await s.visit('/')
  const back = await s.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: `${s.pair(hop, AUTO_SIGNIN_COOKIE)}; ${s.pair(hop, '__Host-ul-login')}` } })
  assert.equal(back.headers.get('location'), '/')
  assert.equal(s.cookieFrom(back, '__Host-ul-session'), undefined)
  assert.deepEqual(s.audits.filter(event => event.event === 'auth_silent_signin').map(event => event.outcome), ['needs_confirmation'])
  // A confirmed (linked) match signs in silently.
  const linked = await site(t, { legacyAccount: { candidate: async () => ({ profileId: 'legacy-profile', linked: true }), confirm: async () => {} } })
  const again = await linked.visit('/')
  const signedIn = await linked.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: `${linked.pair(again, AUTO_SIGNIN_COOKIE)}; ${linked.pair(again, '__Host-ul-login')}` } })
  assert.equal(signedIn.headers.get('location'), '/')
  assert.ok(linked.pair(signedIn, '__Host-ul-session'))
})

test('a failed code exchange on a silent attempt returns to the page signed out, with no error page', async t => {
  const s = await site(t, { finish: async () => { throw new Error('nonce mismatch') } })
  const hop = await s.visit('/card')
  const back = await s.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: `${s.pair(hop, AUTO_SIGNIN_COOKIE)}; ${s.pair(hop, '__Host-ul-login')}` } })
  assert.equal(back.status, 303); assert.equal(back.headers.get('location'), '/card')
  assert.equal(s.cookieFrom(back, '__Host-ul-session'), undefined)
  // A wrong state is refused before any exchange, exactly as for explicit sign-in.
  const t2 = await site(t)
  const hop2 = await t2.visit('/card')
  const wrong = await t2.go('/auth/callback/ideaflow?code=c&state=not-mine', { headers: { Cookie: `${t2.pair(hop2, AUTO_SIGNIN_COOKIE)}; ${t2.pair(hop2, '__Host-ul-login')}` } })
  assert.equal(wrong.status, 400)
  assert.equal(t2.finishes.length, 0)
})

test('a concurrent tab whose login cookie was replaced returns to its page without exchanging its code', async t => {
  const s = await site(t)
  const first = await s.visit('/settings'), second = await s.visit('/card')
  assert.ok(s.isSilentHop(first) && s.isSilentHop(second))
  // The browser now holds only the second attempt's login cookie.
  const jar = `${s.pair(second, AUTO_SIGNIN_COOKIE)}; ${s.pair(second, '__Host-ul-login')}`
  const stale = await s.go('/auth/callback/ideaflow?code=c1&state=state-1', { headers: { Cookie: jar } })
  assert.equal(stale.status, 303); assert.equal(stale.headers.get('location'), '/settings')
  assert.equal(s.finishes.length, 0)
  assert.equal(s.cookieFrom(stale, '__Host-ul-login'), undefined)
  const winner = await s.go('/auth/callback/ideaflow?code=c2&state=state-2', { headers: { Cookie: jar } })
  assert.equal(winner.headers.get('location'), '/card')
  assert.ok(s.pair(winner, '__Host-ul-session'))
})

test('explicit sign-out sets the browser-session marker, so a reload stays signed out', async t => {
  const s = await site(t)
  const hop = await s.visit('/')
  const signedIn = await s.go('/auth/callback/ideaflow?code=c&state=state-1', { headers: { Cookie: `${s.pair(hop, AUTO_SIGNIN_COOKIE)}; ${s.pair(hop, '__Host-ul-login')}` } })
  const session = s.pair(signedIn, '__Host-ul-session')
  const csrf = (await (await s.go('/settings', { headers: { Cookie: session } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
  const out = await s.go('/logout', { method: 'POST', headers: { Cookie: session, Origin: s.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) })
  assert.equal(out.status, 303)
  assert.equal(s.cookieFrom(out, AUTO_SIGNIN_COOKIE), `${AUTO_SIGNIN_COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax`)
  // Even a fresh browser session that kept only the one-hour signed-out cookie stays put.
  const reload = await s.visit('/', s.pair(out, '__Host-ul-signed-out'))
  assert.equal(reload.status, 200)
  assert.equal(s.begins.length, 1)
  // The next manual sign-in asks for the account chooser.
  const manual = await s.go('/login', { headers: { Cookie: `${s.pair(out, '__Host-ul-signed-out')}; ${s.pair(out, AUTO_SIGNIN_COOKIE)}` } })
  assert.equal(new URL(manual.headers.get('location')).searchParams.get('prompt'), 'select_account')
})

test('guards: no hop for non-navigations, prefetches, crawlers, in-app browsers or excluded routes', async t => {
  const s = await site(t)
  const noHop = async (path, headers = {}, init = {}) => {
    const response = await s.go(path, { ...init, headers: { ...NAVIGATE, ...headers } })
    assert.equal(s.isSilentHop(response), false, `${path} ${JSON.stringify(headers)}`)
  }
  await noHop('/', { 'Sec-Fetch-Mode': undefined })
  for (const headers of [
    { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'empty' }, { 'Sec-Fetch-Dest': 'iframe' }, { Accept: 'application/json' },
    { 'Sec-Purpose': 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' },
    { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
    { 'User-Agent': 'facebookexternalhit/1.1' }, { 'User-Agent': 'curl/8.7.1' }, { 'User-Agent': 'python-requests/2.32' },
    { 'User-Agent': `${CHROME} Instagram 300.0` }, { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]' },
    { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36' },
    { 'User-Agent': `${CHROME} Electron/31.0.0` }, { 'User-Agent': `${CHROME} LinkedInApp` }, { 'User-Agent': '' },
  ]) {
    const response = await s.go('/', { headers: { ...NAVIGATE, ...headers } })
    assert.equal(s.isSilentHop(response), false, JSON.stringify(headers))
  }
  await noHop('/', {}, { method: 'POST', body: '' })
  for (const path of ['/login', '/login?next=%2Fsettings', '/auth/callback/ideaflow', '/join', '/logout', '/find-me', '/legacy-account', '/claim-me',
    '/i/' + 'a'.repeat(43), '/c/' + 'a'.repeat(24), '/email/unsubscribe?t=x', '/oauth/authorize?client_id=x', '/.well-known/oauth-authorization-server',
    '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/sw.js', '/public-assets/connection-feedback.js', '/people/abc/photo', '/api/people', '/api/nav-alerts',
    '/notifications/00000000-0000-0000-0000-000000000000', '/imports/' + 'a'.repeat(64), '/export', '/mcp']) await noHop(path)
  // Existing markers: already attempted this browser session, or explicitly signed out.
  for (const cookie of [`${AUTO_SIGNIN_COOKIE}=1`, '__Host-ul-signed-out=1']) await noHop('/', { Cookie: cookie })
  // Only the explicit /login visits above reached the provider, without a prompt.
  assert.deepEqual(s.begins, [{}, {}])
  // Our verification browser is an ordinary browser.
  assert.ok(s.isSilentHop(await s.visit('/', '', { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36' })))
})

test('the kill switch and the default keep the runtime on its old behaviour', async t => {
  const s = await site(t, { autoSignIn: false })
  const page = await s.visit('/settings')
  assert.equal(page.status, 401)
  assert.equal(s.begins.length, 0)
  assert.equal(autoSignInEnabled({}), true)
  assert.equal(autoSignInEnabled({ UNLINKED_AUTO_SIGNIN: 'on' }), true)
  for (const value of ['off', 'OFF', 'false', '0', 'no', ' off ']) assert.equal(autoSignInEnabled({ UNLINKED_AUTO_SIGNIN: value }), false, value)
})

test('page and header guard helpers', () => {
  for (const path of ['/', '/people', '/people/ada', '/companies/Acme%20Inc', '/network', '/profile', '/settings', '/card', '/invitations', '/notifications', '/scan', '/meet']) assert.equal(autoSignInPage(path), true, path)
  for (const path of ['/login', '/join', '/people/ada/photo', '/companies/a/b', '/c/abc', '/i/abc', '/oauth/authorize', '/robots.txt', '/find-me', '/legacy-account', '/auth/callback/ideaflow', '//evil.example', undefined]) assert.equal(autoSignInPage(path), false, String(path))
  assert.equal(autoSignInRequest({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html', 'user-agent': CHROME }), true)
  assert.equal(autoSignInRequest({ accept: 'text/html', 'user-agent': CHROME }), false)
  assert.equal(autoSignInRequest(), false)
})
