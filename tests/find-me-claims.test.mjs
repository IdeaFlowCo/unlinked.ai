import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [
  { id: 'p-jl', name: 'Joshua Langsam', headline: 'Managing Director at Raptor Group', positions: [], education: [], skills: [] },
  { id: 'p-x', name: 'Lister One', positions: [], education: [], skills: [] },
  { id: 'dup-1', name: 'Casey Doe', positions: [], education: [], skills: [] },
  { id: 'dup-2', name: 'Casey Doe', positions: [], education: [], skills: [] },
], connections: [{ fromId: 'p-x', toId: 'p-jl' }] }

async function start(t, { displayName = 'Joshua Langsam', claimableIds = ['p-jl', 'dup-1', 'dup-2'], claimError = null } = {}) {
  const calls = { lookups: [], names: [], claims: [], audits: [] }
  let provisioned = false, handler
  const selfClaims = {
    lookupSlug: async slug => { calls.lookups.push(slug); return slug === 'joshua-langsam-1352407' ? 'p-jl' : null },
    // Mirrors the composition: names resolve against the legacy dataset only,
    // and an ambiguous name resolves to null.
    lookupName: async name => { calls.names.push(name); return name.trim() === 'Joshua Langsam' ? 'p-jl' : null },
    claimable: async profileId => claimableIds.includes(profileId),
    claim: async request => { if (claimError) throw new Error(claimError); calls.claims.push(request); return { profileId: request.profileId, receiptId: 'receipt-1' } },
  }
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({
    baseUrl: origin,
    login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a', clientId: 'client', verifiedAt: Date.now(), displayName }) },
    resolveOwner: async () => provisioned ? { ownerId: 'owner-a', userId: 'user-a' } : null,
    signup: async () => { provisioned = true; return { ownerId: 'owner-a', userId: 'user-a' } },
    issueAccountGrant: async () => ({ token: 'grant' }), revokeAccountGrant: async () => {},
    selfClaims,
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], readLegacyProfile: async () => null }),
    readPublishedSnapshot: async () => snapshot,
    complete: async () => ({ matches: [] }),
    audit: async event => { calls.audits.push(event) },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const begin = await request('/login')
  const loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
  assert.equal(callback.status, 303)
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const signed = (path, options = {}) => request(path, { ...options, headers: { Cookie: cookie, ...(options.headers ?? {}) } })
  const post = (path, fields) => signed(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams(fields) })
  const csrf = (await (await signed('/find-me')).text()).match(/name="csrf" value="([^"]+)"/)[1]
  return { calls, request, signed, post, csrf, callback }
}

test('a new account is offered the find-me step, a LinkedIn address finds the unclaimed profile and confirming claims it', async t => {
  const { signed, post, csrf, callback, calls } = await start(t)
  assert.equal(callback.headers.get('location'), '/find-me')
  const page = await signed('/find-me')
  assert.equal(page.status, 200)
  const content = await page.text()
  assert.ok(content.includes('Find yourself on Unlinked')); assert.ok(content.includes('Skip for now'))
  const found = await post('/find-me', { csrf, linkedinUrl: 'https://www.linkedin.com/in/joshua-langsam-1352407/' })
  assert.equal(found.status, 200)
  const card = await found.text()
  assert.ok(card.includes('Is this you?')); assert.ok(card.includes('Joshua Langsam')); assert.ok(card.includes('Managing Director at Raptor Group')); assert.ok(card.includes('Listed by 1 member'))
  assert.deepEqual(calls.lookups, ['joshua-langsam-1352407'])
  const candidate = card.match(/name="candidate" value="([^"]+)"/)[1]
  // The confirmation requires the displayed card's own binding token.
  assert.notEqual((await post('/claim-me', { csrf })).status, 303)
  assert.notEqual((await post('/claim-me', { csrf, candidate: 'stale-token' })).status, 303)
  assert.equal(calls.claims.length, 0)
  const claimed = await post('/claim-me', { csrf, candidate })
  assert.equal(claimed.status, 303); assert.equal(claimed.headers.get('location'), '/while-you-wait')
  assert.equal(calls.claims.length, 1)
  const request = calls.claims[0]
  assert.equal(request.profileId, 'p-jl'); assert.equal(request.evidence, 'self-asserted-linkedin-url-v1')
  assert.deepEqual(request.owner, { ownerId: 'owner-a', userId: 'user-a' })
  assert.match(request.emailHash, /^[a-f0-9]{64}$/)
  assert.equal(request.issuer, 'https://idp.invalid'); assert.equal(request.subject, 'subject-a')
  assert.ok(calls.audits.some(event => event.event === 'legacy_profile_self_claimed' && event.profileId === 'p-jl' && event.receiptId === 'receipt-1'))
  // The step is spent: a second confirm has no candidate and fails closed.
  assert.notEqual((await post('/claim-me', { csrf, candidate })).status, 303)
})

test('a newer lookup invalidates a stale card: the old token no longer claims, the new one does', async t => {
  const { post, csrf, calls } = await start(t)
  const first = await (await post('/find-me', { csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const stale = first.match(/name="candidate" value="([^"]+)"/)[1]
  const second = await (await post('/find-me', { csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const fresh = second.match(/name="candidate" value="([^"]+)"/)[1]
  assert.notEqual(stale, fresh)
  assert.notEqual((await post('/claim-me', { csrf, candidate: stale })).status, 303)
  assert.equal(calls.claims.length, 0)
  assert.equal((await post('/claim-me', { csrf, candidate: fresh })).status, 303)
  assert.equal(calls.claims.length, 1)
})

test('with no address the identity display name must match exactly one profile; ambiguity or an existing row shows none', async t => {
  const byName = await start(t)
  const found = await (await byName.post('/find-me', { csrf: byName.csrf, linkedinUrl: '' })).text()
  assert.ok(found.includes('Is this you?'))
  assert.deepEqual(byName.calls.names, ['Joshua Langsam'])
  await byName.post('/claim-me', { csrf: byName.csrf, candidate: found.match(/name="candidate" value="([^"]+)"/)[1] })
  assert.equal(byName.calls.claims[0].profileId, 'p-jl')
  assert.equal(byName.calls.claims[0].evidence, 'self-asserted-display-name-v1')

  const ambiguous = await start(t, { displayName: 'Casey Doe' })
  assert.ok(!(await (await ambiguous.post('/find-me', { csrf: ambiguous.csrf, linkedinUrl: '' })).text()).includes('Is this you?'))

  const taken = await start(t, { claimableIds: [] })
  assert.ok(!(await (await taken.post('/find-me', { csrf: taken.csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()).includes('Is this you?'))
})

test('claim races fail closed with a notice, and a wrong csrf or stray field never reaches the claim', async t => {
  const racing = await start(t, { claimError: 'self_claim_conflict' })
  const card = await (await racing.post('/find-me', { csrf: racing.csrf, linkedinUrl: 'joshua-langsam-1352407' })).text()
  const candidate = card.match(/name="candidate" value="([^"]+)"/)[1]
  const conflict = await racing.post('/claim-me', { csrf: racing.csrf, candidate })
  assert.equal(conflict.status, 200)
  assert.ok((await conflict.text()).includes('claimed'))
  assert.equal(racing.calls.claims.length, 0)
  for (const fields of [{ csrf: 'wrong', candidate }, { csrf: racing.csrf, candidate, extra: 'field' }, { csrf: racing.csrf }]) {
    assert.notEqual((await racing.post('/claim-me', fields)).status, 303)
  }
})
