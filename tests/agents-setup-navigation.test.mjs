import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'

test('For agents uses live/restored sessions, keeps anonymous return navigation and never provisions keys', async t => {
  let handler, keyCalls = 0, backendCalls = 0
  const store = createMemorySessionStore()
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const createHandler = () => createPrivateBrowserHandler({ baseUrl, sessionStore: store,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/authorize', transaction: { state: 'synthetic' } }),
      finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'synthetic-agent-reader', displayName: 'Synthetic Reader' }) },
    resolveOwner: async () => ({ ownerId: 'synthetic-owner', userId: 'synthetic-user' }),
    signup: async () => { throw Error('unexpected_signup') },
    getBackend: async () => { backendCalls++; throw Error('unexpected_backend') },
    issueAccountGrant: async () => { keyCalls++; throw Error('unexpected_issue') },
    ensureAccountGrant: async () => { keyCalls++; throw Error('unexpected_ensure') },
    revokeAccountGrant: async () => { keyCalls++; throw Error('unexpected_revoke') },
  })
  handler = createHandler()
  const page = async (cookie, method = 'GET') => {
    const response = await fetch(endpoint + '/agents', { method, headers: cookie ? { Cookie: cookie } : {} })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.text()
  }
  const anonymous = await page()
  // Follow the emitted navigation through the actual sign-in/callback handler.
  const loginHref = anonymous.match(/href="([^"]+)">Sign in to open API keys<\/a>/)?.[1]
  assert.ok(loginHref)
  const start = await fetch(endpoint + loginHref, { redirect: 'manual' })
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?state=synthetic&code=test', { redirect: 'manual',
    headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.get('location'), '/settings')
  const cookie = callback.headers.getSetCookie().find(row => row.startsWith('__Host-ul-session=')).split(';')[0]
  for (const restarted of [false, true]) {
    if (restarted) handler = createHandler()
    const signed = await page(cookie)
    assert.match(signed, /href="\/settings#api-keys">Open API keys in Settings<\/a>/)
    assert.match(signed, /href="#connect-with-sign-in">Connect Claude or ChatGPT<\/a>/)
    assert.match(signed, /id="connect-with-sign-in"/)
    assert.match(signed, /Synthetic Reader/)
    assert.doesNotMatch(signed, /Sign in to open API keys|Sign in for your agent setup|id="agent-setup-token"/)
    assert.equal(await page(cookie, 'HEAD'), '')
    const nextAnonymous = await page()
    assert.match(nextAnonymous, /Sign in to open API keys/)
    assert.doesNotMatch(nextAnonymous, /Synthetic Reader|name="csrf"|id="agent-setup-token"/)
  }
  const untrusted = await page('__Host-ul-session=synthetic-forged-session')
  assert.match(untrusted, /Sign in to open API keys/)
  assert.doesNotMatch(untrusted, /Synthetic Reader/)
  assert.equal(keyCalls, 0)
  assert.equal(backendCalls, 0)
})
