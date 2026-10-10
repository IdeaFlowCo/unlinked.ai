import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { cachePublicPeopleReads } from '../src/utils/public-people/cached-store.mjs'
import { createMemberPublicIndex, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

test('signed-in profile to People navigation reuses public chunks with live authorization, photos and revocation', async t => {
  const id = '12345678-1234-1234-1234-123456789abc', importId = 'a'.repeat(64)
  const owner = { ownerId: 'navigation-owner', userId: 'navigation-user' }
  const person = (id, name) => ({ id, name, headline: 'Software engineer', positions: [], education: [], skills: [] })
  let revision = 'legacy-public-v1:' + 'b'.repeat(64), active = true, ownerActive = true
  let photo = null
  let chunkReads = 0, pointerReads = 0, ownerReads = 0
  const legacy = () => ({ state: 'published', complete: true, revision,
    profiles: [person(id, 'Ada Lovelace'), ...Array.from({ length: 7999 }, (_, i) => person(`person-${i}`, `Engineer ${String(i).padStart(4, '0')}`))], connections: [] })
  const imported = { state: 'published', complete: true, revision: 'member-public-v1:' + importId,
    profiles: [person('member-import-' + importId, 'Grace Hopper')], connections: [] }
  const store = cachePublicPeopleReads({ read: async dataset => {
    if (dataset === ENRICHMENT_DATASET) return null
    chunkReads++; await delay(120)
    return dataset === 'legacy' ? active ? legacy() : null : imported
  } }, async dataset => {
    pointerReads++
    return dataset === ENRICHMENT_DATASET || (dataset === 'legacy' && !active) ? null
      : { revision: dataset === 'legacy' ? revision : imported.revision, digest: dataset === 'legacy' ? revision : importId }
  })
  const backend = { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [],
    readResource: async () => { ownerReads++; return ownerActive ? { sourceOwnerId: owner.ownerId, sourceRevision: 1,
      payload: { id: importId, ownerId: owner.ownerId, consent: PUBLIC_UPLOAD_CONSENT } } : null } }
  const readPublishedSnapshot = createMemberPublicIndex({ readLegacy: () => store.read('legacy'),
    discover: async () => [{ id: importId, owner, revision: 1 }], getBackend: async () => backend, publicPeople: store })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }),
      finish: async () => ({ issuer: 'https://identity.invalid', subject: 'navigation', displayName: 'Navigation Member' }) },
    resolveOwner: async () => owner, signup: async () => owner, getBackend: async () => backend,
    issueAccountGrant: async () => ({ accessToken: 'synthetic-test-grant' }), revokeAccountGrant: async () => {},
    readPublishedSnapshot, profilePhotos: { refresh: async () => {}, read: async () => null, urlFor: key => key === id ? photo : null } })
  const transcript = []
  const request = async (path, cookie) => {
    const start = performance.now()
    const response = await fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
    const body = await response.text()
    transcript.push({ path, status: response.status, milliseconds: +(performance.now() - start).toFixed(2),
      cacheControl: response.headers.get('cache-control'), chunkReads, pointerReads, ownerReads })
    return { response, body }
  }
  const start = await request('/login')
  const loginCookie = start.response.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state', loginCookie)
  assert.equal(callback.response.status, 303)
  const session = callback.response.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const profile = await request(`/people/${id}`, session)
  assert.equal(profile.response.status, 200)
  assert.equal(profile.response.headers.get('cache-control'), 'private, no-cache')
  assert.match(profile.body, /Ada Lovelace/)
  assert.match(profile.body, /href="\/network"/)
  const heldReads = chunkReads, heldPointers = pointerReads, heldOwner = ownerReads
  const people = await request('/network', session)
  assert.equal(people.response.status, 200)
  assert.match(people.body, /Ada Lovelace/)
  assert.equal(people.response.headers.get('cache-control'), 'private, no-cache')
  assert.equal(chunkReads, heldReads)
  assert.ok(pointerReads > heldPointers)
  assert.ok(ownerReads > heldOwner)
  photo = `/people/${id}/photo?v=abcdef1234567890`
  const refreshed = await request(`/api/people/${id}`, session)
  assert.equal(JSON.parse(refreshed.body).profile.photo, photo)
  photo = null
  assert.equal(JSON.parse((await request(`/api/people/${id}`, session)).body).profile.photo, undefined)
  ownerActive = false
  const denied = await request('/api/people', session)
  assert.equal(denied.response.status, 503)
  assert.deepEqual(JSON.parse(denied.body), { error: 'public_people_unavailable' })
  const unavailable = await request('/network', session)
  assert.equal(unavailable.response.status, 200)
  assert.match(unavailable.body, /Searching everyone on Unlinked did not finish this time/)
  assert.match(unavailable.body, /Try again/)
  assert.doesNotMatch(unavailable.body, /Ada Lovelace/)
  ownerActive = true
  active = false
  const revoked = await request('/api/people', session)
  assert.equal(revoked.response.status, 503)
  active = true; revision = 'legacy-public-v1:' + 'c'.repeat(64)
  assert.equal((await request('/network', session)).response.status, 200)
  assert.ok(chunkReads > heldReads)
  if (process.env.UNLINKED_TEST_EVIDENCE_DIR) {
    const directory = process.env.UNLINKED_TEST_EVIDENCE_DIR
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'profile-navigation.html'), profile.body)
    await writeFile(join(directory, 'people-navigation.html'), people.body)
    await writeFile(join(directory, 'people-unavailable.html'), unavailable.body)
    await writeFile(join(directory, 'navigation-http.json'), JSON.stringify({
      environment: 'Local standalone HTTP handler, synthetic 8,001-person shared index; 120ms simulated full chunk reads. These are not production latency measurements.', transcript,
      photoRefresh: JSON.parse(refreshed.body), ownerRevoked: JSON.parse(denied.body), publicationRevoked: JSON.parse(revoked.body),
    }, null, 2))
  }
})

