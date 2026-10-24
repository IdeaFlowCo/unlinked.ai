// Member-published profile links (unlinked-8dm): tasteful LinkedIn / X /
// Substack / website links on public person pages, edited by the member on
// /profile and stored per account. Only safe HTTPS addresses render; contact
// card fields, email and phone never travel through this feature. All people
// here are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { classifySocialLink, normalizeSocialLinks, SOCIAL_LINK_LIMITS } from '../src/utils/public-people/profile-links.mjs'
import { createMemoryProfileLinkStore } from '../mcp-server/profile-social-links.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPerson, renderOwnProfile } from '../mcp-server/private-onboarding-views.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

test('one pasted address classifies by host, with only safe HTTPS surviving', () => {
  assert.deepEqual(classifySocialLink('https://x.com/jacob'), { kind: 'x', label: 'X', url: 'https://x.com/jacob' })
  assert.equal(classifySocialLink('twitter.com/jacob').kind, 'x', 'bare twitter.com gets https and reads as X')
  assert.equal(classifySocialLink('http://x.com/jacob').url, 'https://x.com/jacob', 'http upgrades to https')
  assert.deepEqual(classifySocialLink('https://jacob.substack.com'), { kind: 'substack', label: 'Substack', url: 'https://jacob.substack.com/' })
  assert.equal(classifySocialLink('https://github.com/tmad4000').label, 'GitHub')
  assert.equal(classifySocialLink('https://bsky.app/profile/jacob').label, 'Bluesky')
  // LinkedIn keeps the person grammar: /in/<slug> only, canonical www form.
  assert.deepEqual(classifySocialLink('linkedin.com/in/jacob-cole'), { kind: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/in/jacob-cole' })
  assert.equal(classifySocialLink('https://www.linkedin.com/company/ideaflow'), null, 'a company page is not a person link')
  assert.equal(classifySocialLink('https://de.linkedin.com/in/x?trk=123'), null, 'non-grammar linkedin never falls through to website')
  // Everything else is a website, labelled by host and path.
  assert.deepEqual(classifySocialLink('https://example.com'), { kind: 'website', label: 'example.com', url: 'https://example.com/' })
  assert.equal(classifySocialLink('https://www.example.com/writing').label, 'example.com/writing')
  assert.ok(classifySocialLink(`https://example.com/${'a'.repeat(60)}`).label.endsWith('…'), 'long labels are truncated')
  // Unsafe or malformed input never classifies.
  for (const bad of ['javascript:alert(1)', 'mailto:a@b.com', 'tel:+14155550123', 'ftp://example.com', 'https://user:pass@example.com', 'https://localhost/x', '', '   ', 42, null, 'https://' + 'a'.repeat(SOCIAL_LINK_LIMITS.maxLength) + '.com']) {
    assert.equal(classifySocialLink(bad), null, `rejects ${String(bad).slice(0, 40)}`)
  }
})

test('accepted social links remain valid after canonical encoding and overlong Unicode URLs are rejected up front', () => {
  assert.equal(classifySocialLink('https://example.com/' + 'é'.repeat(100)), null)
  const linkedinPrefix = 'https://www.linkedin.com/in/'
  const boundarySlug = 'a'.repeat(SOCIAL_LINK_LIMITS.maxLength - linkedinPrefix.length)
  assert.equal(classifySocialLink('https://linkedin.com/in/' + 'a'.repeat(274)), null)
  assert.equal(classifySocialLink('https://linkedin.com/in/' + boundarySlug + 'a'), null)
  for (const address of ['https://example.com/café', 'https://x.com/synthetic-person', 'synthetic.substack.com', 'linkedin.com/in/synthetic-person', 'https://linkedin.com/in/' + boundarySlug]) {
    const link = classifySocialLink(address)
    assert.ok(link)
    assert.ok(link.url.length <= SOCIAL_LINK_LIMITS.maxLength)
    assert.deepEqual(classifySocialLink(link.url), link)
  }
})

test('a member list deduplicates, reports bad lines and bounds the count', () => {
  const result = normalizeSocialLinks(['x.com/jacob', 'https://x.com/jacob', 'nope^', 'jacob.substack.com'])
  assert.deepEqual(result.links.map(link => link.kind), ['x', 'substack'])
  assert.deepEqual(result.problems, [2])
  assert.equal(result.overLimit, false)
  assert.equal(normalizeSocialLinks(Array.from({ length: SOCIAL_LINK_LIMITS.maxLinks + 1 }, (_, i) => `https://site-${i}.example.com`)).overLimit, true)
  assert.deepEqual(normalizeSocialLinks('not-an-array'), { links: [], problems: [], overLimit: false })
})

const owner = { ownerId: 'links-owner', userId: 'links-user' }

test('the store keeps one validated list per account and the graph migration knows its label', async () => {
  const store = createMemoryProfileLinkStore({ now: () => 1000 })
  assert.equal(await store.get(owner), null)
  const saved = await store.set(owner, { profileId: 'jacob-profile', links: ['x.com/jacob', 'jacob.substack.com'] })
  assert.deepEqual(saved.links.map(link => link.url), ['https://x.com/jacob', 'https://jacob.substack.com/'])
  assert.equal(await store.get({ ownerId: owner.ownerId, userId: 'someone-else' }), null, 'another user never reads the record')
  assert.deepEqual((await store.forProfile('jacob-profile')).map(link => link.label), ['X', 'Substack'])
  assert.equal(await store.forProfile('someone-else-profile'), null)
  await assert.rejects(store.set(owner, { profileId: 'jacob-profile', links: ['javascript:alert(1)'] }), /profile_links_invalid/)
  await assert.rejects(store.set({ ownerId: 'x' }, { profileId: 'p', links: [] }), /profile_links_owner_required/)
  // An unpublished member may save with no profile id; nothing renders publicly.
  await store.set(owner, { profileId: null, links: ['x.com/jacob'] })
  assert.equal((await store.get(owner)).profileId, null)
  // An empty list removes the record; removal also goes with the account.
  await store.set(owner, { profileId: 'jacob-profile', links: [] })
  assert.equal(await store.get(owner), null)
  await store.set(owner, { profileId: 'jacob-profile', links: ['x.com/jacob'] })
  await store.removeOwner(owner)
  assert.equal(await store.get(owner), null)
  assert.ok(LABELS.includes('UnlinkedProfileLinks'))
})

test('headers render member links compactly, escaped, deduplicated and re-validated', () => {
  const profile = { id: 'ada', name: 'Ada Lovelace', presence: 'member', positions: [], connections: [],
    linkedinUrl: 'https://www.linkedin.com/in/ada', website: 'https://ada.example.com/',
    socialLinks: [
      { kind: 'x', label: 'X', url: 'https://x.com/ada' },
      { kind: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/in/ada-other' }, // professional LinkedIn already shown
      { kind: 'website', label: 'ada.example.com', url: 'https://ada.example.com/' },        // duplicate of the website
      { kind: 'website', label: '<script>alert(1)</script>', url: 'javascript:alert(1)' },   // tampered row never renders
    ] }
  const page = renderPerson({ profile }).content
  assert.match(page, /class="small profile-links"/)
  // The professional LinkedIn address is the header's own button, not a line in the link row.
  assert.match(page, /<a class="button sec sm li-top" href="https:\/\/www\.linkedin\.com\/in\/ada" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn profile \(opens in a new tab\)"/)
  assert.doesNotMatch(page.match(/<p class="small profile-links">[\s\S]*?<\/p>/)[0], /linkedin\.com/)
  assert.match(page, /<a href="https:\/\/x\.com\/ada" target="_blank" rel="noopener noreferrer nofollow">X ↗<\/a>/)
  assert.doesNotMatch(page, /ada-other/, 'a second LinkedIn never renders beside the professional one')
  assert.equal(page.split('https://ada.example.com/').length, 2, 'the website renders once')
  assert.doesNotMatch(page, /javascript:alert/)
  assert.doesNotMatch(page, /<script>alert/)
})

test('the own-profile Links card previews saved links, edits per line and names the public boundary', () => {
  const socialLinks = { links: [{ kind: 'x', label: 'X', url: 'https://x.com/jacob' }], canPublish: true, notice: 'invalid', line: 2 }
  const page = renderOwnProfile({ accountLabel: 'a', displayName: 'Jacob', csrf: 'tok', socialLinks }).content
  assert.match(page, /id="public-links"/)
  assert.match(page, /action="\/profile\/links"/)
  assert.match(page, /<textarea id="profile-links-input"[^>]*>https:\/\/x\.com\/jacob<\/textarea>/)
  assert.match(page, /role="alert">That link could not be used\..*\(line 2\)/)
  assert.match(page, /belong on <a href="\/card">your contact card<\/a>/)
  // Signed out of the card entirely: no form without a session, and the
  // unpublished hint shows while there is no public profile yet.
  assert.doesNotMatch(renderOwnProfile({ displayName: 'J', socialLinks }).content, /profile\/links/)
  assert.match(renderOwnProfile({ accountLabel: 'a', displayName: 'J', csrf: 'tok', socialLinks: { links: [], canPublish: false } }).content, /once your profile is published/)
})

// Two members with public profiles on one handler, as docs/member-connections.md tests do.
async function site(t, { profileSocialLinks } = {}) {
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const snapshot = { state: 'published', complete: true, revision: 'links-fixture', profiles: [person('jacob-profile', 'Jacob Fictional'), person('ada-profile', 'Ada Fictional')], connections: [], members: ['jacob-profile', 'ada-profile'] }
  const owners = { 'jacob-subject': owner, 'ada-subject': { ownerId: 'ada-owner', userId: 'ada-user' } }
  const accounts = { 'jacob-profile': owner, 'ada-profile': owners['ada-subject'] }
  let next = 'jacob-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null, readLegacyProfile: async () => null }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', profileSocialLinks,
    accountForProfile: async id => accounts[id] ?? null,
    ownProfileId: async value => Object.keys(accounts).find(id => accounts[id].ownerId === value.ownerId && accounts[id].userId === value.userId) ?? null,
    readPublishedSnapshot: async () => snapshot,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: next, verifiedEmail: `${next}@example.invalid`, displayName: next }) },
    resolveOwner: async identity => owners[identity.subject], signup: async identity => owners[identity.subject], issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async () => backend })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async subject => {
    next = subject
    const begin = await request('/login')
    const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
    const csrf = (await (await request('/profile', { headers: { Cookie: cookie } })).text()).match(/name="csrf" value="([^"]+)"/)[1]
    return { cookie, csrf }
  }
  const get = async (path, member) => { const response = await request(path, member ? { headers: { Cookie: member.cookie } } : {}); return { status: response.status, location: response.headers.get('location'), text: await response.text() } }
  const post = (path, member, form) => request(path, { method: 'POST', headers: { Cookie: member.cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: member.csrf, ...form }) })
  return { request, signIn, get, post }
}

