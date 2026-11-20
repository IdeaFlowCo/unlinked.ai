import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { classifyMeetCode } from '../src/utils/meet-scan.js'
import { createMeetSwap, createNeo4jMeetStore, parseSwap } from '../mcp-server/meet-swap.mjs'
import { meetPath } from '../mcp-server/meet-swap-views.mjs'
import { meetFixture } from './helpers/meet-swap-fixture.mjs'

async function harness(t, options) {
  let fixture
  const server = createServer((request, response) => fixture.handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  fixture = await meetFixture(origin, options)
  const get = (path, member, headers = {}) => fetch(endpoint + path, { redirect: 'manual', headers: { ...headers, ...(member ? { Cookie: '__Host-ul-session=' + member.sid } : {}) } })
  const post = (path, values, member, headers = {}) => fetch(endpoint + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...(member ? { Cookie: '__Host-ul-session=' + member.sid } : {}), ...headers },
    body: new URLSearchParams({ ...(member ? { csrf: member.csrf } : {}), ...values }) })
  return { ...fixture, endpoint, get, post }
}
const field = (html, name) => RegExp('name="' + name + '" value="([^"]+)"').exec(html)?.[1]

test('the feature defaults off and preserves the existing contact card', async t => {
  const app = await harness(t, { enabled: false })
  for (const path of ['/swaps', '/swaps/links', '/network/asks', '/m/' + app.ownerCard.token + '?e=dinner']) {
    assert.equal((await app.get(path, app.host)).status, 404)
  }
  assert.equal((await app.get('/c/' + app.ownerCard.token)).status, 200)
})

test('scan, swap, vCard, private card, invite list, pending ask sync and notification use the real browser routes', async t => {
  const app = await harness(t)
  const { get, post, host, other } = app
  assert.equal((await post('/swaps/links', { action: 'create', label: 'Community dinner', csrf: 'wrong' }, host)).status, 403)
  assert.equal((await post('/swaps/links', { action: 'create', label: 'Community dinner', instagram: '@sam', x: 'https://x.com/sam', group: app.group.id }, host)).status, 303)
  const [link] = (await app.meetSwap.read(host)).links
  const path = meetPath(link)
  assert.deepEqual(classifyMeetCode('https://www.unlinked.ai' + path), { kind: 'unlinked', href: path, label: 'Unlinked swap link' })
  assert.equal(classifyMeetCode('https://www.unlinked.ai.evil.test' + path), null)
  assert.equal(classifyMeetCode('https://www.unlinked.ai' + path + '&vcard=1'), null)
  assert.equal((await get(path.replace('e=', 'wrong='))).status, 400)
  const landing = await get(path)
  assert.equal(landing.status, 200)
  assert.equal(landing.headers.get('cache-control'), 'no-store, private')
  assert.match(landing.headers.get('x-robots-tag'), /noindex/)
  const form = await landing.text()
  assert.match(form, /Swap numbers with Sam/)
  assert.match(form, /autocomplete="tel"[^>]*autofocus/)
  assert.match(form, /I’d like to join Climate Builders/)
  assert.doesNotMatch(form, /\+14155550112|sam@example.test/)
  const submission = field(form, 'submission')
  assert.ok(submission)
  const values = { submission, phone: '(415) 555-0113', instagram: 'https://instagram.com/maya/?igsh=tracking',
    name: 'Maya Chen', about: 'I build fusion sensors', ask: 'A fusion sensors cofounder', invite: 'yes', join: 'yes' }
  assert.equal((await post(path, values, null, { Origin: 'https://wrong.test' })).status, 403)
  assert.equal((await post(path, { submission })).status, 400)
  const added = await post(path, values)
  assert.equal(added.status, 200)
  const page = await added.text()
  assert.match(page, /Add Sam to contacts/)
  assert.match(page, new RegExp('/groups/' + app.group.id + '/join/' + app.flyer.id))
  assert.doesNotMatch(page, /Maya Chen|\+14155550113|cofounder/)
  const vcard = await get(path + '&vcard=1')
  assert.match(vcard.headers.get('content-type'), /text\/vcard/)
  assert.match(await vcard.text(), /TEL;TYPE=CELL:\+14155550112[\s\S]*URL:https:\/\/www\.instagram\.com\/sam\/[\s\S]*URL:https:\/\/x\.com\/sam/)
  assert.equal((await post(path, values)).status, 200)
  const { contacts, encounters } = await app.meetSwap.read(host)
  assert.equal(contacts.length, 1)
  assert.equal(encounters.length, 1)
  assert.deepEqual(contacts[0].channels, { phone: '+14155550113', instagram: 'maya' })
  const notify = await app.notifications.list(host)
  assert.equal(notify.length, 1)
  assert.equal(notify[0].kind, 'meet_swap')
  const person = '/swaps/person/' + contacts[0].id
  const opened = await get('/notifications/' + notify[0].id, host)
  assert.equal(opened.status, 303, await opened.text())
  assert.equal(opened.headers.get('location'), person)
  assert.equal((await get(person)).status, 401)
  assert.equal((await get(person, other)).status, 404)
  const detail = await (await get(person, host, { 'User-Agent': 'iPhone' })).text()
  assert.match(detail, /sms:\+14155550113&amp;body=Hey%20Maya/)
  assert.match(detail, /fusion sensors cofounder/)
  assert.match(detail, /Unverified/)
  assert.match(detail, /Ask for Maya Chen/)
  assert.match(await (await get('/swaps/invites?q=fusion', host)).text(), /Maya Chen/)
  assert.doesNotMatch(await (await get('/swaps/invites', other)).text(), /Maya Chen/)
  assert.ok(app.operations.some(op => op.method === 'POST' && op.path.endsWith('/asks') && op.payload.exposure === 'only_me'))
  assert.ok(!app.operations.some(op => JSON.stringify(op.payload)?.includes('415555')))
  assert.equal((await post(person, { action: 'note', note: 'Met by the demo booth' }, host)).status, 303)
  assert.match(await (await get(person, host)).text(), /Met by the demo booth/)

  await app.contactCards.rotate(host)
  assert.equal((await get(path)).status, 404)
  assert.equal((await get(path + '&vcard=1')).status, 404)
  assert.equal((await get(person, host)).status, 200)
})

