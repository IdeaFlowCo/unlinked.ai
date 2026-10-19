import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { IDEAFLOW_ID_DELETE_URL, renderDataDeleted, renderSettings } from '../mcp-server/private-onboarding-views.mjs'

// Universal links and passkeys for the iOS app (docs/ios-universal-links.md),
// plus the small iOS-review web fixes that ride with them.
const AASA = JSON.parse(readFileSync(new URL('../public/.well-known/apple-app-site-association', import.meta.url), 'utf8'))
const APP_ID = 'JESMXK96LG.ai.unlinked.app'
const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1 UnlinkediOS/1.0.0'

// Apple's component matching, simplified to what this file uses: `*` matches
// any run of characters, `?` one character; components are tried in order and
// the first match decides (an `exclude` match means the link stays in Safari).
const opensApp = path => {
  for (const component of AASA.applinks.details[0].components) {
    const pattern = new RegExp(`^${component['/'].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    if (pattern.test(path)) return component.exclude !== true
  }
  return false
}

test('the association file names the app, opens cards and profiles in it, and keeps sign-in and APIs on the web', () => {
  assert.deepEqual(AASA.applinks.details[0].appIDs, [APP_ID])
  assert.deepEqual(AASA.webcredentials.apps, [APP_ID])
  for (const path of ['/c/a1B2c3D4e5F6g7H8i9J0k1L2', '/people/ada-lovelace', '/companies/Northwind', '/meet', '/scan', '/scan?tab=scan', '/network', '/'])
    assert.equal(opensApp(path.split('?')[0]), true, path)
  // OAuth callbacks, sign-in, MCP/OAuth connector traffic and JSON APIs never jump into the app.
  for (const path of ['/auth/callback/ideaflow', '/login', '/mcp', '/oauth/authorize', '/api/people', '/api/people/x/card'])
    assert.equal(opensApp(path), false, path)
})

test('www serves the association file publicly as JSON, before any session or sign-in step', async t => {
  let handler, ownerReads = 0
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: `https://127.0.0.1:${server.address().port}`, login: { begin: async () => { throw Error('unexpected_login') }, finish: async () => {} },
    resolveOwner: async () => null, getBackend: async () => { ownerReads++; throw Error('unexpected_owner_read') } })
  for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    // Apple's CDN fetches without cookies; a stale session cookie must not change the answer either.
    for (const headers of [{}, { Cookie: '__Host-ul-session=stale' }, { 'User-Agent': IOS_APP }]) {
      const response = await fetch(endpoint + path, { redirect: 'manual', headers })
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('content-type'), 'application/json', path)
      assert.equal(response.headers.get('location'), null)
      assert.deepEqual(await response.json(), AASA)
    }
    const head = await fetch(endpoint + path, { method: 'HEAD' })
    assert.equal(head.status, 200)
  }
  assert.equal(ownerReads, 0)
})

test('the apex Vercel project serves the same file without a redirect and redirects everything else to www', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const apex = vercel.redirects.filter(rule => rule.has?.some(condition => condition.type === 'host' && condition.value === 'unlinked.ai'))
  assert.equal(apex.length, 2)
  for (const rule of apex) { assert.equal(rule.permanent, true); assert.match(rule.destination, /^https:\/\/www\.unlinked\.ai\//) }
  // The catch-all's path pattern, as Vercel compiles it: the AASA paths are the only exceptions.
  const catchAll = apex.find(rule => rule.source !== '/')
  const pattern = new RegExp(`^/${catchAll.source.match(/^\/:path\((.*)\)$/)[1]}$`)
  for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) assert.equal(pattern.test(path), false, path)
  for (const path of ['/people/ada', '/.well-known/security.txt', '/apple-app-site-association.json', '/c/a1B2c3D4e5F6g7H8i9J0k1L2', '/login']) assert.equal(pattern.test(path), true, path)
  assert.deepEqual(vercel.rewrites, [{ source: '/apple-app-site-association', destination: '/.well-known/apple-app-site-association' }])
  for (const source of ['/.well-known/apple-app-site-association', '/apple-app-site-association'])
    assert.deepEqual(vercel.headers.find(rule => rule.source === source).headers, [{ key: 'Content-Type', value: 'application/json' }])
  // Next's middleware never runs for the file (it can need a database).
  assert.match(readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8'), /\\\\\.well-known\/apple-app-site-association\$\|apple-app-site-association\$/)
})

async function signedInSite(t) {
  let handler
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const owner = { ownerId: 'batch-owner', userId: 'batch-user' }, audits = []
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://id.example.invalid/authorize', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: 'batch', displayName: 'Batch Member' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'x' }), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }),
    audit: async event => { audits.push(event) } })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' })
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?state=s&code=c', { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  return { endpoint, cookie, audits }
}

