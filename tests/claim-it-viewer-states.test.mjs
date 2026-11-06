import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

// "Is this you? Claim it" on an imported (shadow) profile must lead somewhere
// this viewer can actually claim (docs/internal-links.md#claim-it). Before
// 0.6.60 a signed-in viewer always got /find-me, which a restored session (any
// session after a runtime restart) and any account with a profile bounced to
// /profile with nothing claimed.
const LI = 'https://www.linkedin.com/in/casey-example'
const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [
  { id: 'legacy-row', name: 'Robin Legacy', positions: [], education: [], skills: [] },
  { id: 'public-copy', name: 'Casey Example', linkedinUrl: LI, positions: [], education: [], skills: [] },
  { id: 'public-other', name: 'Morgan Other', linkedinUrl: 'https://www.linkedin.com/in/morgan-other', positions: [], education: [], skills: [] },
  { id: 'member-me', name: 'Casey Example', linkedinUrl: LI, positions: [], education: [], skills: [] },
], connections: [], members: ['member-me'] }

async function start(t, { mine = null, sessionStore } = {}) {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const owner = { ownerId: 'owner-a', userId: 'user-a' }
  handler = createPrivateBrowserHandler({
    baseUrl: endpoint.replace('http:', 'https:'),
    login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a', clientId: 'client', verifiedAt: Date.now(), displayName: 'Viewer Example' }) },
    resolveOwner: async () => owner, signup: async () => owner,
    issueAccountGrant: async () => ({ token: 'grant' }), revokeAccountGrant: async () => {},
    selfClaims: { lookupSlug: async () => null, lookupName: async () => null, claimable: async id => id === 'legacy-row', claim: async () => ({ profileId: 'legacy-row', receiptId: 'r' }) },
    ownProfileId: async () => typeof mine === 'function' ? mine() : mine,
    ...(sessionStore ? { sessionStore } : {}),
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [], readLegacyProfile: async () => null }),
    readPublishedSnapshot: async () => snapshot,
    complete: async () => ({ matches: [] }),
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async (path = '/login') => {
    const begin = await request(path)
    const loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    assert.equal(callback.status, 303)
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))?.split(';')[0]
    return { cookie, location: callback.headers.get('location') }
  }
  return { request, signIn, endpoint }
}

const memoryStore = () => {
  const rows = new Map()
  return { put: async (hash, record) => { rows.set(hash, record) }, get: async (hash, now) => { const row = rows.get(hash); return row && row.expiresAt > now ? row : null }, delete: async hash => { rows.delete(hash) }, deleteOwner: async () => {}, prune: async () => {} }
}
const note = body => body.match(/<p class="small shadow-note">([\s\S]*?)<\/p>/)?.[1] ?? null
const claimHref = body => note(body)?.match(/<a href="([^"]+)"/)?.[1].replace(/&amp;/g, '&') ?? null

// Every internal link on the page answers with a page (200) or a sign-in wall (401).
async function assertLinksResolve(request, body, cookie) {
  const hrefs = [...new Set([...body.matchAll(/<a\b[^>]*?\shref="(\/[^"/][^"]*)"/g)].map(match => match[1].replace(/&amp;/g, '&')))]// This fixture runs without member invitations, so /invites (live in production) is not mounted.
    .filter(href => !/^\/(?:login|logout|auth|oauth|mcp|invites)\b/.test(href) && !href.endsWith('/photo'))
  for (const href of hrefs) {
    let response = await request(href, { headers: cookie ? { Cookie: cookie } : {} })
    for (let hop = 0; hop < 3 && [301, 302, 303].includes(response.status) && response.headers.get('location')?.startsWith('/') && !response.headers.get('location').startsWith('/login'); hop++) response = await request(response.headers.get('location'), { headers: cookie ? { Cookie: cookie } : {} })
    assert.ok([200, 401, 302, 303].includes(response.status) && response.status !== 404, `${href} answered ${response.status}`)
    assert.notEqual(response.status, 404, href); assert.notEqual(response.status, 400, href)
  }
}