test('end to end: a member saves links on /profile and every visitor sees them on the public page', async t => {
  const store = createMemoryProfileLinkStore()
  const { request, signIn, get, post } = await site(t, { profileSocialLinks: store })
  const me = await signIn('jacob-subject')
  // The edit card is on /profile; saving needs the session's own CSRF token.
  const before = await get('/profile', me)
  assert.match(before.text, /id="public-links"/)
  assert.equal((await post('/profile/links', { ...me, csrf: 'wrong' }, { links: 'x.com/jacob' })).status, 400)
  const saved = await post('/profile/links', me, { links: 'x.com/jacob\njacob.substack.com\nhttps://example.com/writing' })
  assert.equal(saved.status, 303); assert.equal(saved.headers.get('location'), '/profile?links=saved#public-links')
  // The saved choice previews on /profile, in the header and the editor.
  const after = await get('/profile?links=saved', me)
  assert.match(after.text, /role="status">Saved\./)
  assert.match(after.text, /<textarea id="profile-links-input"[^>]*>https:\/\/x\.com\/jacob\nhttps:\/\/jacob\.substack\.com\/\nhttps:\/\/example\.com\/writing<\/textarea>/)
  // Signed out, the public page shows the compact row; the JSON detail API keeps its shape.
  const publicPage = await (await request('/people/jacob-profile')).text()
  assert.match(publicPage, /<a href="https:\/\/x\.com\/jacob" target="_blank" rel="noopener noreferrer nofollow">X ↗<\/a>/)
  assert.match(publicPage, /Substack ↗/); assert.match(publicPage, /example\.com\/writing ↗/)
  assert.doesNotMatch(JSON.stringify(JSON.parse(await (await request('/api/people/jacob-profile')).text())), /x\.com\/jacob/, 'the public JSON schema is unchanged')
  // Another member's page never shows them.
  assert.doesNotMatch((await get('/people/ada-profile', me)).text, /x\.com\/jacob/)
  // A bad line is named; the stored links stay as they were.
  const bad = await post('/profile/links', me, { links: 'x.com/jacob\nmailto:jacob@example.invalid' })
  assert.equal(bad.headers.get('location'), '/profile?links=invalid&line=2#public-links')
  assert.match((await get('/profile?links=invalid&line=2', me)).text, /role="alert">That link could not be used\..*\(line 2\)/)
  assert.deepEqual((await store.get(owner)).links.map(link => link.kind), ['x', 'substack', 'website'])
  const many = Array.from({ length: SOCIAL_LINK_LIMITS.maxLinks + 1 }, (_, i) => `https://site-${i}.example.com`).join('\n')
  assert.equal((await post('/profile/links', me, { links: many })).headers.get('location'), '/profile?links=limit#public-links')
  // An empty save removes the row everywhere.
  await post('/profile/links', me, { links: '' })
  assert.equal(await store.get(owner), null)
  assert.doesNotMatch(await (await request('/people/jacob-profile')).text(), /x\.com\/jacob/)
})

