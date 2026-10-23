// Member handles (unlinked-qpud, docs/profile-handles.md): readable
// /people/<handle> addresses for members, defaulting to the LinkedIn vanity
// slug already on their public profile, else their name. Ids and earlier
// handles redirect to the current handle; imported (shadow) profiles keep ids.
// All people here are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { handleCandidates, nameHandleBase, profilePath, setProfileHandleLookup, validateHandle } from '../src/utils/public-people/profile-handles.mjs'
import { createMemoryProfileHandleStore, createNeo4jProfileHandleStore, createProfileHandles } from '../mcp-server/profile-handles.mjs'
import { createPrivateBrowserHandler, notificationTargetFor } from '../mcp-server/private-browser.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const SIGNUP_ID = 'member-signup-' + 'f'.repeat(64)

test('handle grammar: lowercase a-z0-9 and single hyphens, bounded, never reserved or id-shaped', () => {
  assert.deepEqual(validateHandle('Ada-Lovelace'), { handle: 'ada-lovelace' })
  assert.deepEqual(validateHandle('@adal'), { handle: 'adal' })
  assert.equal(validateHandle('ab').code, 'length')
  assert.equal(validateHandle('a'.repeat(61)).code, 'length')
  for (const bad of ['-ada', 'ada-', 'a--b', 'ada lovelace', 'ada_l', 'adà', 'ada.l', 'ada/l']) assert.equal(validateHandle(bad).code, 'invalid', bad)
  for (const reserved of ['add', 'lookup', 'settings', 'admin', 'unlinked', 'support', 'people']) assert.equal(validateHandle(reserved).code, 'reserved', reserved)
  // Anything shaped like an internal id stays an id.
  for (const idLike of ['member-signup-abc', 'member-import-abc', 'public-abc', '0f8845b4-7def-487a-a404-c67e6aa811b8', 'e'.repeat(40)]) assert.equal(validateHandle(idLike).code, 'reserved', idLike)
  assert.equal(validateHandle(SIGNUP_ID).handle, undefined)
})

test('default candidates: the LinkedIn vanity slug, then the name, then the name numbered', () => {
  assert.equal(nameHandleBase('Zoë O’Brien-Smith'), 'zoe-obrien-smith')
  assert.equal(nameHandleBase('张伟'), 'someone')
  const candidates = handleCandidates({ name: 'Peter Fictional', linkedinUrl: 'https://www.linkedin.com/in/PeterFictional300' })
  assert.deepEqual(candidates.slice(0, 3), ['peterfictional300', 'peter-fictional', 'peter-fictional-2'])
  // A slug the grammar cannot carry is skipped, not mangled.
  assert.equal(handleCandidates({ name: 'Ann Fictional', linkedinUrl: 'https://www.linkedin.com/in/ann%C3%A9e' })[0], 'ann-fictional')
  assert.equal(handleCandidates({ name: 'Al' })[0], 'al-2', 'a too-short name gets a number')
})