test('signed out: Claim it goes to /join, which is a page', async t => {
  const { request } = await start(t)
  const body = await (await request('/people/legacy-row')).text()
  assert.equal(claimHref(body), '/join')
  assert.equal((await request('/join')).status, 200)
  await assertLinksResolve(request, body)
})

test('signed in, no profile, fresh session: a recovered legacy row links straight to a working /find-me', async t => {
  const { request, signIn } = await start(t)
  const { cookie } = await signIn()
  const body = await (await request('/people/legacy-row', { headers: { Cookie: cookie } })).text()
  assert.equal(claimHref(body), '/find-me')
  const page = await request('/find-me', { headers: { Cookie: cookie } })
  assert.equal(page.status, 200); assert.match(await page.text(), /Find yourself on Unlinked/)
  await assertLinksResolve(request, body, cookie)
})

test('signed in, no profile, restored session: Claim it signs in again and lands on /find-me instead of bouncing to /profile', async t => {
  const sessionStore = memoryStore()
  const first = await start(t, { sessionStore })
  const { cookie } = await first.signIn()
  // A runtime restart: the session comes back from the store without its claim identity.
  const { request, signIn } = await start(t, { sessionStore })
  const before = await request('/find-me', { headers: { Cookie: cookie } })
  assert.equal(before.status, 303); assert.equal(before.headers.get('location'), '/profile', 'the old /find-me link was a dead end for this session')
  const body = await (await request('/people/legacy-row', { headers: { Cookie: cookie } })).text()
  assert.equal(claimHref(body), '/login?next=%2Ffind-me')
  const again = await signIn(claimHref(body))
  assert.equal(again.location, '/find-me')
  const page = await request('/find-me', { headers: { Cookie: again.cookie } })
  assert.equal(page.status, 200); assert.match(await page.text(), /Find yourself on Unlinked/)
})

test('signed in, no profile: an imported copy, which only an export can verify, links to /import', async t => {
  const { request, signIn } = await start(t)
  const { cookie } = await signIn()
  const body = await (await request('/people/public-copy', { headers: { Cookie: cookie } })).text()
  assert.equal(claimHref(body), '/import'); assert.match(note(body), /Bring your LinkedIn export<\/a> to claim it/)
  assert.equal((await request('/import', { headers: { Cookie: cookie } })).status, 200)
  await assertLinksResolve(request, body, cookie)
})

test('signed in member with a profile: someone else\'s imported profile has no "Is this you?"', async t => {
  const { request, signIn } = await start(t, { mine: 'member-me' })
  const { cookie } = await signIn()
  for (const id of ['public-other', 'legacy-row']) {
    const body = await (await request(`/people/${id}`, { headers: { Cookie: cookie } })).text()
    assert.ok(note(body) !== null, 'the imported-profile note still renders')
    assert.doesNotMatch(note(body), /Is this you|Claim it|find-me/)
    await assertLinksResolve(request, body, cookie)
  }
})

test('signed in member with a profile: a copy carrying their own LinkedIn address links to /import to fold it in', async t => {
  const { request, signIn } = await start(t, { mine: 'member-me' })
  const { cookie } = await signIn()
  const body = await (await request('/people/public-copy', { headers: { Cookie: cookie } })).text()
  assert.equal(claimHref(body), '/import'); assert.match(note(body), /It has your LinkedIn address/)
})

test('when the viewer\'s own profile cannot be read, no claim prompt is shown', async t => {
  const { request, signIn } = await start(t, { mine: () => Promise.reject(new Error('down')) })
  const { cookie } = await signIn()
  const body = await (await request('/people/legacy-row', { headers: { Cookie: cookie } })).text()
  assert.doesNotMatch(note(body) ?? '', /Claim it/)
})
