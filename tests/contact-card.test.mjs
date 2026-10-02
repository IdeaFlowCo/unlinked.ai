import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createContactCards, createMemoryContactCardStore, projectContactCard, normalizePhone, normalizeEmail, normalizeLink, displayPhone, renderContactVcard, ContactCardError, CONTACT_CARD_TOKEN } from '../mcp-server/contact-card.mjs'
import { parseUnlinkedCard, unlinkedProfilePath } from '../src/utils/unlinked-card.js'
import { classifyMeetCode } from '../src/utils/meet-scan.js'

const member = { ownerId: 'synthetic-contact-owner', userId: 'synthetic-contact-user' }
const code = async work => { try { await work(); return null } catch (error) { assert.ok(error instanceof ContactCardError); return error.code } }

test('contact details are normalized strictly: international phone numbers, plain email addresses, https links', async () => {
  assert.equal(normalizePhone(' +1 (415) 555-0123 '), '+14155550123')
  assert.equal(normalizePhone('+44 20.7946.0958'), '+442079460958')
  assert.equal(normalizePhone(''), null)
  for (const value of ['415 555 0123', '+0123456789', '+1 415 555 0123 ext 4', '+12', '+1234567890123456', 'tel:+14155550123', '+1415555<b>']) assert.equal(await code(() => normalizePhone(value)), 'contact_phone_invalid', value)
  assert.equal(displayPhone('+14155550123'), '+1 (415) 555-0123')
  assert.equal(displayPhone('+442079460958'), '+442079460958')
  assert.equal(normalizeEmail(' ada@example.test '), 'ada@example.test')
  for (const value of ['ada', 'ada@', 'ada@example', 'a b@example.test', 'ada@example.test\nBCC:x@example.test', '<ada@example.test>', 'ada@exa..mple.test', 'ada%0D%0Ax@example.test']) assert.equal(await code(() => normalizeEmail(value)), 'contact_email_invalid', value)
  assert.equal(normalizeLink('example.test/me'), 'https://example.test/me')
  assert.equal(normalizeLink('http://example.test'), 'https://example.test/')
  for (const value of ['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/"><script>', 'https://localhost', `https://example.test/${'a'.repeat(200)}`]) assert.equal(await code(() => normalizeLink(value)), 'contact_link_invalid', value)
})

test('the card shows only what is switched on, and does not exist while nothing is shown', async () => {
  const record = { name: 'Ada Example', headline: 'Engineer', profilePath: '/people/ada', phone: '+14155550123', whatsapp: null, email: 'ada@example.test', link: 'https://example.test/' }
  assert.equal(projectContactCard(record), null)
  assert.equal(projectContactCard({ ...record, showPhone: false, showEmail: false, showLink: false, showWhatsapp: false }), null)
  assert.equal(projectContactCard(null), null)
  assert.deepEqual(projectContactCard({ ...record, showPhone: true }), { name: 'Ada Example', headline: 'Engineer', location: null, profilePath: '/people/ada', phone: '+14155550123', whatsapp: null, email: null, link: null })
  // WhatsApp without its own number uses the phone number, without revealing "Phone" separately.
  assert.deepEqual(projectContactCard({ ...record, showWhatsapp: true }), { name: 'Ada Example', headline: 'Engineer', location: null, profilePath: '/people/ada', phone: null, whatsapp: '+14155550123', email: null, link: null })
  assert.equal(projectContactCard({ ...record, whatsapp: '+447700900123', showWhatsapp: true }).whatsapp, '+447700900123')
  // A switch stored as anything but true is off; an unsafe stored link or profile path is dropped.
  assert.equal(projectContactCard({ ...record, showPhone: 'yes', showEmail: 1 }), null)
  assert.equal(projectContactCard({ ...record, link: 'javascript:alert(1)', showLink: true }), null)
  assert.equal(projectContactCard({ ...record, showEmail: true, profilePath: '/settings' }).profilePath, null)
})