test('registry: assigns once, dedupes collisions, renames with history and refuses takeovers', async () => {
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore(), perProfile: 3 })
  await handles.initialize()
  assert.equal(await handles.ensure({ id: 'p1', name: 'Peter Fictional' }), 'peter-fictional')
  assert.equal(await handles.ensure({ id: 'p2', name: 'Peter Fictional' }), 'peter-fictional-2')
  assert.equal(await handles.ensure({ id: 'p1', name: 'Someone Else' }), 'peter-fictional', 'a profile keeps the handle it was given')
  assert.equal(await handles.ensure({ id: 'p3', name: 'Peter Fictional', linkedinUrl: 'https://www.linkedin.com/in/peter-fictional' }), 'peter-fictional-3', 'a taken slug falls back')
  assert.deepEqual(handles.resolve('PETER-FICTIONAL-2'), { profileId: 'p2', handle: 'peter-fictional-2' })
  assert.equal(handles.resolve('nobody-here'), null)
  // Rename keeps the old handle pointing at the same profile.
  assert.deepEqual(await handles.rename('p1', 'Pete'), { handle: 'pete' })
  assert.deepEqual(handles.resolve('peter-fictional'), { profileId: 'p1', handle: 'pete' })
  assert.equal(handles.handleFor('p1'), 'pete')
  assert.equal((await handles.rename('p2', 'pete')).code, 'taken')
  assert.equal((await handles.rename('p2', 'peter-fictional')).code, 'taken', 'an earlier handle stays with its profile')
  assert.equal((await handles.rename('p2', 'settings')).code, 'reserved')
  assert.equal((await handles.rename('p2', 'x')).code, 'length')
  assert.equal(handles.availability('pete', 'p2').code, 'taken')
  assert.equal(handles.availability('pete', 'p1').available, true)
  // Switching back to an earlier handle is always allowed; new ones are capped.
  assert.deepEqual(await handles.rename('p1', 'peter-fictional'), { handle: 'peter-fictional' })
  assert.deepEqual(await handles.rename('p1', 'pf-three'), { handle: 'pf-three' })
  assert.equal((await handles.rename('p1', 'pf-four')).code, 'limit')
  assert.deepEqual(await handles.rename('p1', 'pete'), { handle: 'pete' })
  // Removing the account releases every handle it held.
  await handles.removeProfile('p1')
  assert.equal(handles.resolve('pete'), null)
  assert.equal(handles.handleFor('p1'), null)
  assert.ok(LABELS.includes('UnlinkedProfileHandle') && LABELS.includes('UnlinkedHandleProfile'), 'handles are part of graph recovery snapshots')
})

test('emitted links prefer the handle once the lookup is registered', () => {
  setProfileHandleLookup(id => id === SIGNUP_ID ? 'peterfictional300' : null)
  try {
    assert.equal(profilePath(SIGNUP_ID), '/people/peterfictional300')
    assert.equal(profilePath('public-abc'), '/people/public-abc')
    assert.equal(notificationTargetFor({ kind: 'profile_claimed', actorProfileId: SIGNUP_ID }), '/people/peterfictional300')
  } finally { setProfileHandleLookup(null) }
  assert.equal(profilePath(SIGNUP_ID), `/people/${SIGNUP_ID}`)
})

const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const peterOwner = { ownerId: 'peter-owner', userId: 'peter-user' }

async function site(t, { handles = createProfileHandles({ store: createMemoryProfileHandleStore() }) } = {}) {
  await handles.initialize()
  const state = {
    snapshot: { state: 'published', complete: true, revision: 'handles-1', connections: [{ fromId: SIGNUP_ID, toId: 'public-shadow' }, { fromId: SIGNUP_ID, toId: 'twin-a' }],
      profiles: [person(SIGNUP_ID, 'Peter Fictional', { linkedinUrl: 'https://www.linkedin.com/in/peterfictional300' }), person('twin-a', 'Ada Fictional'), person('twin-b', 'Ada Fictional'), person('public-shadow', 'Shadow Fictional', { linkedinUrl: 'https://www.linkedin.com/in/shadow-fictional' })],
      members: [SIGNUP_ID, 'twin-a', 'twin-b'] },
  }
  const owners = { 'peter-subject': peterOwner, 'ada-subject': { ownerId: 'ada-owner', userId: 'ada-user' } }
  const accounts = { [SIGNUP_ID]: peterOwner, 'twin-a': owners['ada-subject'] }
  let next = 'peter-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => setProfileHandleLookup(null))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null, readLegacyProfile: async () => null }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', profileHandles: handles, handleBackfillMs: 0,
    accountForProfile: async id => accounts[id] ?? null,
    ownProfileId: async value => Object.keys(accounts).find(id => accounts[id].ownerId === value.ownerId && accounts[id].userId === value.userId) ?? null,
    // A fresh revision per read, so a changed snapshot is never served from a compiled cache.
    readPublishedSnapshot: async () => state.snapshot,
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
  return { handler, handles, state, request, signIn, get, post }
}