// Regression shape from 0.6.25: a store the composition creates must be
// forwarded by the pilot wrapper, or production silently loses the feature.
test('the isolated pilot forwards the profile link store to the browser', async t => {
  const { startPrivatePilot } = await import('../mcp-server/private-pilot.mjs')
  const { randomBytes } = await import('node:crypto')
  const { createServer: createNetServer } = await import('node:net')
  let port
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    const candidate = 7000 + Math.floor(Math.random() * 3000)
    if (await new Promise(resolve => { const probe = createNetServer().once('error', () => resolve(false)).listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true))) })) port = candidate
  }
  const store = createMemoryProfileLinkStore()
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], writeResource: async () => {} }
  let personLookups = 0
  const running = await startPrivatePilot({ baseUrl: `https://127.0.0.1:${port}`, port, host: '127.0.0.1', dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'links-subject', verifiedEmail: 'member@example.invalid' }) },
    resolveOwner: async () => owner, signup: async () => owner, accountGrantKey: randomBytes(32), getBackend: async () => backend,
    complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'lookup-pilot', profiles: [], connections: [] }),
    personLookup: { enabled: true, lookup: async () => { personLookups++; return { status: 'found', address: 'https://www.linkedin.com/in/synthetic-person', profile: { name: 'New Person', positions: [], education: [] } } }, removeOwner: async () => {} },
    ownProfileId: async () => 'jacob-profile', accountForProfile: async () => null, profileSocialLinks: store })
  t.after(() => running.stop())
  const go = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init })
  const start = await go('/login')
  const callback = await go('/auth/callback/ideaflow?state=synthetic-state&code=x', { headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await go('/profile', { headers: { Cookie: cookie } })).text()
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  const saved = await go('/profile/links', { method: 'POST', headers: { Cookie: cookie, Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, links: 'x.com/jacob' }) })
  assert.equal(saved.status, 303)
  assert.deepEqual((await store.get(owner)).links.map(link => link.url), ['https://x.com/jacob'])
  assert.equal((await store.get(owner)).profileId, 'jacob-profile')
  const found = await go('/people/lookup', { method: 'POST', headers: { Cookie: cookie, Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, linkedinUrl: 'https://www.linkedin.com/in/synthetic-person' }) })
  assert.equal(found.status, 200)
  assert.match(await found.text(), /New Person/)
  assert.equal(personLookups, 1)
})


test('profile rebinding rejects stale replacements and deletions even with identical timestamps', async () => {
  const store = createMemoryProfileLinkStore({ now: () => 1000 })
  const original = await store.set(owner, { profileId: 'old', links: ['x.com/original'] })
  await store.set(owner, { profileId: 'old', links: ['x.com/replacement'] })
  assert.equal(await store.rebind(owner, { profileId: 'new', observed: original }), null)
  assert.equal(await store.forProfile('new'), null)
  const current = await store.get(owner)
  assert.equal(await store.rebind({ ...owner, userId: 'other' }, { profileId: 'new', observed: current }), null)
  const rebound = await store.rebind(owner, { profileId: 'new', observed: current })
  assert.deepEqual(rebound.links, current.links)
  assert.equal(await store.forProfile('old'), null)
  assert.deepEqual(await store.forProfile('new'), current.links)
  await store.set(owner, { profileId: 'new', links: [] })
  assert.equal(await store.rebind(owner, { profileId: 'resurrected', observed: rebound }), null)
  assert.equal(await store.get(owner), null)
  await store.set(owner, { profileId: 'new', links: ['x.com/replacement'] })
  assert.equal(await store.rebind(owner, { profileId: 'resurrected', observed: rebound }), null)
})