test('ambiguous names require selection and explicit confirmation bound to the owner session', async t => {
  const app = await harness(t)
  const { get, post, host, other } = app
  const link = await app.meetSwap.createLink(host, app.ownerCard.token, { label: 'Founders night' })
  for (const [name, email] of [['Maya Chen', 'chen@example.test'], ['Maya Ortiz', 'ortiz@example.test']]) {
    assert.equal((await post(meetPath(link), { submission: randomUUID(), name, email })).status, 200)
  }
  const reviewed = await post('/network/asks/preview', { text: 'Maya needs a cofounder', source: 'Dictated' }, host)
  assert.equal(reviewed.status, 200)
  const draft = await reviewed.text()
  assert.match(draft, /Which Maya/)
  assert.match(draft, /Maya Chen/)
  assert.match(draft, /Maya Ortiz/)
  assert.equal(app.asks.get(host.userId).length, 0)
  const proof = field(draft, 'proof')
  assert.ok(proof)
  assert.equal((await post('/network/asks/save', { proof, person: '0' }, other)).status, 409)
  assert.equal((await post('/network/asks/save', { proof, person: '2' }, host)).status, 409)
  assert.equal((await post('/network/asks/save', { proof, person: '0' }, host)).status, 303)
  assert.equal((await post('/network/asks/save', { proof, person: '0' }, host)).status, 409)
  const [saved] = app.asks.get(host.userId)
  assert.equal(saved.text, 'a cofounder')
  assert.equal(saved.evidence.label, 'Dictated')
  assert.match(await (await get('/network/asks', host)).text(), /Founders &amp; funding/)
  assert.doesNotMatch(await (await get('/network/asks', other)).text(), /cofounder<\/p>/i)
  assert.equal((await post('/network/asks/status', { ask: saved.id, status: 'fulfilled' }, other)).status, 404)
  assert.equal((await post('/network/asks/status', { ask: saved.id, status: 'fulfilled' }, host)).status, 303)
  assert.equal(saved.status, 'fulfilled')
})