test('end to end: the old hash address redirects to the LinkedIn handle, which serves the page', async t => {
  const { get, handles, handler } = await site(t)
  await handler.backfillHandles()
  const old = await get(`/people/${SIGNUP_ID}`)
  assert.equal(old.status, 301)
  assert.equal(old.location, '/people/peterfictional300')
  const page = await get('/people/peterfictional300')
  assert.equal(page.status, 200)
  assert.match(page.text, /Peter Fictional/)
  // Case, subpages and query strings carry over.
  assert.equal((await get('/people/PeterFictional300')).location, '/people/peterfictional300')
  assert.equal((await get(`/people/${SIGNUP_ID}/connections?sort=name`)).location, '/people/peterfictional300/connections?sort=name')
  assert.equal((await get('/people/peterfictional300/connections')).status, 200)
  // The profile's own links, and its connections' links, use handles.
  assert.match(page.text, /href="\/people\/peterfictional300\/connections/)
  assert.match(page.text, /href="\/people\/ada-fictional"/)
  assert.doesNotMatch(page.text, new RegExp(`href="/people/${SIGNUP_ID}"`))
  // The JSON detail accepts the handle and names it; ids keep answering without a redirect.
  const detail = JSON.parse((await get('/api/people/peterfictional300')).text)
  assert.equal(detail.profile.id, SIGNUP_ID); assert.equal(detail.profile.handle, 'peterfictional300')
  assert.equal((await get(`/api/people/${SIGNUP_ID}`)).status, 200)
  assert.equal(JSON.parse((await get('/api/people/peterfictional300/card')).text).card.handle, 'peterfictional300')
  assert.equal(handles.handleFor(SIGNUP_ID), 'peterfictional300')
})

test('collisions number by name, and imported profiles never get a handle', async t => {
  const { get, handles } = await site(t)
  assert.equal((await get('/people/twin-a')).location, '/people/ada-fictional')
  assert.equal((await get('/people/twin-b')).location, '/people/ada-fictional-2')
  const shadow = await get('/people/public-shadow')
  assert.equal(shadow.status, 200, 'an imported profile keeps its id address')
  assert.equal(handles.handleFor('public-shadow'), null)
  assert.equal((await get('/people/shadow-fictional')).status, 404, "a shadow's LinkedIn slug is not an address")
})

test('backfill gives every listed member a handle, LinkedIn slugs first', async t => {
  const { handler, handles } = await site(t)
  assert.equal(await handler.backfillHandles(), 3)
  assert.equal(handles.handleFor(SIGNUP_ID), 'peterfictional300')
  assert.deepEqual([handles.handleFor('twin-a'), handles.handleFor('twin-b')].sort(), ['ada-fictional', 'ada-fictional-2'])
  assert.equal(await handler.backfillHandles(), 0, 'already assigned handles are left alone')
})

test('a member changes their handle on /profile; every earlier address follows', async t => {
  const { signIn, get, post, request, handler } = await site(t)
  await handler.backfillHandles()
  const peter = await signIn('peter-subject')
  const profile = await get('/profile', peter)
  assert.match(profile.text, /id="profile-handle"/)
  assert.match(profile.text, /<input id="profile-handle-input" name="handle" value="peterfictional300"/)
  // Availability as you type, for the signed-in member only.
  assert.deepEqual(JSON.parse((await get('/profile/handle/check?handle=ada-fictional', peter)).text), { available: false, code: 'taken' })
  assert.deepEqual(JSON.parse((await get('/profile/handle/check?handle=peter-f', peter)).text), { available: true, handle: 'peter-f', current: false })
  assert.deepEqual(JSON.parse((await get('/profile/handle/check?handle=PeterFictional300', peter)).text), { available: true, handle: 'peterfictional300', current: true })
  assert.notEqual((await request('/profile/handle/check?handle=peter-f')).status, 200, 'signed out, there is nothing to check')
  // Saving needs the session's CSRF token.
  assert.equal((await post('/profile/handle', { ...peter, csrf: 'wrong' }, { handle: 'peter-f' })).status, 400)
  const saved = await post('/profile/handle', peter, { handle: 'Peter-F' })
  assert.equal(saved.status, 303); assert.equal(saved.headers.get('location'), '/profile?handle=saved#profile-handle')
  assert.match((await get('/profile?handle=saved', peter)).text, /role="status">Saved\. Your profile address is updated/)
  assert.equal((await get('/people/peterfictional300')).location, '/people/peter-f')
  assert.equal((await get(`/people/${SIGNUP_ID}`)).location, '/people/peter-f')
  assert.equal((await get('/people/peter-f')).status, 200)
  // Refusals are named and change nothing.
  assert.equal((await post('/profile/handle', peter, { handle: 'ada-fictional' })).headers.get('location'), '/profile?handle=taken#profile-handle')
  assert.equal((await post('/profile/handle', peter, { handle: 'settings' })).headers.get('location'), '/profile?handle=reserved#profile-handle')
  assert.equal((await post('/profile/handle', peter, { handle: 'bad handle' })).headers.get('location'), '/profile?handle=invalid#profile-handle')
  assert.match((await get('/profile?handle=taken', peter)).text, /role="alert">That handle is taken/)
  assert.equal((await get('/people/peter-f')).status, 200)
  // Another member cannot take an earlier handle of Peter's.
  const ada = await signIn('ada-subject')
  assert.equal((await post('/profile/handle', ada, { handle: 'peterfictional300' })).headers.get('location'), '/profile?handle=taken#profile-handle')
})

test('suspension and loss of membership hide the page at every address', async t => {
  const { get, state, handler } = await site(t)
  await handler.backfillHandles()
  assert.equal((await get('/people/peterfictional300')).status, 200)
  // A suspended profile leaves the published index (docs/profile-suspension).
  state.snapshot = { ...state.snapshot, revision: 'handles-2', profiles: state.snapshot.profiles.filter(value => value.id !== SIGNUP_ID), connections: [], members: ['twin-a', 'twin-b'] }
  assert.equal((await get('/people/peterfictional300')).status, 404)
  assert.equal((await get(`/people/${SIGNUP_ID}`)).status, 404)
  assert.equal((await get('/api/people/peterfictional300')).status, 404)
  // A handle never opens a profile that is no longer a member's.
  state.snapshot = { ...state.snapshot, revision: 'handles-3', members: ['twin-b'] }
  assert.equal((await get('/people/ada-fictional')).status, 404)
  assert.equal((await get('/people/twin-a')).status, 200, 'its id still names the imported page')
})

test('agent tools accept a handle and return it with the public address', async () => {
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await handles.initialize()
  await handles.ensure({ id: SIGNUP_ID, name: 'Peter Fictional', linkedinUrl: 'https://www.linkedin.com/in/peterfictional300' })
  await handles.ensure({ id: 'public-shadow', name: 'Shadow Fictional' })
  const snapshot = { state: 'published', complete: true, revision: 'tools-1', connections: [], profiles: [person(SIGNUP_ID, 'Peter Fictional'), person('public-shadow', 'Shadow Fictional')], members: [SIGNUP_ID] }
  const service = createAccountToolService({ getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot, profileHandles: handles })
  const grant = { ownerId: 'o', userId: 'u', grantId: 'x'.repeat(64), scope: 'owner_network_and_public', version: 2, tools: ['unlinked_get_profile', 'unlinked_list_people'] }
  const call = async (name, input) => (await service.call({ grant, name, input })).result
  const byHandle = await call('unlinked_get_profile', { id: 'peterfictional300' })
  assert.equal(byHandle.profile.id, SIGNUP_ID)
  assert.equal(byHandle.profile.handle, 'peterfictional300')
  assert.equal(byHandle.profile.url, 'https://www.unlinked.ai/people/peterfictional300')
  assert.equal((await call('unlinked_get_profile', { id: SIGNUP_ID })).profile.handle, 'peterfictional300')
  await assert.rejects(call('unlinked_get_profile', { id: 'shadow-fictional' }), error => error.code === 'not_found', 'a handle never names a non-member profile')
  const listed = await call('unlinked_list_people', {})
  assert.equal(listed.profiles.find(value => value.id === SIGNUP_ID).handle, 'peterfictional300')
  assert.equal(listed.profiles.find(value => value.id === 'public-shadow').handle, undefined)
})

// Regression shape from 0.6.25: a store the composition creates must be
// forwarded by the pilot wrapper, or production silently loses the feature.
test('the isolated pilot forwards the handle registry to the browser', async t => {
  const { startPrivatePilot } = await import('../mcp-server/private-pilot.mjs')
  const { randomBytes } = await import('node:crypto')
  const { createServer: createNetServer } = await import('node:net')
  let port
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    const candidate = 7000 + Math.floor(Math.random() * 3000)
    if (await new Promise(resolve => { const probe = createNetServer().once('error', () => resolve(false)).listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true))) })) port = candidate
  }
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await handles.initialize()
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], writeResource: async () => {} }
  const running = await startPrivatePilot({ baseUrl: `https://127.0.0.1:${port}`, port, host: '127.0.0.1', dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }), finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 's', verifiedEmail: 'member@example.invalid' }) },
    resolveOwner: async () => peterOwner, signup: async () => peterOwner, accountGrantKey: randomBytes(32), getBackend: async () => backend,
    complete: async () => ({ matches: [] }), readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'pilot-handles', profiles: [person(SIGNUP_ID, 'Peter Fictional', { linkedinUrl: 'https://www.linkedin.com/in/peterfictional300' })], connections: [], members: [SIGNUP_ID] }),
    ownProfileId: async () => SIGNUP_ID, accountForProfile: async () => peterOwner, profileHandles: handles })
  t.after(() => { running.stop(); setProfileHandleLookup(null) })
  const response = await fetch(`http://127.0.0.1:${port}/people/${SIGNUP_ID}`, { redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), '/people/peterfictional300')
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const neo4jEnabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('durable handles: unique across profiles, history kept, concurrent assignment settles on one', { skip: !neo4jEnabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const tag = randomUUID().slice(0, 8), ids = [`handles-a-${tag}`, `handles-b-${tag}`]
  t.after(async () => {
    const session = driver.session()
    try { await session.run('MATCH (n) WHERE (n:UnlinkedProfileHandle OR n:UnlinkedHandleProfile) AND n.profileId IN $ids DETACH DELETE n', { ids }) } finally { await session.close() }
    await driver.close()
  })
  const handles = createProfileHandles({ store: createNeo4jProfileHandleStore(driver), perProfile: 3 })
  await handles.initialize()
  const name = `Neo Fictional ${tag}`
  const [first, second] = await Promise.all(ids.map(id => handles.ensure({ id, name })))
  assert.notEqual(first, second)
  assert.deepEqual([first, second].sort(), [nameHandleBase(name), `${nameHandleBase(name)}-2`].sort())
  assert.deepEqual(await handles.rename(ids[0], `neo-${tag}`), { handle: `neo-${tag}` })
  assert.equal((await handles.rename(ids[1], first)).code, 'taken')
  // A second registry (another process) sees the same state after reload.
  const other = createProfileHandles({ store: createNeo4jProfileHandleStore(driver) })
  await other.initialize()
  assert.equal(other.handleFor(ids[0]), `neo-${tag}`)
  assert.deepEqual(other.resolve(first), { profileId: ids[0], handle: `neo-${tag}` })
  await handles.removeProfile(ids[0])
  await other.reload()
  assert.equal(other.resolve(first), null)
})