test('signed-in pages reuse one account network read per owner; a finished POST drops it and sign-out clears site data', async t => {
  const owner = { ownerId: 'cache-owner', userId: 'cache-user' }
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const legacy = { state: 'published', complete: true, revision: 'legacy-public-v1:' + 'b'.repeat(64), profiles: [person('12345678-1234-1234-1234-123456789abc', 'Ada Lovelace')], connections: [] }
  let importLists = 0
  const backend = { adapter: {}, listImportIds: async () => { importLists++; return [] }, listImportJobIds: async () => [], readResource: async () => null }
  const readPublishedSnapshot = createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => [], getBackend: async () => backend, publicPeople: { read: async () => null } })
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const make = options => createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }),
      finish: async () => ({ issuer: 'https://identity.invalid', subject: 'cache', displayName: 'Cache Member' }) },
    resolveOwner: async () => owner, signup: async () => owner, getBackend: async () => backend,
    issueAccountGrant: async () => ({ accessToken: 'synthetic-test-grant' }), revokeAccountGrant: async () => {},
    readPublishedSnapshot, ...options })
  handler = make({})
  const signIn = async () => {
    const start = await fetch(endpoint + '/login', { redirect: 'manual' })
    const loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await fetch(endpoint + '/auth/callback/ideaflow?code=test&state=state', { redirect: 'manual', headers: { Cookie: loginCookie } })
    assert.equal(callback.status, 303)
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  const session = await signIn()
  importLists = 0
  const first = await fetch(endpoint + '/network', { headers: { Cookie: session } })
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('cache-control'), 'private, no-cache')
  assert.equal(first.headers.get('vary'), 'Cookie')
  const second = await fetch(endpoint + '/network?q=ada', { headers: { Cookie: session } })
  assert.equal(second.status, 200)
  assert.equal(importLists, 1, 'the second page view reuses the owner network read')
  // APIs keep no-store and no browser cache eligibility.
  const api = await fetch(endpoint + '/api/people', { headers: { Cookie: session } })
  assert.equal(api.headers.get('cache-control'), 'no-store')
  // Any finished POST by the owner (even a rejected one) drops the kept read.
  const post = await fetch(endpoint + '/anything', { method: 'POST', headers: { Cookie: session } })
  assert.notEqual(post.status, 200)
  await new Promise(resolve => setTimeout(resolve, 20))
  await fetch(endpoint + '/network', { headers: { Cookie: session } })
  assert.equal(importLists, 2, 'a mutating POST invalidates the owner network read')
  // networkFreshMs 0 keeps next-request reads.
  handler = make({ networkFreshMs: 0 })
  const fresh = await signIn()
  importLists = 0
  await fetch(endpoint + '/network', { headers: { Cookie: fresh } })
  await fetch(endpoint + '/network', { headers: { Cookie: fresh } })
  assert.equal(importLists, 2)
  assert.throws(() => make({ networkFreshMs: -1 }), /explicit_private_browser_configuration_required/)
  // Sign-out evicts this origin's cached and back/forward pages.
  handler = make({})
  const leaving = await signIn()
  const body = await (await fetch(endpoint + '/network', { headers: { Cookie: leaving } })).text()
  const csrf = body.match(/name="csrf" value="([^"]+)"/)[1]
  const out = await fetch(endpoint + '/logout', { method: 'POST', redirect: 'manual',
    headers: { Cookie: leaving, Origin: endpoint.replace('http:', 'https:').replace(/\/$/, ''), 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(csrf)}` })
  assert.equal(out.status, 303)
  assert.equal(out.headers.get('clear-site-data'), '"cache"')
})

test('badge counts overlap route work and never hold a page; fast counts still land on the same view', async t => {
  const owner = { ownerId: 'alerts-owner', userId: 'alerts-user' }
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const legacy = { state: 'published', complete: true, revision: 'legacy-public-v1:' + 'b'.repeat(64), profiles: [person('12345678-1234-1234-1234-123456789abc', 'Ada Lovelace')], connections: [] }
  const backend = { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], readResource: async () => null }
  const readPublishedSnapshot = createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => [], getBackend: async () => backend, publicPeople: { read: async () => null } })
  let countsDelayMs = 600
  const notifications = { counts: async () => { await delay(countsDelayMs); return { unseen: 3 } },
    list: async () => [], markSeen: async () => {}, open: async () => null, markAllRead: async () => {}, removeOwner: async () => {}, notify: async () => true }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }),
      finish: async () => ({ issuer: 'https://identity.invalid', subject: 'alerts', displayName: 'Alerts Member' }) },
    resolveOwner: async () => owner, signup: async () => owner, getBackend: async () => backend,
    issueAccountGrant: async () => ({ accessToken: 'synthetic-test-grant' }), revokeAccountGrant: async () => {},
    readPublishedSnapshot, notifications })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' })
  const loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await fetch(endpoint + '/auth/callback/ideaflow?code=test&state=state', { redirect: 'manual', headers: { Cookie: loginCookie } })
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  // A slow counts read is left behind: the page ships without the badge.
  const begun = performance.now()
  const slow = await fetch(endpoint + '/network', { headers: { Cookie: session } })
  const slowMs = performance.now() - begun
  assert.equal(slow.status, 200)
  assert.ok(slowMs < 500, `page waited ${slowMs}ms for a 600ms counts read`)
  assert.doesNotMatch(await slow.text(), /Notifications, 3 new/)
  // Fast counts land on the same view, read live, with a timing stage.
  countsDelayMs = 0
  const fast = await fetch(endpoint + '/network', { headers: { Cookie: session } })
  assert.equal(fast.status, 200)
  assert.match(fast.headers.get('server-timing') ?? '', /alerts;dur=\d+/)
  assert.match(await fast.text(), /Notifications, 3 new/)
})
