import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const profile = (id, name) => ({ id, name, headline: 'Engineer', location: 'Portland', positions: [{ title: 'Engineer', company: 'Test Company' }], education: [], skills: ['Testing'] })
const importId = 'a'.repeat(64)

async function site(t, { imports = false } = {}) {
  let handler
  const owner = { ownerId: 'test-owner', userId: 'test-user' }
  const data = { state: 'published', complete: true, revision: 'public-test-v1', profiles: [profile('first', 'A First'), profile('last', 'Z Last')], connections: [{ fromId: 'first', toId: 'last' }] }
  const resource = { sourceOwnerId: owner.ownerId, sourceId: importId, payload: { id: importId, ownerId: owner.ownerId, status: 'indexed', filename: 'Fictional.zip', counts: { accepted: 1, indexed: 1 } } }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'verified-subject', verifiedEmail: 'test@example.invalid', displayName: 'Verified Person' }),
  }, resolveOwner: async identity => identity.subject === 'verified-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async () => ({ adapter: {}, listImportIds: async () => imports ? [importId] : [], listImportJobIds: async () => imports ? [importId] : [], listAccountGrantIds: async () => [], readResource: async (_type, id) => imports && id === importId ? structuredClone(resource) : null }),
  readPublishedSnapshot: async () => data,
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async (path = '/login') => {
    const start = await request(path), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))
    return { callback, session: session.split(';')[0], sessionCookie: session }
  }
  return { request, signIn, baseUrl }
}

test('a visitor can search and read profiles before signing in, from a home page that shows the product', async t => {
  const { request } = await site(t)
  const home = await request('/'); assert.equal(home.status, 200)
  const homeHTML = await home.text()
  assert.match(homeHTML, /Your professional profile and network, in a place that’s yours\./)
  assert.match(homeHTML, /method="get" action="\/network" role="search"/)
  assert.match(homeHTML, /href="\/people">or explore profiles first →/)
  assert.match(home.headers.get('content-security-policy'), /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com; font-src https:\/\/fonts\.gstatic\.com;/)
  assert.doesNotMatch(homeHTML, /name="csrf"|Signed in as/)
  const join = await request('/join'); assert.equal(join.status, 200); assert.match(await join.text(), /href="\/login">Continue with Google/)
  const results = await request('/network?q=Last'); assert.equal(results.status, 200)
  const resultsHTML = await results.text()
  assert.match(resultsHTML, /Results for “Last”/); assert.match(resultsHTML, /href="\/people\/last">Z Last/); assert.doesNotMatch(resultsHTML, /A First|\/search-account/)
  const person = await request('/people/first'); assert.equal(person.status, 200)
  const personHTML = await person.text()
  assert.match(personHTML, /<title>A First · Unlinked<\/title>/)
  assert.match(personHTML, /class="unlinked-onboarding"/)
  assert.match(personHTML, /<h1>A First<\/h1>/)
  assert.match(personHTML, /Portland · 1 connection/)
  assert.match(personHTML, /<h3>Connections · 1<\/h3>/)
  assert.match(personHTML, /class="crow" href="\/people\/last"/)
  assert.match(personHTML, /href="\/join">Join Unlinked/)
  assert.doesNotMatch(personHTML, /name="csrf"|Signed in as/)
  assert.equal((await request('/people/missing')).status, 404)
})

test('a member page without a session asks for sign-in and sign-in returns to that page, never off-site', async t => {
  const { request, signIn } = await site(t)
  for (const path of ['/profile', '/settings', '/import']) {
    const response = await request(path); assert.equal(response.status, 401)
    const body = await response.text()
    assert.match(body, new RegExp(`href="/login\\?next=${encodeURIComponent(path)}">Sign in`))
    assert.doesNotMatch(body, /Continue with Ideaflow|Ideaflow ID/)
  }
  assert.equal((await request('/logout', { method: 'POST', headers: { Origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await signIn('/login?next=/profile')).callback.headers.get('location'), '/profile')
  assert.equal((await signIn('/login?next=/people/first')).callback.headers.get('location'), '/people/first')
  for (const next of ['https://evil.test/', '//evil.test/', '/logout', '/profile?x=1', '/auth/callback/ideaflow']) {
    assert.equal((await signIn(`/login?next=${encodeURIComponent(next)}`)).callback.headers.get('location'), '/')
  }
  assert.equal((await signIn()).callback.headers.get('location'), '/')
})

test('a signed-in member stays signed in, reaches profile and people from every page, and can sign out', async t => {
  const { request, signIn, baseUrl } = await site(t)
  const { session, sessionCookie } = await signIn()
  assert.match(sessionCookie, /Max-Age=2592000/); assert.match(sessionCookie, /Secure; HttpOnly; SameSite=Lax/)
  const get = async path => { const response = await request(path, { headers: { Cookie: session } }); return { response, body: await response.text() } }
  // No file yet: home offers the file form, with the rest of the site one click away.
  const home = await get('/'); assert.equal(home.response.status, 200)
  assert.match(home.body, /Bring your LinkedIn export/); assert.match(home.body, /action="\/upload"/)
  for (const path of ['/', '/import', '/profile', '/network', '/settings', '/people/first']) {
    const { response, body } = await get(path); assert.equal(response.status, 200, path)
    const header = body.match(/<header>(.*?)<\/header>/s)[1]
    assert.match(header, /href="\/network">People/); assert.match(header, /role="menuitem" href="\/profile">View profile/)
    assert.match(header, /<div class="me-who"><b>Verified Person<\/b>/); assert.match(header, /role="menuitem" href="\/settings">/)
    assert.match(header, /action="\/logout" role="none">/)
    assert.match(header, /method="get" action="\/network" role="search"/)
    assert.match(body, /action="\/logout"/)
  }
  assert.doesNotMatch((await get('/people/first')).body, /href="\/join">Join Unlinked/)
  const people = await request('/people?q=Last', { headers: { Cookie: session } })
  assert.equal(people.status, 303); assert.equal(people.headers.get('location'), '/network?q=Last')
  const join = await request('/join', { headers: { Cookie: session } }); assert.equal(join.status, 303); assert.equal(join.headers.get('location'), '/')
  const results = await get('/network?q=Last')
  assert.match(results.body, /Results for “Last”/); assert.match(results.body, /name="scope" value="everyone">Ask AI across everyone/)
  const csrf = results.body.match(/name="csrf" value="([^"]+)"/)[1]
  const out = await request('/logout', { method: 'POST', headers: { Cookie: session, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) })
  assert.equal(out.status, 303); assert.equal(out.headers.get('location'), '/')
  assert.equal((await request('/profile', { headers: { Cookie: session } })).status, 401)
})

test('a returning member with a file lands on People; the file form stays reachable at /import', async t => {
  const { request, signIn } = await site(t, { imports: true })
  const { session } = await signIn()
  const home = await request('/', { headers: { Cookie: session } })
  assert.equal(home.status, 303); assert.equal(home.headers.get('location'), '/network')
  const form = await request('/import', { headers: { Cookie: session } }); assert.equal(form.status, 200)
  assert.match(await form.text(), /<form id="onboarding-upload" method="post" action="\/upload"/)
})
