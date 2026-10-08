import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createContactCards, createMemoryContactCardStore } from '../mcp-server/contact-card.mjs'
import { createConnectionRequests, createMemoryConnectionStore } from '../mcp-server/member-connections.mjs'
import { renderCard } from '../mcp-server/private-onboarding-views.mjs'

const sharer = { ownerId: 'card-owner', userId: 'card-user' }
const visitor = { ownerId: 'visitor-owner', userId: 'visitor-user' }
async function site(t, { existing = false, self = false } = {}) {
  const cards = createContactCards({ store: createMemoryContactCardStore() })
  const connectionStore = createMemoryConnectionStore()
  const connections = createConnectionRequests({ store: connectionStore })
  const saved = await cards.save(sharer, { email: 'ada@example.test', showEmail: true }, { name: 'Ada Example' })
  let registered = existing, signups = 0, fail = false
  const current = self ? sharer : visitor
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://id.example.test/authorize', transaction: { state: 'test-state' } }), finish: async () => ({ issuer: 'https://id.example.test', subject: 'visitor', displayName: 'Grace Example' }) },
    resolveOwner: async () => registered || self ? current : null,
    signup: async () => { registered = true; signups++; return current },
    getBackend: async () => { if (fail) throw Error('unavailable'); return backend },
    contactCards: cards, memberConnections: connections, accountForProfile: async () => null,
    issueAccountGrant: async () => ({ accessToken: 'test' }), revokeAccountGrant: async () => {},
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const path = `/c/${saved.token}`
  const post = (url, fields = {}, cookie, origin = baseUrl) => request(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields) })
  const start = () => post(path + '/add')
  const finish = async response => {
    const loginCookie = response.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?state=test-state&code=test', { headers: { Cookie: loginCookie } })
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))?.split(';')[0]
    return { callback, cookie, loginCookie }
  }
  return { cards, connections, connectionStore, saved, request, path, post, start, finish, signups: () => signups, fail: value => { fail = value } }
}

test('scanned card signs up a new visitor and connects both accounts without a profile or archive', async t => {
  const s = await site(t)
  const page = await s.request(s.path)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Sign up &amp; add Ada/)
  assert.equal(s.connectionStore.records.size, 0, 'Viewing a card never connects anyone')
  const start = await s.start()
  assert.equal(start.status, 303)
  assert.equal(start.headers.get('location'), 'https://id.example.test/authorize')
  const { callback, cookie, loginCookie } = await s.finish(start)
  assert.equal(callback.headers.get('location'), s.path)
  assert.equal(s.signups(), 1)
  assert.equal((await s.connections.between(visitor, sharer)).state, 'connected')
  assert.equal((await s.connections.connections(visitor)).length, 1)
  assert.equal((await s.connections.connections(sharer)).length, 1)
  const body = await (await s.request(s.path, { headers: { Cookie: cookie } })).text()
  assert.match(body, /Added to your connections/)
  assert.doesNotMatch(body, /card-owner|card-user|visitor-owner|visitor-user/)
  const csrf = body.match(/name="csrf" value="([^"]+)"/)[1]
  assert.equal((await s.post(s.path + '/add', { csrf }, cookie)).status, 303)
  assert.equal(s.connectionStore.records.size, 1, 'Repeated taps are idempotent')
  assert.equal((await s.post(s.path + '/add', { csrf: 'wrong' }, cookie)).status, 400)
  const replay = await s.request('/auth/callback/ideaflow?state=test-state&code=test', { headers: { Cookie: loginCookie } })
  assert.equal(replay.status, 400)
  assert.equal(s.connectionStore.records.size, 1)
})

test('existing members, pending requests in either direction and own-card scans do not duplicate accounts or connections', async t => {
  for (const direction of ['none', 'incoming', 'outgoing', 'connected', 'self']) {
    await t.test(direction, async t => {
      const s = await site(t, { existing: true, self: direction === 'self' })
      if (['incoming', 'outgoing', 'connected'].includes(direction)) {
        const sender = direction === 'incoming' ? sharer : visitor, recipient = direction === 'incoming' ? visitor : sharer
        const sent = await s.connections.send({ sender, recipient })
        if (direction === 'connected') await s.connections.respond(recipient, sent.request.id, 'accept')
      }
      const { callback } = await s.finish(await s.start())
      assert.equal(callback.headers.get('location'), s.path)
      assert.equal(s.signups(), 0)
      assert.equal(s.connectionStore.records.size, direction === 'self' ? 0 : 1)
      if (direction !== 'self') assert.equal((await s.connections.between(visitor, sharer)).state, 'connected')
    })
  }
})

test('invalid intent, cross-origin submits, hidden cards and rotated cards never connect', async t => {
  const s = await site(t)
  assert.equal((await s.post(s.path + '/add', {}, undefined, 'https://evil.test')).status, 403)
  assert.equal((await s.post(s.path + '/add', { ownerId: 'other' })).status, 400)
  assert.equal((await s.post('/c/000000000000000000000000/add')).status, 404)
  const start = await s.start()
  await s.cards.rotate(sharer)
  const { callback } = await s.finish(start)
  assert.equal(callback.headers.get('location'), s.path + '?add=failed')
  assert.equal(s.connectionStore.records.size, 0)
  assert.equal((await s.request(s.path)).status, 404)
  const current = await s.cards.read(sharer)
  await s.cards.save(sharer, { email: 'ada@example.test', showEmail: false })
  assert.equal((await s.post(`/c/${current.token}/add`)).status, 404)
  assert.equal(await s.cards.ownerForToken(current.token), null)
})

test('failed add keeps the signed-in session and offers a working retry', async t => {
  const s = await site(t)
  const start = await s.start()
  s.fail(true)
  const { callback, cookie } = await s.finish(start)
  assert.equal(callback.headers.get('location'), s.path + '?add=failed')
  assert.ok(cookie)
  assert.equal(s.connectionStore.records.size, 0)
  s.fail(false)
  const body = await (await s.request(callback.headers.get('location'), { headers: { Cookie: cookie } })).text()
  assert.match(body, /We couldn’t add this person/)
  assert.match(body, /Add Ada to my connections/)
  const csrf = body.match(/name="csrf" value="([^"]+)"/)[1]
  await s.post(s.path + '/add', { csrf }, cookie)
  assert.equal((await s.connections.between(visitor, sharer)).state, 'connected')
})

test('My card is one tap from the main navigation, defaults to details, and includes the full professional profile', () => {
  const view = renderCard({ csrf: 'test', profile: { name: 'Ada Example', about: 'Builds analytical engines', positions: [{ title: 'Engineer', company: 'Engine Works' }], education: [{ institution: 'Example University' }], skills: ['Mathematics'] }, contact: { settings: {}, card: null } })
  const header = view.content.match(/<header>(.*?)<\/header>/s)[1]
  assert.match(header.split('<details class="me">')[0], /class="my-card-link" href="\/card"/)
  assert.match(view.content, /aria-current="page">With contact details/)
  for (const text of ['Builds analytical engines', 'Engine Works', 'Example University', 'Mathematics', 'name="phone"']) assert.ok(view.content.includes(text), text)
})
