import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createContactCards, createMemoryContactCardStore, projectContactCard } from '../mcp-server/contact-card.mjs'
import { createConnectionRequests, createMemoryConnectionStore } from '../mcp-server/member-connections.mjs'
import { iosAppView, IOS_EXPORT_HREF, renderBringArchive, renderLanding, renderMeet, renderScan, TOP_BAR_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'
import { MEET_SCRIPT } from '../mcp-server/public-discovery.mjs'
import { decodeImageFile } from '../src/utils/browser-card-scanner.js'
import { qrMatrix } from '../src/utils/qr-code.mjs'

// QR from day one, joining from a scan, scanner fallbacks and the iOS app's
// LinkedIn export hand-off (docs/contact-card.md, docs/ios-app-web.md).
const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1 UnlinkediOS/1.0.0'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const member = (ownerId, userId = `${ownerId}-user`) => ({ ownerId, userId })

test('a new member’s card is their name alone, shared from day one; nothing private until they add it', async () => {
  const cards = createContactCards({ store: createMemoryContactCardStore() })
  const grace = member('grace')
  const created = await cards.ensure(grace, { name: 'Grace Hopper', headline: 'Rear admiral' })
  assert.equal(created.card.name, 'Grace Hopper')
  assert.deepEqual([created.card.phone, created.card.whatsapp, created.card.email, created.card.link], [null, null, null, null])
  assert.ok(await cards.open(created.token))
  assert.deepEqual(await cards.ownerForToken(created.token), grace)
  // Idempotent: never a second card or link, and never over an existing card.
  assert.equal((await cards.ensure(grace, { name: 'Someone Else' })).token, created.token)
  const ada = member('ada')
  await cards.save(ada, { email: 'ada@example.test', showEmail: false })
  assert.equal(await cards.ensure(ada, { name: 'Ada' }).then(view => view.card), null, 'an older card with nothing shown stays unshared')
  // No usable name, no card.
  assert.equal(await cards.ensure(member('nameless'), { name: '' }), null)
  // Stopping sharing hides the card entirely; turning it on again restores the same link.
  await cards.save(grace, { shareCard: false })
  assert.equal(await cards.open(created.token), null)
  await cards.save(grace, { shareCard: true, email: 'grace@example.test', showEmail: true })
  assert.equal((await cards.open(created.token)).email, 'grace@example.test')
  // Saving without the switch keeps the stored choice.
  await cards.save(grace, { email: 'grace@example.test' })
  assert.equal((await cards.open(created.token)).name, 'Grace Hopper')
  // The projection rules, directly.
  assert.equal(projectContactCard({ token: 't', name: 'A B', shareCard: true }).name, 'A B')
  assert.equal(projectContactCard({ token: 't', name: 'A B' }), null)
  assert.equal(projectContactCard({ token: 't', shareCard: true }), null)
  assert.equal(projectContactCard({ token: 't', name: 'A B', shareCard: false, email: 'a@b.co', showEmail: true }), null)
  assert.equal(projectContactCard({ token: 't', name: 'A B', email: 'a@b.co', showEmail: true }).email, 'a@b.co')
})

async function site(t, { visitorName = 'Grace Hopper', visitorEmail = 'grace@example.test', messaging = false, blocked = false, failMessaging = false } = {}) {
  const store = createMemoryContactCardStore(), cards = createContactCards({ store })
  const connectionStore = createMemoryConnectionStore(), connections = createConnectionRequests({ store: connectionStore })
  const ada = member('ada'), grace = member('grace')
  const saved = await cards.save(ada, { email: 'ada@example.test', showEmail: true, shareCard: true }, { name: 'Ada Lovelace', profilePath: '/people/ada' })
  const snapshot = { state: 'published', complete: true, revision: 'scan-fixture-1', members: ['ada'],
    profiles: [{ id: 'ada', name: 'Ada Lovelace', headline: 'Analyst', positions: [], education: [], skills: [] }, { id: 'imported', name: 'Imported Person', positions: [], education: [], skills: [] }], connections: [] }
  const readPublishedSnapshot = async () => snapshot; readPublishedSnapshot.revisionIdentifiesContent = true
  let current = null, registered = new Set(['ada']), signups = 0, handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const accounts = { ada, grace }, names = { ada: 'Ada Lovelace', grace: visitorName }, emails = { ada: 'ada@example.test', grace: visitorEmail }
  const messageCalls = [], resolvedOwners = [], loginBegins = []
  handler = createPrivateBrowserHandler({ ...(messaging ? {
    createMessagingSession: async session => ({ token: `viewer-${session.owner.ownerId}`, user: { userId: `oc-${session.owner.ownerId}` } }),
    resolveCardMessagingRecipient: async (owner, name) => { resolvedOwners.push(owner); if (failMessaging) throw Error('offline'); return { id: `oc-${owner.ownerId}`, name } },
    messagingOptions: { blockedUsers: async () => blocked ? ['oc-ada'] : [], fetchImpl: async (url, options) => {
      messageCalls.push({ url, ...options })
      if (url.endsWith('/api/chat/unread-total')) return Response.json({ unreadTotal: 0 })
      assert.ok(url.endsWith('/api/chat/conversations'))
      assert.equal(options.headers.Authorization, 'Bearer viewer-grace', 'only the viewer credential opens the conversation')
      assert.deepEqual(JSON.parse(options.body), { participantIds: ['oc-ada'], type: 'direct' })
      return Response.json({ id: 'direct-grace-ada', type: 'direct', participants: [] })
    } },
  } : {}), baseUrl, dataMode: 'private_live', readPublishedSnapshot,
    login: { begin: async (options = {}) => { loginBegins.push(options); return { location: 'https://id.example.invalid/authorize', transaction: { state: 's' } } }, finish: async () => ({ issuer: 'https://id.example.invalid', subject: current, displayName: names[current], verifiedEmail: emails[current] }) },
    resolveOwner: async identity => registered.has(identity.subject) ? accounts[identity.subject] : null,
    signup: async () => { registered.add(current); signups++; return accounts[current] },
    ownProfileId: async owner => owner.ownerId === 'ada' ? 'ada' : null, accountForProfile: async id => id === 'ada' ? ada : null,
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readLegacyFiles: async () => null, readLegacyProfile: async () => null }),
    contactCards: cards, memberConnections: connections, issueAccountGrant: async () => ({ accessToken: 'x' }), revokeAccountGrant: async () => {} })
  const request = (path, { cookie, agent, ...options } = {}) => fetch(endpoint + path, { redirect: 'manual', ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(agent ? { 'User-Agent': agent } : {}), ...(options.headers ?? {}) } })
  const post = (path, fields = {}, { cookie, origin = baseUrl } = {}) => request(path, { cookie, method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  // Ideaflow returns: the login cookie from `started` is the browser's.
  const finish = async (who, started) => {
    current = who
    const login = started.headers.getSetCookie().find(value => value.startsWith('__Host-ul-login=')).split(';')[0]
    const callback = await request('/auth/callback/ideaflow?state=s&code=c', { cookie: login })
    return { callback, cookie: callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))?.split(';')[0] }
  }
  const signIn = async (who, next) => (await finish(who, await request(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`)))
  return { loginBegins, messageCalls, resolvedOwners, cards, connections, connectionStore, store, saved, ada, grace, request, post, finish, signIn, signups: () => signups, baseUrl }
}

test('a non-member scans a contact card: save it, or join and land connected with their own card to share back', async t => {
  const s = await site(t)
  const path = `/c/${s.saved.token}`
  const guest = await (await s.request(path, { agent: SAFARI })).text()
  assert.match(guest, /Join Unlinked &amp; connect with Ada/)
  assert.ok(guest.includes(`href="${path}/contact.vcf">Save contact`))
  // The header's Sign in keeps the card as the return target.
  assert.ok(guest.includes(`href="/login?next=${encodeURIComponent(path)}"`))
  const { callback, cookie } = await s.finish('grace', await s.post(`${path}/add`))
  assert.deepEqual(s.loginBegins.at(-1), { prompt: 'select_account' })
  assert.equal(callback.headers.get('location'), `${path}?added=1`)
  assert.equal(s.signups(), 1)
  assert.equal((await s.connections.between(s.grace, s.ada)).state, 'connected')
  const landed = await (await s.request(`${path}?added=1`, { cookie })).text()
  assert.match(landed, /You and Ada Lovelace are connected\./)
  assert.match(landed, /Here’s your card, share it back/)
  // Her own day-one card: her name, a QR code and nothing private.
  const own = await s.cards.read(s.grace)
  assert.equal(own.card.name, 'Grace Hopper'); assert.equal(own.card.email, null)
  assert.ok(landed.includes(`aria-label="QR code opening your contact card"`))
  assert.ok(landed.indexOf('class="share-back"') > 0 && landed.indexOf('class="share-back"') < landed.indexOf('class="ph cc-kicker"'), 'the share-back card comes first')
  assert.doesNotMatch(landed.split('class="ph cc-kicker"')[0].split('<main')[1], /grace@example\.test/)
  // Opening the card later just says they are connected.
  assert.match(await (await s.request(path, { cookie })).text(), /Added to your connections/)
})

test('scanning your own card says so, and the sign-in path keeps scan targets', async t => {
  const s = await site(t)
  const { cookie } = await s.signIn('ada')
  const own = await (await s.request(`/c/${s.saved.token}`, { cookie })).text()
  assert.match(own, /<b>This is your card\.<\/b> This is what people see when they scan it\./)
  assert.doesNotMatch(own, /Add Ada to my connections|Join Unlinked/)
  for (const next of [`/c/${s.saved.token}`, '/scan', '/scan?tab=scan', '/people/lookup', '/meet']) {
    const started = await s.request(`/login?next=${encodeURIComponent(next)}`)
    const { callback } = await s.finish('ada', started)
    assert.equal(callback.headers.get('location'), next, next)
  }
  const started = await s.request(`/login?next=${encodeURIComponent('/scan?tab=evil')}`)
  assert.equal((await s.finish('ada', started)).callback.headers.get('location'), '/')
})

test('a non-member scans a public profile: Join & connect sends the request after sign-up and shows their card to share back', async t => {
  const s = await site(t)
  const page = await (await s.request('/people/ada')).text()
  assert.match(page, /<form class="connect" method="post" action="\/people\/ada\/join">/)
  assert.match(page, /Join Unlinked &amp; connect with Ada/)
  // Cross-origin posts, extra fields and non-members never start anything.
  assert.equal((await s.post('/people/ada/join', {}, { origin: 'https://evil.test' })).status, 403)
  assert.equal((await s.post('/people/ada/join', { profileId: 'x' })).status, 400)
  assert.equal((await s.post('/people/imported/join')).status, 404)
  assert.equal((await s.post('/people/nobody/join')).status, 404)
  const { callback, cookie } = await s.finish('grace', await s.post('/people/ada/join'))
  assert.deepEqual(s.loginBegins.at(-1), { prompt: 'select_account' })
  assert.equal(callback.headers.get('location'), '/people/ada?connect=sent&joined=1')
  assert.equal((await s.connections.between(s.grace, s.ada)).state, 'outgoing', 'a normal request: Ada accepts it')
  const landed = await (await s.request('/people/ada?connect=sent&joined=1', { cookie })).text()
  assert.match(landed, /Request sent to Ada Lovelace\./)
  assert.ok(landed.indexOf('class="share-back"') < landed.indexOf('class="card phead"'), 'the outcome and own card come first')
  assert.match(landed, /Here’s your card, share it back/)
  assert.ok(landed.includes('aria-label="QR code opening your contact card"'))
  // Signed in, the join route just returns to the profile.
  assert.equal((await s.post('/people/ada/join', {}, { cookie })).headers.get('location'), '/people/ada')
})

test('My card puts the QR code first, offers the sign-in email in one tap, and never puts an email-address name on a card', async t => {
  const s = await site(t)
  const { cookie } = await s.signIn('grace')
  const card = await (await s.request('/card', { cookie })).text()
  const main = card.split('<main class="journey">')[1]
  assert.ok(main.indexOf('class="bcard qr-first"') < main.indexOf('cc-lead'), 'the card (and its QR) before the explanation')
  assert.ok(main.indexOf('aria-label="QR code opening your contact card"') < main.indexOf('What this card shares'))
  assert.ok(main.indexOf('id="pwa-hint"') > main.indexOf('class="bcard qr-first"'), 'the install hint is below the card')
  assert.match(card, /Add grace@example\.test to my card/)
  const csrf = card.match(/name="csrf" value="([^"]+)"/)[1]
  // The address comes from the session; a posted one is refused.
  assert.equal((await s.post('/card/contact/email', { csrf, email: 'evil@example.test' }, { cookie })).status, 400)
  const added = await s.post('/card/contact/email', { csrf }, { cookie })
  assert.equal(added.headers.get('location'), '/card?share=contact&done=email')
  const token = (await s.cards.read(s.grace)).token
  assert.equal((await s.cards.open(token)).email, 'grace@example.test')
  assert.doesNotMatch(await (await s.request('/card', { cookie })).text(), /Add grace@example\.test to my card/)
  // In the app: no "Add to Home Screen" hint, no floating feedback button.
  const inApp = await (await s.request('/card', { cookie, agent: IOS_APP })).text()
  assert.doesNotMatch(inApp, /id="pwa-hint"|wit-feedback\.js/)
  assert.match(await (await s.request('/card', { cookie, agent: SAFARI })).text(), /id="pwa-hint"[\s\S]*wit-feedback\.js/)

  const emailNamed = await site(t, { visitorName: 'grace@example.test' })
  const signed = await emailNamed.signIn('grace')
  await emailNamed.request('/card', { cookie: signed.cookie })
  assert.equal(await emailNamed.cards.read(emailNamed.grace), null, 'no automatic card whose name is an email address')
})

test('the iOS app opens LinkedIn’s export page in Safari, with Copy link and the way back; the web is unchanged', () => {
  for (const view of [renderLanding(), renderBringArchive({ csrf: 'c' })]) {
    const web = view.content, app = iosAppView(web)
    assert.match(web, /href="https:\/\/www\.linkedin\.com\/mypreferences\/d\/download-my-data" target="_blank" rel="noopener noreferrer"/)
    assert.doesNotMatch(app, /href="https:\/\/www\.linkedin\.com\/mypreferences/)
    assert.ok(app.includes(`href="${IOS_EXPORT_HREF}"`))
    assert.equal(IOS_EXPORT_HREF, 'x-safari-https://www.linkedin.com/mypreferences/d/download-my-data')
    assert.match(app, /It opens in Safari\. When the file is ready, come back here and choose it from Files → Downloads\./)
    assert.match(app, /data-copy-linkedin-export>Copy link</)
    // The export progress marker still finds the link.
    assert.match(app, /data-linkedin-export[^>]*href="x-safari-https:/)
  }
  assert.match(TOP_BAR_SCRIPT, /data-copy-linkedin-export/)
  assert.match(TOP_BAR_SCRIPT, /UnlinkediOS\\\//)
})

test('scanner: camera failure opens the paste box with how to allow it; Scan from photo reads a QR code from a picture', async t => {
  // /meet and the Scan tab share one scanner.
  for (const content of [renderMeet().content, renderScan({ tab: 'scan' }).content]) {
    assert.match(content, /<input id="scan-photo" class="vh" type="file" accept="image\/\*">/)
    assert.match(content, /<details class="scan-paste">/)
    assert.match(content, /id="start"/); assert.match(content, /id="confirm-open"/)
  }
  assert.match(MEET_SCRIPT, /Allow camera in Settings → Unlinked → Camera\./)
  assert.match(MEET_SCRIPT, /paste\.open=true/)
  assert.match(MEET_SCRIPT, /decodeImageFile/)
  assert.match(MEET_SCRIPT, /No QR code found in that picture/)

  // decodeImageFile, with a fake canvas over a real QR code's pixels.
  const value = 'https://www.unlinked.ai/c/a1B2c3D4e5F6g7H8i9J0k1L2'
  const matrix = qrMatrix(value), scale = 6, quiet = 4, size = (matrix.length + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const o = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; pixels[o] = pixels[o + 1] = pixels[o + 2] = 0 }
  }
  const original = Object.fromEntries(['document', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let closed = 0, blank = false
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: size, height: size, close: () => { closed++ } }) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, width, height) => ({ data: blank ? new Uint8ClampedArray(width * height * 4).fill(255) : pixels, width: size, height: size }) }) }) } })
  assert.equal(await decodeImageFile({ size: 1000 }), value)
  blank = true
  assert.equal(await decodeImageFile({ size: 1000 }), null)
  assert.equal(await decodeImageFile({ size: 0 }), null)
  assert.equal(closed, 2)
})

for (const newMember of [true, false]) test(`card Message opens the right inbox after ${newMember ? 'joining' : 'signing in'}, without a public profile or an automatic send`, async t => {
  const s = await site(t, { messaging: true })
  // Day-one card: the action must not depend on having a profile.
  await s.cards.syncIdentity(s.ada, { name: 'Ada Lovelace', profilePath: null })
  const path = `/c/${s.saved.token}`
  const guest = await (await s.request(path)).text()
  assert.doesNotMatch(guest, /class="cc-message"/)
  const { callback, cookie } = newMember
    ? await s.finish('grace', await s.post(`${path}/add`))
    : await s.signIn('grace', path)
  assert.equal(callback.headers.get('location'), newMember ? `${path}?added=1` : path)
  const landed = await (await s.request(callback.headers.get('location'), { cookie })).text()
  assert.match(landed, /Message Ada<\/button>/)
  assert.doesNotMatch(landed, /href="\/people\/ada">View profile<|oc-ada|viewer-grace/)
  if (newMember) assert.ok(landed.indexOf('class="cc-message"') < landed.indexOf('class="share-back"'))
  assert.equal(s.resolvedOwners.length, 0, 'viewing the card does not provision or open an inbox')
  const csrf = /name="csrf" value="([^"]+)"/.exec(landed)[1]
  for (let click = 0; click < 2; click++) {
    const opened = await s.post(`${path}/message`, { csrf }, { cookie })
    assert.equal(opened.headers.get('location'), '/messages/c/direct-grace-ada')
  }
  assert.deepEqual(s.resolvedOwners, [s.ada, s.ada])
  assert.equal(s.messageCalls.filter(call => call.method === 'POST').length, 2)
  assert.ok(s.messageCalls.every(call => !call.url.includes('/messages')), 'no Send endpoint called')
})

test('card Message checks session, CSRF, live card capability and self before resolving a recipient', async t => {
  const s = await site(t, { messaging: true }), path = `/c/${s.saved.token}`
  assert.equal((await s.post(`${path}/message`)).headers.get('location'), `/login?next=${encodeURIComponent(path)}`)
  const { cookie } = await s.signIn('grace')
  const markup = await (await s.request(path, { cookie })).text(), csrf = /name="csrf" value="([^"]+)"/.exec(markup)[1]
  assert.equal((await s.post(`${path}/message`, {}, { cookie })).status, 400)
  assert.equal((await s.post(`${path}/message`, { csrf, ownerId: 'forged' }, { cookie })).status, 400)
  assert.equal((await s.post(`${path}/message`, { csrf }, { cookie, origin: 'https://evil.test' })).status, 403)
  await s.cards.save(s.ada, { shareCard: false })
  assert.equal((await s.post(`${path}/message`, { csrf }, { cookie })).status, 404)
  await s.cards.save(s.ada, { shareCard: true })
  const rotated = await s.cards.rotate(s.ada)
  assert.equal((await s.post(`${path}/message`, { csrf }, { cookie })).status, 404)
  const self = await s.signIn('ada'), ownPath = `/c/${rotated.token}`
  const own = await (await s.request(ownPath, { cookie: self.cookie })).text()
  assert.doesNotMatch(own, /class="cc-message"/)
  const selfCsrf = /name="csrf" value="([^"]+)"/.exec(own)[1]
  assert.equal((await s.post(`${ownPath}/message`, { csrf: selfCsrf }, { cookie: self.cookie })).headers.get('location'), ownPath)
  assert.equal(s.resolvedOwners.length, 0)
})

for (const blocked of [true, false]) test(`card Message ${blocked ? 'respects blocks' : 'offers retry after an outage'}`, async t => {
  const s = await site(t, { messaging: true, blocked, failMessaging: !blocked }), path = `/c/${s.saved.token}`
  const { cookie } = await s.signIn('grace')
  const markup = await (await s.request(path, { cookie })).text(), csrf = /name="csrf" value="([^"]+)"/.exec(markup)[1]
  const opened = await s.post(`${path}/message`, { csrf }, { cookie })
  assert.equal(opened.headers.get('location'), `${path}?message=${blocked ? 'blocked' : 'failed'}`)
  const result = await (await s.request(opened.headers.get('location'), { cookie })).text()
  assert.match(result, blocked ? /You’ve blocked this person/ : /We couldn’t open the conversation/)
  assert.match(result, /Message Ada/)
  assert.equal(s.messageCalls.filter(call => call.method === 'POST').length, 0)
})
