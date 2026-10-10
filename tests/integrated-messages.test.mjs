import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMessagingSession } from '../mcp-server/messaging.mjs'
import { renderMessages, renderPerson, renderPeople } from '../mcp-server/private-onboarding-views.mjs'

test('membership is visible and unclaimed profiles invite instead of pretending to be recipients', () => {
  const base = { id: 'person', name: 'Avery', positions: [], education: [], skills: [] }
  const shadow = renderPerson({ profile: { ...base, presence: 'shadow' } }).content
  assert.match(shadow, />Not on Unlinked</); assert.match(shadow, /Invite to Unlinked/); assert.doesNotMatch(shadow, /messages\?profile/)
  const member = renderPerson({ profile: { ...base, presence: 'member' } }).content
  assert.match(member, />On Unlinked</); assert.match(member, /href="\/messages\?profile=/)
  const inbox = renderMessages({ csrf: 'fixture' })
  assert.match(inbox.content, /id="msg-app"/); assert.doesNotMatch(inbox.content, /<iframe/)
  assert.doesNotMatch(inbox.content, /token=|subject=|issuer=/)
})

test('session exchange reads the live owner binding and fails closed without it', async () => {
  const owner = { ownerId: 'owner', userId: 'user' }; let seen, sent
  const mint = createMessagingSession({ secret: 's'.repeat(40), identityForOwner: async value => { seen = value; return { issuer: 'https://id.ideaflow.app/api/auth', subject: 'verified' } }, fetchImpl: async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ token: 'fixture', user: { userId: 'inbox' } })) } })
  await mint({ owner, displayName: 'Avery' }); assert.deepEqual(seen, owner)
  assert.deepEqual(JSON.parse(sent.options.body), { issuer: 'https://id.ideaflow.app/api/auth', subject: 'verified', name: 'Avery' })
  assert.equal(sent.options.redirect, 'error')
  await assert.rejects(createMessagingSession({ secret: 's'.repeat(40), identityForOwner: async () => null, fetchImpl: async () => { throw Error('must not call') } })({ owner }))
})

test('the inbox requires browser login; the shell carries no OpenChat credential and no frame permissions', async t => {
  let handler, calls = 0
  const owner = { ownerId: 'owner', userId: 'user' }
  const server = createServer((req, res) => handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl: origin, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://id.example.invalid/auth', transaction: { state: 'fixture-state' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: 'verified', displayName: 'Avery' }) },
    resolveOwner: async () => owner, getBackend: async () => ({ adapter: {} }),
    createMessagingSession: async session => { calls++; assert.deepEqual(session.owner, owner); return { token: 'fixture-private-token', user: { userId: 'inbox' } } },
    messagingOptions: { fetchImpl: async () => new Response(JSON.stringify({ unreadTotal: 2 })) },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  assert.equal((await request('/messages')).status, 401)
  assert.equal((await request('/messages/c/conv_1')).status, 401)
  const start = await request('/login?next=%2Fmessages%2Fc%2Fconv_1'), transaction = start.headers.getSetCookie().find(value => value.startsWith('__Host-ul-login=')).split(';')[0]
  const finish = await request('/auth/callback/ideaflow?state=fixture-state&code=fixture', { headers: { Cookie: transaction } })
  const cookie = finish.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  assert.equal(finish.headers.get('location'), '/messages/c/conv_1')
  const page = await request('/messages/c/conv_1', { headers: { Cookie: cookie } }); const markup = await page.text()
  assert.equal(page.status, 200); assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-src/)
  assert.equal(page.headers.get('permissions-policy'), null)
  assert.doesNotMatch(markup, /fixture-private-token|<iframe/)
  assert.match(markup, /data-nav-messages>Messages<span class="nav-count" aria-label="2 unread">2<\/span>/)
  assert.equal(calls, 1)
  // The old exchange that returned the OpenChat token to the browser no longer exists.
  const csrf = /name="csrf" value="([^"]+)"/.exec(markup)[1]
  const old = await request('/messages/session', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` })
  assert.doesNotMatch(await old.text(), /fixture-private-token/)
})

test('an unclaimed or unavailable profile entry renders an invite or a retry, never an iframe', () => {
  const profile = 'https://www.unlinked.ai/people/faisal-fixture'
  const unclaimed = renderMessages({ csrf: 'fixture', entry: { status: 'unclaimed', name: 'Faisal <b>', profile } }).content
  assert.match(unclaimed, /Faisal &lt;b&gt; is not on Unlinked yet/); assert.match(unclaimed, /href="\/invites"/)
  const unavailable = renderMessages({ csrf: 'fixture', entry: { status: 'unavailable', profile } }).content
  assert.match(unavailable, /href="\/messages\?profile=https%3A%2F%2Fwww\.unlinked\.ai%2Fpeople%2Ffaisal-fixture">Try again/)
  assert.doesNotMatch(unclaimed + unavailable, /<iframe/)
})

test('people search offers an addressed Message for members and one invite for nonmembers', () => {
  const people = [
    { id: 'faisal-fixture', name: 'Faisal', presence: 'member', connect: { state: 'none' } },
    { id: 'shadow', name: 'Imported', presence: 'shadow', connect: { state: 'invite' } },
    { id: 'unknown', name: 'Private contact' },
    { id: 'self', name: 'Me', presence: 'member', connect: { state: 'self' } },
  ]
  for (const group of [{ everyone: people }, { own: people }, { aiMatches: people }, { connectedView: { rows: people, total: 4 } }]) {
    const markup = renderPeople({ csrf: 'fixture', query: 'Faisal', ...group }).content
    const links = [...markup.matchAll(/href="(\/messages\?profile=[^"]+)"/g)].map(match => match[1])
    assert.deepEqual(links, ['/messages?profile=https%3A%2F%2Fwww.unlinked.ai%2Fpeople%2Ffaisal-fixture'])
    assert.equal((markup.match(/>Invite to Unlinked</g) ?? []).length, 1)
  }
  const anonymous = renderPeople({ everyone: [{ id: 'member', name: 'Member', presence: 'member' }] }).content
  assert.match(anonymous, /href="\/messages\?profile=/)
})
