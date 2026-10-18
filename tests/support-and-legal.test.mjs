// Help & support and the Ideaflow policy links (unlinked-ac9.4,
// docs/support-and-legal.md). /support is the App Store support URL: it must
// answer without a session, and /privacy and /terms must never answer 401.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler, autoSignInPage } from '../mcp-server/private-browser.mjs'
import { PRIVACY_URL, TERMS_URL, SUPPORT_EMAIL, FEEDBACK_URL } from '../mcp-server/private-onboarding-views.mjs'

const owner = { ownerId: 'support-owner', userId: 'support-user' }

async function site(t) {
  let handler, ownerReads = 0
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'verified-subject', verifiedEmail: 'robin@example.invalid', displayName: 'Robin Fictional' }),
  }, resolveOwner: async identity => identity.subject === 'verified-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async () => { ownerReads++; return backend } })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async () => {
    const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { request, signIn, ownerReads: () => ownerReads }
}
const footerOf = body => body.match(/<footer>(.*?)<\/footer>/s)?.[1] ?? ''

test('the support page answers without a session and covers contact, deletion, reporting, removal, rules and policies', async t => {
  const app = await site(t)
  for (const method of ['GET', 'HEAD']) {
    const response = await app.request('/support', { method })
    assert.equal(response.status, 200, method)
    assert.match(response.headers.get('content-type'), /text\/html/)
  }
  const body = await (await app.request('/support')).text()
  assert.match(body, /<h1 class="hq">Help &amp; support<\/h1>/)
  assert.ok(body.includes(`href="mailto:${SUPPORT_EMAIL}"`))
  assert.equal(SUPPORT_EMAIL, 'support@ideaflow.app')
  assert.ok(body.includes(`href="${FEEDBACK_URL}"`))
  assert.equal(FEEDBACK_URL, 'https://worldissuetracker.com/tracker/unlinked-ai')
  // How to delete an account, in the words Settings uses.
  assert.ok(body.includes('href="/settings#your-data"'))
  assert.match(body, /Delete everything…/); assert.match(body, /delete everything/); assert.match(body, /Permanently delete my data/)
  assert.match(body, /id="report"/); assert.match(body, /id="removal"/)
  assert.match(body, /no tolerance for objectionable content or abusive users/)
  assert.ok(body.includes(`href="${PRIVACY_URL}"`)); assert.ok(body.includes(`href="${TERMS_URL}"`))
  assert.match(body, /not affiliated with LinkedIn/i)
  // Its own CSP: no inline script without the page nonce.
  const csp = (await app.request('/support')).headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-/)
  assert.equal(app.ownerReads(), 0)
  // A public help page is not one of the pages a signed-out visitor is silently signed in on.
  assert.equal(autoSignInPage('/support'), false)
})

test('policy addresses redirect to the Ideaflow policies and never answer 401', async t => {
  const app = await site(t)
  for (const [path, target] of [['/privacy', PRIVACY_URL], ['/privacy-policy', PRIVACY_URL], ['/terms', TERMS_URL], ['/terms-of-service', TERMS_URL], ['/contact', '/support'], ['/help', '/support']]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request(path, { method })
      assert.equal(response.status, 302, `${method} ${path}`)
      assert.equal(response.headers.get('location'), target, path)
    }
  }
  assert.equal(PRIVACY_URL, 'https://www.ideaflow.io/privacy-policy')
  assert.equal(TERMS_URL, 'https://www.ideaflow.io/terms-of-service')
  // Writes are not policy pages.
  assert.notEqual((await app.request('/privacy', { method: 'POST', headers: { Origin: 'https://example.invalid' } })).status, 302)
})

test('every footer links Support, Privacy and Terms; the sign-in moments name the terms', async t => {
  const app = await site(t)
  for (const path of ['/', '/join', '/agents', '/support', '/settings']) {
    const body = await (await app.request(path)).text()
    const footer = footerOf(body)
    assert.ok(footer.includes('href="/support"'), path)
    assert.ok(footer.includes(`href="${PRIVACY_URL}"`), path)
    assert.ok(footer.includes(`href="${TERMS_URL}"`), path)
  }
  // Landing, Join and "Sign in to continue" carry the terms line beside the sign-in step.
  for (const path of ['/', '/join', '/settings']) {
    const body = await (await app.request(path)).text()
    const note = body.match(/<p class="small legal-note">(.*?)<\/p>/s)?.[1]
    assert.ok(note, path)
    assert.ok(note.includes(`href="${TERMS_URL}"`) && note.includes(`href="${PRIVACY_URL}"`), path)
    assert.match(note, /does not allow abusive or objectionable content/)
  }
})

test('Settings has a Your data anchor and Help & legal links; signed-in pages offer Help & support in the Me menu', async t => {
  const app = await site(t)
  const session = await app.signIn()
  const settings = await app.request('/settings', { headers: { Cookie: session } })
  assert.equal(settings.status, 200)
  const body = await settings.text()
  assert.match(body, /<h2 id="your-data">Your data<\/h2>/)
  const help = body.match(/<h2 id="help">Help &amp; legal<\/h2><div class="card">(.*?)<\/div>/s)?.[1]
  assert.ok(help)
  for (const link of [`mailto:${SUPPORT_EMAIL}`, '/support', PRIVACY_URL, TERMS_URL, FEEDBACK_URL]) assert.ok(help.includes(`href="${link}"`), link)
  assert.match(body, /<a role="menuitem" href="\/support">/)
  // Signed in, the support page keeps the member's header and footer.
  const support = await (await app.request('/support', { headers: { Cookie: session } })).text()
  assert.match(support, /details class="me"/)
  assert.match(footerOf(support), /Sign out/)
})