test('one card per account: saved details, a stable link, reset and removal', async () => {
  const store = createMemoryContactCardStore()
  const cards = createContactCards({ store, now: () => 1000 })
  assert.equal(await cards.read(member), null)
  assert.equal(await code(() => cards.rotate(member)), 'contact_card_not_found')
  assert.equal(await code(() => cards.save({ ownerId: 'x' }, {})), 'contact_card_owner_required')
  assert.equal(await code(() => cards.save(member, { phone: '555 0123', showPhone: true })), 'contact_phone_invalid')
  assert.equal(await code(() => cards.save(member, { whatsapp: '555 0123' })), 'contact_whatsapp_invalid')
  assert.equal(store.records.size, 0)

  const saved = await cards.save(member, { phone: '+1 415 555 0123', showPhone: true, showWhatsapp: true, email: 'ada@example.test', showEmail: false, showLink: true }, { name: 'Ada Example', headline: 'Engineer', profilePath: '/people/ada' })
  assert.match(saved.token, CONTACT_CARD_TOKEN)
  // A switch for an empty field never stays on.
  assert.deepEqual(saved.settings, { phone: '+14155550123', showPhone: true, whatsapp: null, showWhatsapp: true, email: 'ada@example.test', showEmail: false, link: null, showLink: false })
  assert.deepEqual(await cards.open(saved.token), { name: 'Ada Example', headline: 'Engineer', location: null, profilePath: '/people/ada', phone: '+14155550123', whatsapp: '+14155550123', email: null, link: null })
  for (const token of ['', 'short', saved.token + 'x', saved.token.slice(0, 23) + '-', null, undefined, { token: saved.token }]) assert.equal(await cards.open(token), null)

  // Saving again keeps the link; another account gets its own.
  assert.equal((await cards.save(member, { phone: '+1 415 555 0123', showPhone: true }, { name: 'Ada Example' })).token, saved.token)
  const other = await cards.save({ ownerId: 'other-owner', userId: 'other-user' }, { email: 'bo@example.test', showEmail: true }, { name: 'Bo' })
  assert.notEqual(other.token, saved.token)
  assert.equal((await cards.open(other.token)).phone, null)

  // The name on the card follows the profile.
  assert.equal(await cards.syncIdentity(member, { name: 'Ada Example' }), false)
  assert.equal(await cards.syncIdentity(member, { name: 'Ada E. Example', headline: 'CTO' }), true)
  assert.equal((await cards.open(saved.token)).name, 'Ada E. Example')
  assert.equal(await cards.syncIdentity({ ownerId: 'nobody', userId: 'nobody' }, { name: 'X' }), false)
  // An unknown profile path (index unavailable) keeps the stored one; an explicit null clears it.
  await cards.syncIdentity(member, { name: 'Ada E. Example', headline: 'CTO', profilePath: '/people/ada' })
  await cards.syncIdentity(member, { name: 'Ada E. Example', headline: 'CTO' })
  assert.equal((await cards.open(saved.token)).profilePath, '/people/ada')
  await cards.syncIdentity(member, { name: 'Ada E. Example', headline: 'CTO', profilePath: null })
  assert.equal((await cards.open(saved.token)).profilePath, null)
  // A page view that refreshes the name never rewrites the link or the switches:
  // a reset that lands between its read and its write still wins.
  const racing = createMemoryContactCardStore()
  const raced = createContactCards({ store: { ...racing, get: async value => { const read = await racing.get(value); if (read && racing.onRead) { const hook = racing.onRead; racing.onRead = null; await hook() } return read } } })
  const before = await raced.save(member, { phone: '+14155550123', showPhone: true }, { name: 'Ada' })
  let after
  racing.onRead = async () => { after = await createContactCards({ store: racing }).rotate(member) }
  assert.equal(await raced.syncIdentity(member, { name: 'Ada Renamed' }), true)
  assert.equal(await raced.open(before.token), null)
  assert.equal((await raced.open(after.token)).name, 'Ada Renamed')

  // Hiding everything: the link answers as not found, the details stay with the owner.
  await cards.save(member, { phone: '+1 415 555 0123', showPhone: false }, { name: 'Ada Example' })
  assert.equal(await cards.open(saved.token), null)
  assert.equal((await cards.read(member)).settings.phone, '+14155550123')
  await cards.save(member, { phone: '+1 415 555 0123', showPhone: true }, { name: 'Ada Example' })

  // Reset: a new link; the old one is dead.
  const rotated = await cards.rotate(member)
  assert.notEqual(rotated.token, saved.token)
  assert.equal(await cards.open(saved.token), null)
  assert.equal((await cards.open(rotated.token)).phone, '+14155550123')

  // The export carries the details, never the link or owner ids.
  assert.deepEqual(await cards.exportOwner(member), { phone: '+14155550123', showPhone: true, whatsapp: null, showWhatsapp: false, email: null, showEmail: false, link: null, showLink: false, createdAt: 1000, updatedAt: 1000 })
  assert.equal(await cards.removeOwner(member), 1)
  assert.equal(await cards.open(rotated.token), null)
  assert.equal(await cards.read(member), null)
  assert.equal((await cards.open(other.token)).email, 'bo@example.test')
})

