// Data liberation (docs/data-liberation.md): a public page of official
// export links for LinkedIn, Facebook, Instagram and other big platforms,
// linked from every footer, Settings → Your data and the LinkedIn import guide.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler, autoSignInPage } from '../mcp-server/private-browser.mjs'
import { DATA_EXPORTS, renderDataLiberation, renderImportGuide, iosAppView } from '../mcp-server/private-onboarding-views.mjs'

const owner = { ownerId: 'liberate-owner', userId: 'liberate-user' }

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

test('the page answers without a session and links each service’s own export page', async t => {
  const app = await site(t)
  for (const method of ['GET', 'HEAD']) assert.equal((await app.request('/data-liberation', { method })).status, 200, method)
  const body = await (await app.request('/data-liberation')).text()
  assert.match(body, /<h1 class="hq">Data liberation<\/h1>/)
  // One aspirational line under the lead; it names a direction, not an Unlinked feature.
  assert.match(body, /<\/p><p class="liberate-why">Taking your data with you helps build an open, agent-friendly web, where your information moves with you and works with the tools and agents you choose\.<\/p><nav class="liberate-jump"/)
  assert.match(body, /<title>Data liberation · Unlinked<\/title>/)
  const links = Object.fromEntries(DATA_EXPORTS.map(value => [value.id, value.url]))
  assert.equal(links.linkedin, 'https://www.linkedin.com/mypreferences/d/download-my-data')
  assert.equal(links.facebook, 'https://www.facebook.com/dyi')
  assert.equal(links.instagram, 'https://accountscenter.instagram.com/info_and_permissions/dyi/')
  assert.equal(links.google, 'https://takeout.google.com/')
  // The big three first, then everything else; WhatsApp leads the rest and has no web page.
  assert.deepEqual(DATA_EXPORTS.filter(value => value.tier === 'primary').map(value => value.id), ['linkedin', 'facebook', 'instagram'])
  assert.deepEqual(DATA_EXPORTS.filter(value => value.tier === 'more').map(value => value.id).slice(0, 2), ['whatsapp', 'apple'])
  assert.ok(DATA_EXPORTS.every(value => ['primary', 'more'].includes(value.tier)))
  assert.ok(body.indexOf('id="services"') < body.indexOf('id="linkedin"') && body.indexOf('id="instagram"') < body.indexOf('id="more-services"') && body.indexOf('id="more-services"') < body.indexOf('id="whatsapp"'))
  assert.equal(links.whatsapp, null)
  // WhatsApp: no export button, only links to WhatsApp's own help steps.
  const whatsapp = body.slice(body.indexOf('id="whatsapp"'), body.indexOf('</article>', body.indexOf('id="whatsapp"')))
  assert.doesNotMatch(whatsapp, /class="button|data-export-link/)
  assert.ok(whatsapp.includes('href="https://faq.whatsapp.com/526463418847093"') && whatsapp.includes('href="https://faq.whatsapp.com/1180414079177245"'))
  assert.equal(links.microsoft, 'https://account.microsoft.com/privacy/download-data')
  assert.match(body, /Export your information/); assert.doesNotMatch(body, /Download your information/)
  for (const value of DATA_EXPORTS.filter(value => value.url)) {
    assert.match(value.url, /^https:\/\//, value.id)
    assert.ok(body.includes(`id="${value.id}"`), value.id)
    assert.ok(body.includes(`href="${value.url}" target="_blank" rel="noopener noreferrer"`), value.id)
  }
  for (const id of ['before', 'services', 'more-services', 'whatsapp', 'no-export-button', 'bring-it-here']) assert.ok(body.includes(`id="${id}"`), id)
  assert.ok(body.includes('href="/import-linkedin"'))
  const csp = (await app.request('/data-liberation')).headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.equal(app.ownerReads(), 0)
  assert.equal(autoSignInPage('/data-liberation'), false)
  for (const path of ['/export-your-data', '/data-export']) {
    const response = await app.request(path)
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/data-liberation')
  }
})

test('every footer links the page; Settings and the import guide mention it once, quietly', async t => {
  const app = await site(t)
  for (const path of ['/', '/join', '/agents', '/support', '/data-liberation']) assert.ok(footerOf(await (await app.request(path)).text()).includes('<a href="/data-liberation">Data liberation</a>'), path)
  const session = await app.signIn()
  const settings = await (await app.request('/settings', { headers: { Cookie: session } })).text()
  const yourData = settings.slice(settings.indexOf('<h2 id="your-data">'))
  assert.match(yourData.slice(0, 1500), /<a href="\/data-liberation">Data liberation →<\/a>/)
  assert.equal((renderImportGuide().content.match(/href="\/data-liberation"/g) ?? []).length, 2) // the note and the footer
  // Signed in, the page points at Settings directly.
  assert.ok((await (await app.request('/data-liberation', { headers: { Cookie: session } })).text()).includes('href="/settings#your-data"'))
})

test('in the iOS app every export link opens in Safari, where people are signed in', () => {
  const app = iosAppView(renderDataLiberation().content)
  for (const value of DATA_EXPORTS.filter(value => value.url)) assert.ok(app.includes(`x-safari-${value.url}`), value.id)
  assert.doesNotMatch(app, /data-export-link href="https:/)
})