test('a verification link opened outside the app says the email is verified and how to sign in', async t => {
  const s = await signedInSite(t)
  // No login cookie in this browser: the sign-in started somewhere else (the app).
  for (const agent of [undefined, IOS_APP]) {
    const response = await fetch(s.endpoint + '/auth/callback/ideaflow?state=from-the-app&code=c', { redirect: 'manual', headers: agent ? { 'User-Agent': agent } : {} })
    assert.equal(response.status, 400)
    const body = await response.text()
    assert.match(body, /Your email is verified/)
    assert.match(body, /Go back to the Unlinked app and sign in/)
    assert.match(body, /href="\/login"/)
    assert.doesNotMatch(body, /We could not finish that/)
  }
  assert.ok(s.audits.some(event => event.event === 'auth_callback_other_browser'))
  // A provider error or a bad state from this browser's own sign-in keeps the existing handling.
  const start = await fetch(s.endpoint + '/login', { redirect: 'manual' })
  const mismatch = await fetch(s.endpoint + '/auth/callback/ideaflow?state=wrong&code=c', { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  assert.equal(mismatch.status, 400)
  assert.match(await mismatch.text(), /We could not finish that/)
  assert.equal((await fetch(s.endpoint + '/auth/callback/ideaflow?error=access_denied&state=x', { redirect: 'manual' })).status, 400)
})

test('unknown signed-in pages get a friendly 404 and the old while-you-wait step goes Home', async t => {
  const s = await signedInSite(t)
  const missing = await fetch(s.endpoint + '/no-such-page', { headers: { Cookie: s.cookie } })
  assert.equal(missing.status, 404)
  const body = await missing.text()
  assert.match(body, /<h1 class="hq">Page not found<\/h1>/)
  assert.match(body, /href="\/">Go to Home/)
  for (const cookie of [s.cookie, undefined]) {
    const response = await fetch(s.endpoint + '/while-you-wait', { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
  }
  // APIs and files keep a bare 404.
  assert.equal(await (await fetch(s.endpoint + '/api/no-such-thing', { headers: { Cookie: s.cookie } })).text(), '')
})

test('Settings and the deleted page offer deleting the Ideaflow ID too, and agent keys sit below personal settings', () => {
  assert.equal(IDEAFLOW_ID_DELETE_URL, 'https://id.ideaflow.app/account/delete?return_to=https://www.unlinked.ai')
  const deleted = renderDataDeleted().content
  assert.ok(deleted.includes(`href="${IDEAFLOW_ID_DELETE_URL}"`))
  assert.match(deleted, /Also delete your Ideaflow ID/)
  assert.match(deleted, /all Ideaflow apps/)
  const settings = renderSettings({ accountLabel: 'm@example.test', csrf: 'c', grants: [] }).content
  const deleteForm = settings.indexOf('action="/delete-account"'), link = settings.indexOf(IDEAFLOW_ID_DELETE_URL)
  assert.ok(deleteForm > 0 && link > deleteForm, 'the Ideaflow ID link follows Delete everything')
  for (const personal of ['id="your-data"', 'id="help"', '<h2>Privacy</h2>']) assert.ok(settings.indexOf(personal) < settings.indexOf('id="api-keys"'), personal)
})