test('the saved contact file holds only the shown details and cannot be extended by a field', () => {
  const vcard = renderContactVcard({ name: 'Ada; Example\r\nTEL:+1999', headline: 'Engineer, Analytical', phone: '+14155550123', whatsapp: '+447700900123', email: 'ada@example.test', link: 'https://example.test/', profilePath: '/people/ada' }, 'https://www.unlinked.ai')
  const lines = vcard.split('\r\n')
  assert.deepEqual(lines.slice(0, 2), ['BEGIN:VCARD', 'VERSION:3.0'])
  assert.ok(lines.includes('FN:Ada\\; Example\\nTEL:+1999'))
  assert.equal(lines.filter(line => line.startsWith('TEL')).join('|'), 'TEL;TYPE=CELL:+14155550123|TEL;TYPE=CELL:+447700900123')
  assert.ok(lines.includes('TITLE:Engineer\\, Analytical'))
  assert.ok(lines.includes('EMAIL;TYPE=INTERNET:ada@example.test'))
  assert.ok(lines.includes('URL:https://wa.me/447700900123'))
  assert.ok(lines.includes('URL:https://www.unlinked.ai/people/ada'))
  assert.equal(lines.at(-2), 'END:VCARD')
  const bare = renderContactVcard({ name: null, phone: null, whatsapp: null, email: 'ada@example.test', link: null, profilePath: null }, 'https://www.unlinked.ai')
  assert.doesNotMatch(bare, /TEL|URL/)
  assert.match(bare, /FN:Unlinked member/)
})

test('the scanner reads a contact card link and keeps it on this host', () => {
  const token = 'a1B2c3D4e5F6g7H8i9J0k1L2'
  assert.deepEqual(parseUnlinkedCard(`https://www.unlinked.ai/c/${token}`), { origin: 'https://www.unlinked.ai', contact: token })
  assert.equal(unlinkedProfilePath(parseUnlinkedCard(`https://www.unlinked.ai/c/${token}/`)), `/c/${token}`)
  assert.deepEqual(classifyMeetCode(`https://www.unlinked.ai/c/${token}`), { kind: 'unlinked', href: `/c/${token}`, label: 'Unlinked contact card' })
  for (const value of [`https://www.unlinked.ai/c/${token}/contact.vcf`, `https://www.unlinked.ai/c/${token.slice(1)}`, `https://www.unlinked.ai/c/${token}?x=1`, `https://evil.test/c/${token}`, `https://www.unlinked.ai/c/${token.slice(0, 23)}-`]) assert.equal(parseUnlinkedCard(value), null, value)
  assert.throws(() => unlinkedProfilePath({ origin: 'https://www.unlinked.ai', contact: 'nope' }))
})

function harness(t, { withCards = true } = {}) {
  const owner = { ownerId: 'synthetic-card-owner', userId: 'synthetic-card-user' }
  const store = createMemoryContactCardStore(), resources = new Map()
  const imports = () => [...resources.values()].filter(x => x.type === 'import' && !x.deleted && x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf).map(x => x.sourceId)
  const backend = {
    adapter: { withImport: async (caller, id, work) => work({ getJob: async () => resources.get(id)?.payload, putAsset: async () => {}, publicationStatus: 'indexed',
      saveJob: async job => resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, deleted: false, payload: structuredClone(job) }), publish: async () => {} }) },
    readResource: async (_type, id) => { const value = resources.get(id); return value ? structuredClone(value) : null },
    writeResource: async value => { const stored = { ...value }; delete stored.expectedRevision; resources.set(value.sourceId, structuredClone(stored)) },
    listImportIds: async () => imports(), listImportJobIds: async () => imports(), listAccountGrantIds: async () => [],
  }
  return { owner, store, async start() {
    let handler
    const server = createServer((req, res) => void handler(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
    const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
    handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
      login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
        finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'card-subject', displayName: 'Card Owner' }) },
      resolveOwner: async () => owner, signup: async () => owner, getBackend: async () => backend, complete: async () => ({ matches: [] }),
      issueAccountGrant: async () => ({ accessToken: 'synthetic' }), revokeAccountGrant: async () => {},
      ...(withCards ? { contactCards: createContactCards({ store }) } : {}),
      mcpEndpoint: `${baseUrl}/mcp` })
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=x`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
    const post = (path, fields, headers = {}) => fetch(`${endpoint}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf, ...fields }) })
    const get = (path, signedIn = true) => fetch(`${endpoint}${path}`, { redirect: 'manual', headers: signedIn ? { Cookie: cookie } : {} })
    return { endpoint, baseUrl, cookie, csrf, post, get }
  } }
}