test('failed OpenChat sync preserves the swap and allows owner retries; channel conflicts retain an audit', async t => {
  const app = await harness(t)
  const { get, post, host } = app
  const link = await app.meetSwap.createLink(host, app.ownerCard.token, { label: 'Demo night' })
  app.upstream.unavailable = true
  const path = meetPath(link)
  const submission = randomUUID()
  assert.equal((await post(path, { submission, phone: '4155550113', ask: 'A mentor' })).status, 200)
  assert.equal((await post(path, { submission: randomUUID(), instagram: 'maya' })).status, 200)
  assert.equal((await post(path, { submission: randomUUID(), phone: '4155550113', instagram: 'maya' })).status, 200)
  const { contacts, encounters } = await app.meetSwap.read(host)
  assert.equal(contacts.length, 2)
  assert.equal(encounters[0].action, 'conflict')
  assert.equal(encounters[0].contactId, null)
  const person = '/swaps/person/' + contacts.find(contact => contact.channels.phone).id
  assert.match(await (await get(person, host)).text(), /Asks waiting to sync/)
  app.upstream.unavailable = false
  assert.equal((await post(person, { action: 'retry', encounter: submission }, host)).status, 303)
  assert.equal((await post(person, { action: 'retry', encounter: submission }, host)).status, 303)
  assert.equal(app.asks.get(host.userId).length, 1)
  assert.doesNotMatch(await (await get(person, host)).text(), /Asks waiting to sync/)
})

test('anonymous writes have independent IP and QR limits', async t => {
  const app = await harness(t)
  const link = await app.meetSwap.createLink(app.host, app.ownerCard.token, { label: 'Busy event' })
  const path = meetPath(link)
  const send = ip => app.post(path, { submission: randomUUID(), phone: '4155550113' }, null, { 'X-Forwarded-For': ip })
  for (let i = 0; i < 12; i++) assert.equal((await send('192.0.2.10')).status, 200)
  assert.equal((await send('192.0.2.10')).status, 429)
  for (let i = 0; i < 28; i++) assert.equal((await send('192.0.2.' + (50 + i))).status, 200)
  assert.equal((await send('192.0.2.250')).status, 429)
  assert.equal((await app.meetSwap.read(app.host)).encounters.length, 40)
})

test('Neo4j serializes duplicate claims and protects owner-scoped rows during deletion', {
  skip: !process.env.UNLINKED_TEST_NEO4J_URI || !process.env.UNLINKED_TEST_NEO4J_DRIVER
}, async t => {
  const neo4j = (await import(pathToFileURL(process.env.UNLINKED_TEST_NEO4J_DRIVER + '/lib/index.js'))).default
  const driver = neo4j.driver(process.env.UNLINKED_TEST_NEO4J_URI, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const store = createNeo4jMeetStore(driver)
  const meet = createMeetSwap({ store })
  const owner = { ownerId: randomUUID(), userId: randomUUID() }, other = { ownerId: randomUUID(), userId: randomUUID() }
  t.after(async () => { await Promise.all([meet.removeOwner(owner), meet.removeOwner(other)]); await driver.close() })
  await store.initialize()
  const link = await meet.createLink(owner, 'FictionalCard00000000000', { label: 'Demo evening' })
  const values = parseSwap(new URLSearchParams({ submission: randomUUID(), phone: '+14155550113' }), link)
  const results = await Promise.all(Array.from({ length: 8 }, () => meet.capture(owner, link, values)))
  assert.equal(results.filter(result => !result.duplicate).length, 1)
  const contact = results.find(result => result.contact).contact
  assert.equal((await meet.read(owner)).encounters.length, 1)
  await assert.rejects(meet.note(other, contact.id, 'private'))
  await meet.removeOwner(owner)
  await assert.rejects(meet.capture(owner, link, values))
  assert.equal(await meet.exportOwner(owner), null)
})