test('a member builds a contact card, shares it by link, hides it and resets it', async t => {
  const fixture = harness(t)
  const signed = await fixture.start()

  // The card page offers both versions; the public one still carries no contact channel.
  let html = await (await signed.get('/card')).text()
  assert.match(html, /<nav class="tabs" aria-label="Card version"><a href="\/card" aria-current="page">Public<\/a><a href="\/card\?share=contact">With contact details<\/a><\/nav>/)
  assert.doesNotMatch(html, /mailto:|tel:|wa\.me|name="phone"/)

  // The contact version starts empty: a form, and no link or QR yet.
  html = await (await signed.get('/card?share=contact')).text()
  assert.match(html, /Nothing is shared yet/)
  assert.match(html, /<form class="card cc-form" method="post" action="\/card\/contact">/)
  assert.match(html, /name="showPhone" value="yes" checked/)
  assert.doesNotMatch(html, /name="showWhatsapp" value="yes" checked/)
  assert.doesNotMatch(html, /QR code opening your contact card|\/c\/[0-9A-Za-z]{24}/)
  assert.equal(fixture.store.records.size, 0)

  // Saving needs the session token, this origin and only the known fields.
  assert.equal((await signed.post('/card/contact', { csrf: 'wrong', phone: '+14155550123' })).status >= 400, true)
  assert.equal((await signed.post('/card/contact', { phone: '+14155550123' }, { Origin: 'https://evil.test' })).status, 403)
  assert.equal((await signed.post('/card/contact', { phone: '+14155550123', ownerId: 'someone-else' })).status >= 400, true)
  assert.equal((await fetch(`${signed.endpoint}/card/contact`, { method: 'POST', redirect: 'manual', headers: { Origin: signed.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: signed.csrf, phone: '+14155550123' }) })).status >= 400, true)
  assert.equal(fixture.store.records.size, 0)

  // A number without its country code is refused, and what was typed comes back escaped.
  let response = await signed.post('/card/contact', { phone: '415 555 "0123"', showPhone: 'yes', email: 'ada@example.test' })
  assert.equal(response.status, 400)
  html = await response.text()
  assert.match(html, /role="alert">Write your phone number with its country code/)
  assert.match(html, /name="phone"[^>]*value="415 555 &quot;0123&quot;"/)
  assert.match(html, /name="email"[^>]*value="ada@example\.test"/)
  assert.equal(fixture.store.records.size, 0)

  response = await signed.post('/card/contact', { phone: '+1 (415) 555-0123', showPhone: 'yes', showWhatsapp: 'yes', email: 'ada@example.test', link: 'example.test/ada', showLink: 'yes' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/card?share=contact&done=saved')
  html = await (await signed.get('/card?share=contact&done=saved')).text()
  assert.match(html, /role="status">Saved\./)
  const shareUrl = html.match(/id="cc-link-out" type="text" readonly value="([^"]+)"/)[1]
  const token = shareUrl.match(/\/c\/([0-9A-Za-z]{24})$/)[1]
  assert.equal(shareUrl, `${signed.baseUrl}/c/${token}`)
  assert.match(html, /<svg[^>]*aria-label="QR code opening your contact card"/)
  // The owner's preview shows what a holder sees: phone, WhatsApp and link, not the hidden email.
  const face = html.match(/<div class="bcard">(.*?)<label for="cc-link-out"/s)[1]
  assert.match(face, /href="tel:\+14155550123"/); assert.match(face, /href="https:\/\/wa\.me\/14155550123"/); assert.match(face, /href="https:\/\/example\.test\/ada"/)
  assert.doesNotMatch(face, /ada@example\.test/)
  assert.match(html, /name="email"[^>]*value="ada@example\.test"/)
  // The public version and the scan sheet still show none of it.
  for (const path of ['/card', '/scan?tab=card', '/profile', '/settings']) assert.doesNotMatch(await (await signed.get(path)).text(), /4155550123|555-0123|ada@example\.test/, path)

  // Anyone with the link, signed in or not, sees the card. It is never indexed, cached or leaked by referrer.
  for (const signedIn of [false, true]) {
    const page = await signed.get(`/c/${token}`, signedIn)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
    const body = await page.text()
    assert.match(body, /<h1 class="bc-name">Card Owner<\/h1>/)
    assert.match(body, /href="tel:\+14155550123"[^>]*>.*?\+1 \(415\) 555-0123/s)
    assert.match(body, /href="https:\/\/wa\.me\/14155550123" target="_blank" rel="noopener noreferrer"/)
    assert.match(body, new RegExp(`href="/c/${token}/contact\\.vcf">Save contact`))
    assert.doesNotMatch(body, /ada@example\.test|mailto:|<svg[^>]*aria-label="QR code/)
    assert.equal(/Make your own card/.test(body), !signedIn)
  }
  const vcf = await signed.get(`/c/${token}/contact.vcf`, false)
  assert.equal(vcf.status, 200)
  assert.equal(vcf.headers.get('content-type'), 'text/vcard; charset=utf-8')
  assert.match(vcf.headers.get('content-disposition'), /^attachment; filename="contact\.vcf"$/)
  const vcard = await vcf.text()
  assert.match(vcard, /TEL;TYPE=CELL:\+14155550123\r\n/); assert.doesNotMatch(vcard, /EMAIL/)

  // Unknown or malformed tokens: not found, and nothing about any account.
  const unknown = await signed.get('/c/000000000000000000000000', false)
  assert.equal(unknown.status, 404)
  assert.match(await unknown.text(), /This card is not available/)
  assert.equal((await signed.get('/c/000000000000000000000000/contact.vcf', false)).status, 404)
  assert.equal((await signed.get(`/c/${token}x`, false)).status, 401)

  // The export has the details but not the link.
  const exported = await (await signed.get('/export')).json()
  assert.equal(exported.contactCard.phone, '+14155550123')
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(token))

  // Hide everything: the same link answers as not found, for the page and the contact file.
  assert.equal((await signed.post('/card/contact', { phone: '+14155550123', email: 'ada@example.test', link: 'https://example.test/ada' })).status, 303)
  assert.equal((await signed.get(`/c/${token}`, false)).status, 404)
  assert.equal((await signed.get(`/c/${token}/contact.vcf`, false)).status, 404)
  html = await (await signed.get('/card?share=contact')).text()
  assert.match(html, /Nothing is shared yet/)
  assert.match(html, /name="phone"[^>]*value="\+14155550123"/)
  assert.doesNotMatch(html, /name="showPhone" value="yes" checked/)

  // Show the email only, then reset the link: the old one is dead, the new one works.
  assert.equal((await signed.post('/card/contact', { phone: '+14155550123', email: 'ada@example.test', showEmail: 'yes' })).status, 303)
  let page = await (await signed.get(`/c/${token}`, false)).text()
  assert.match(page, /href="mailto:ada@example\.test"/); assert.doesNotMatch(page, /4155550123|wa\.me/)
  assert.equal((await signed.post('/card/contact/reset', { extra: 'x' })).status >= 400, true)
  response = await signed.post('/card/contact/reset', {})
  assert.equal(response.headers.get('location'), '/card?share=contact&done=reset')
  html = await (await signed.get('/card?share=contact&done=reset')).text()
  assert.match(html, /has a new link/)
  const next = html.match(/\/c\/([0-9A-Za-z]{24})"/)[1]
  assert.notEqual(next, token)
  assert.equal((await signed.get(`/c/${token}`, false)).status, 404)
  assert.equal((await signed.get(`/c/${next}`, false)).status, 200)

  // Deleting the account removes the card and its link.
  assert.equal((await signed.post('/delete-account', { confirm: 'delete everything' })).status, 200)
  assert.equal(fixture.store.records.size, 0)
  assert.equal((await signed.get(`/c/${next}`, false)).status, 404)
})

test('without a contact card store the card page has one version and the routes do not exist', async t => {
  const signed = await harness(t, { withCards: false }).start()
  const html = await (await signed.get('/card?share=contact')).text()
  assert.doesNotMatch(html, /aria-label="Card version"|class="card cc-form"/)
  assert.equal((await signed.get('/c/000000000000000000000000', false)).status, 401)
  assert.notEqual((await signed.post('/card/contact', { phone: '+14155550123' })).status, 303)
})
