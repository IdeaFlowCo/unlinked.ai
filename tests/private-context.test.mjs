import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createOverlayClient, createPrivateContext, OverlayUnavailable, OVERLAY_AUDIENCE, provenanceLabel, signOverlayAssertion, PRIVATE_CONTEXT_SCRIPT } from '../mcp-server/private-context.mjs'
import { privateOverlay } from '../mcp-server/private-composition.mjs'

const { jwtVerify } = await import(createRequire(new URL('../mcp-server/package.json', import.meta.url)).resolve('jose'))

// unlinked-9kk.4: Unlinked reads the owner's private context (notes,
// relations, importance, catch-up) from the Ideaflow people overlay in Noos.
// Fictional people only. The secret note text below must never appear
// anywhere except the owner's own private-context answers and export.
const sha = value => createHash('sha256').update(value).digest('hex')
const SECRET = 'x'.repeat(40)
const NOTE = 'Synthetic secret note: prefers async voice memos'
const ISSUER = 'https://id.test.invalid/api/auth'
const owner = { ownerId: '11111111-1111-4111-8111-111111111111', userId: 'synthetic-owner-user' }
const stranger = { ownerId: '22222222-2222-4222-8222-222222222222', userId: 'synthetic-stranger-user' }
const identities = new Map([[owner.ownerId, { issuer: ISSUER, subject: 'owner-subject' }], [stranger.ownerId, { issuer: ISSUER, subject: 'stranger-subject' }]])
const row = (first, last, url) => ({ id: sha(`${first} ${last}`), ownerId: owner.ownerId, importId: sha('legacy-storage'), sourceId: sha('raw'), rowId: `Connections.csv#record=${first}`, category: 'connections',
  fields: { 'first name': first, 'last name': last, url, company: 'Synthetic Co', position: 'Engineer' }, provenance: { source: 'recovered-legacy-storage-v1' } })
const ada = row('Ada', 'Synthetic', 'https://www.linkedin.com/in/synthetic-ada')
const bo = row('Bo', 'Private', 'https://www.linkedin.com/in/synthetic-bo')
const adaHash = sha('synthetic-ada'), boHash = sha('synthetic-bo')
const profile = (id, name) => ({ id, name, headline: 'Public headline', positions: [], education: [], skills: [] })
const snapshot = async () => ({ state: 'published', complete: true, revision: 'context-fixture-v1', connections: [], profiles: [profile('pub-ada', 'Ada Synthetic'), profile('pub-cy', 'Cy Published')] })
const slugs = new Map([['synthetic-ada', 'pub-ada']])
const backendFor = who => {
  const mine = who.ownerId === owner.ownerId
  return { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [],
    readLegacyFiles: async () => (mine ? { objects: [] } : null),
    readLegacyProfile: async () => (mine ? { profileId: 'pub-cy', receiptId: 'r1', revision: 'context-fixture-v1', sourceSha256: sha('legacy'), profiles: [], connections: [] } : null), readLegacyObservations: async () => (mine ? { assertions: [ada, bo] } : null) }
}

// A stand-in for Noos /api/overlay: entities per owner key, looked up by ref.
function fakeOverlay() {
  const data = new Map([['owner-subject', [
    { id: 'ent-ada', kind: 'person', name: 'Ada Synthetic', refs: ['unlinked:person:pub-ada', `linkedin:in:${adaHash}`], card: { important: true, cadenceDays: 30, lastContactAt: '2026-09-01T00:00:00.000Z', nextDueAt: '2026-10-01T00:00:00.000Z' },
      notes: [{ id: 'n1', text: NOTE, createdAt: '2026-10-09T10:00:00.000Z', author: 'agent:Claude', source: 'connector', assertion: 'stated' }, { id: 'n2', text: 'Older note', createdAt: '2026-09-01T00:00:00.000Z', author: null, source: null, assertion: null }],
      links: [{ id: 'l1', relation: 'knows', relationType: 'knows', direction: 'out', other: { id: 'ent-bo', kind: 'person', name: 'Bo Private', refs: [`linkedin:in:${boHash}`] }, author: 'owner', source: 'app', assertion: 'stated' },
        { id: 'l2', relation: 'sister of', relationType: 'family', direction: 'in', other: { id: 'ent-cy', kind: 'person', name: 'Cy Published', refs: ['unlinked:person:pub-cy'] }, author: 'agent:ChatGPT', source: 'direct-key', assertion: 'inferred' },
        { id: 'l3', relation: 'works on', relationType: 'works_on', direction: 'out', other: { id: 'ent-p', kind: 'project', name: 'Common Ground', refs: [] }, author: 'owner', source: 'app', assertion: 'stated' }] },
    { id: 'ent-bo', kind: 'person', name: 'Bo Private', refs: [`linkedin:in:${boHash}`], card: { important: false }, notes: [{ id: 'n3', text: 'Bo note', createdAt: '2026-10-09T10:00:00.000Z', author: 'owner', source: 'app', assertion: 'stated' }], links: [] },
  ]]])
  const calls = []
  return {
    calls,
    async lookup(identity, ref) { calls.push(['lookup', identity.subject, ref]); return (data.get(identity.subject) ?? []).find(entity => entity.refs.includes(ref)) ?? null },
    async neighbourhood(identity, id, depth) {
      calls.push(['neighbourhood', identity.subject, id, depth])
      const center = (data.get(identity.subject) ?? []).find(entity => entity.id === id)
      return center ? { center, depth, truncated: false, entities: [{ id: 'ent-bo', kind: 'person', name: 'Bo Private', refs: [`linkedin:in:${boHash}`] }], links: [{ id: 'l1', fromId: 'ent-ada', toId: 'ent-bo', relation: 'knows', relationType: 'knows', author: 'owner', source: 'app' }] } : null
    },
    async exportOwner(identity) { return { entities: (data.get(identity.subject) ?? []).map(({ id, name }) => ({ id, name })), notes: (data.get(identity.subject) ?? []).flatMap(entity => entity.notes), links: [] } },
  }
}

const service = createAccountToolService({ getBackend: async who => backendFor(who), readPublishedSnapshot: snapshot, lookupSlug: slug => slugs.get(slug) ?? null })
const lookupContact = async (who, input) => (await service.call({ grant: { ...who, scope: 'owner', tools: ['unlinked_lookup_contact'] }, name: 'unlinked_lookup_contact', input })).result

test('the overlay assertion carries exactly the claims Noos verifies', async () => {
  const token = await signOverlayAssertion('unlinked', SECRET, { issuer: ISSUER, subject: 'owner-subject' })
  const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET), { issuer: 'unlinked', audience: OVERLAY_AUDIENCE, algorithms: ['HS256'] })
  assert.equal(protectedHeader.alg, 'HS256')
  assert.deepEqual([payload.purpose, payload.sub, payload.owner_iss], ['owner', 'owner-subject', ISSUER])
  assert.ok(Number.isSafeInteger(payload.iat) && payload.exp - payload.iat === 60)
  await assert.rejects(jwtVerify(token, new TextEncoder().encode('y'.repeat(40)), { issuer: 'unlinked', audience: OVERLAY_AUDIENCE }))
})

test('the HTTP client asks Noos with a bearer assertion; 404 is nothing, other failures never echo a body', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    if (String(url).endsWith('/lookup')) return JSON.parse(init.body).ref === 'unlinked:person:missing' ? new Response('{"error":"not_found"}', { status: 404 }) : Response.json({ entity: { id: 'e1' } })
    return new Response(`{"error":"x","leak":"${NOTE}"}`, { status: 500 })
  }
  const client = createOverlayClient({ baseUrl: 'http://noos_api:4000/api/overlay', secret: SECRET, fetchImpl })
  const who = { issuer: ISSUER, subject: 'owner-subject' }
  assert.deepEqual(await client.lookup(who, 'unlinked:person:pub-ada'), { id: 'e1' })
  assert.equal(seen[0].url, 'http://noos_api:4000/api/overlay/lookup'); assert.equal(seen[0].init.method, 'POST')
  assert.match(seen[0].init.headers.Authorization, /^Bearer [A-Za-z0-9._-]+$/)
  assert.equal(await client.lookup(who, 'unlinked:person:missing'), null)
  await assert.rejects(client.exportOwner(who), error => error instanceof OverlayUnavailable && !error.message.includes(NOTE))
  assert.equal(seen.at(-1).url, 'http://noos_api:4000/api/overlay/export')
  await assert.rejects(client.lookup(null, 'unlinked:person:pub-ada'), OverlayUnavailable)
  assert.equal(await client.neighbourhood(who, '../owner'), null)
  assert.throws(() => createOverlayClient({ baseUrl: 'http://noos_api:4000/api/overlay', secret: 'short', fetchImpl }), /overlay_secret_required/)
})

test('composition turns private context on only with a long secret and accepts only its own issuer', async () => {
  assert.deepEqual(privateOverlay({ secret: undefined, networkMode: 'shared-noos', issuer: ISSUER, identityForOwner: async () => null }), {})
  assert.deepEqual(privateOverlay({ secret: 'short', networkMode: 'shared-noos', issuer: ISSUER, identityForOwner: async () => null }), {})
  assert.deepEqual(privateOverlay({ secret: SECRET, networkMode: 'loopback', issuer: ISSUER, identityForOwner: async () => null }), {})
  let reads = 0
  const wired = privateOverlay({ secret: SECRET, networkMode: 'shared-noos', issuer: ISSUER, identityForOwner: async who => { reads++; return who.ownerId === owner.ownerId ? { issuer: ISSUER, subject: 'owner-subject' } : { issuer: 'https://elsewhere.invalid', subject: 'x' } } })
  assert.ok(wired.overlay && typeof wired.overlayIdentity === 'function')
  assert.deepEqual(await wired.overlayIdentity(owner), { issuer: ISSUER, subject: 'owner-subject' })
  await wired.overlayIdentity(owner); assert.equal(reads, 1)
  assert.equal(await wired.overlayIdentity(stranger), null)
})

test('provenance reads as words; older records have no label', () => {
  assert.equal(provenanceLabel({ author: 'agent:Claude', source: 'connector', assertion: 'stated' }), 'Added by Claude via your Ideaflow connector')
  assert.equal(provenanceLabel({ author: 'agent:Cursor', source: 'direct-key' }), 'Added by Cursor with an API key')
  assert.equal(provenanceLabel({ author: 'owner', source: 'app' }), 'Added by you')
  assert.equal(provenanceLabel({ author: 'owner', source: 'suggestion' }), 'Suggested, then accepted by you')
  assert.equal(provenanceLabel({ author: 'agent:X', source: 'connector', assertion: 'inferred' }), 'Added by X via your Ideaflow connector · inferred')
  assert.equal(provenanceLabel({ author: null, source: null, assertion: null }), null)
})

test('a profile reads its own ref and the owner import of the same person; relation ends link inside Unlinked', async () => {
  const overlay = fakeOverlay()
  const context = createPrivateContext({ overlay, identityFor: async who => identities.get(who.ownerId) ?? null, lookupContact, now: () => Date.parse('2026-10-09T12:00:00Z') })
  const value = await context.forProfile(owner, 'pub-ada')
  assert.equal(value.state, 'ready')
  assert.deepEqual(overlay.calls.filter(call => call[0] === 'lookup').map(call => call[2]), ['unlinked:person:pub-ada', `linkedin:in:${adaHash}`])
  assert.equal(value.entities.length, 1)
  const [entity] = value.entities
  assert.equal(entity.important, true); assert.equal(entity.catchUp.due, true); assert.equal(entity.catchUp.cadenceDays, 30)
  assert.deepEqual(entity.notes.map(note => [note.text, note.label]), [[NOTE, 'Added by Claude via your Ideaflow connector'], ['Older note', null]])
  const ends = Object.fromEntries(entity.relations.map(relation => [relation.other.name, relation.other.href]))
  assert.equal(ends['Bo Private'], `/network/contacts/${bo.id}`)
  assert.equal(ends['Cy Published'], '/people/pub-cy')
  assert.equal(ends['Common Ground'], null)
  assert.equal(entity.relations.find(relation => relation.other.name === 'Cy Published').direction, 'in')
  assert.ok(!JSON.stringify(value).includes('owner-subject'), 'no identity in the answer')
  assert.ok(!JSON.stringify(value).includes('linkedin:in:'), 'no raw refs in the answer')
  // The other owner, the same person: nothing of the first owner's.
  const theirs = await context.forProfile(stranger, 'pub-ada')
  assert.deepEqual(theirs, { state: 'empty' })
  // An imported contact of the owner; someone else's contact id is not theirs.
  const contact = await context.forContact(owner, bo.id)
  assert.equal(contact.entities[0].notes[0].text, 'Bo note')
  assert.equal(await context.forContact(stranger, bo.id), null)
  const hood = await context.neighbourhood(owner, 'ent-ada', 2)
  assert.deepEqual(hood.links.map(link => [link.from.name, link.relation, link.to.name, link.to.href]), [['Ada Synthetic', 'knows', 'Bo Private', `/network/contacts/${bo.id}`]])
  assert.equal(await context.neighbourhood(stranger, 'ent-ada', 2), null)
})

test('no identity and a failing overlay are distinct from empty', async () => {
  const none = createPrivateContext({ overlay: fakeOverlay(), identityFor: async () => null, lookupContact })
  assert.deepEqual(await none.forProfile(owner, 'pub-ada'), { state: 'no_identity' })
  const failing = createPrivateContext({ overlay: { lookup: async () => { throw new Error('boom') } }, identityFor: async who => identities.get(who.ownerId), lookupContact })
  await assert.rejects(failing.forProfile(owner, 'pub-ada'), OverlayUnavailable)
  const off = createPrivateContext({ overlay: null, identityFor: async () => null, lookupContact })
  await assert.rejects(off.forProfile(owner, 'pub-ada'), OverlayUnavailable)
})

test('the panel renderer builds DOM from text, never markup', () => {
  assert.doesNotMatch(PRIVATE_CONTEXT_SCRIPT, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/)
  assert.match(PRIVATE_CONTEXT_SCRIPT, /cache:'no-store'/)
})

async function site(t, { privateContext, complete }) {
  const subjects = { 'owner-subject': owner, 'stranger-subject': stranger }
  let next = 'owner-subject', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', privateContext, complete,
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: ISSUER, subject: next, verifiedEmail: `${next}@example.invalid`, displayName: next === 'owner-subject' ? 'Owner Person' : 'Stranger Person' }) },
    resolveOwner: async identity => subjects[identity.subject], signup: async identity => subjects[identity.subject], issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {},
    getBackend: async who => backendFor(who), readPublishedSnapshot: snapshot })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async subject => {
    next = subject
    const begin = await request('/login')
    const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { request, signIn, baseUrl }
}
const stripNonce = text => text.replace(/nonce-[A-Za-z0-9_-]+/g, 'nonce').replace(/nonce="[^"]+"/g, 'nonce=""')

test('owner-only in the browser: anonymous and other accounts see nothing; public pages, APIs and AI search never carry it', async t => {
  const prompts = []
  const complete = async ({ candidateIds, input }) => { prompts.push(JSON.stringify(input)); return { matches: candidateIds.slice(0, 1).map(id => ({ id, reason: 'Matches' })) } }
  const context = createPrivateContext({ overlay: fakeOverlay(), identityFor: async who => identities.get(who.ownerId) ?? null, lookupContact })
  const { request, signIn, baseUrl } = await site(t, { privateContext: context, complete })
  const plain = await site(t, { privateContext: null, complete })

  // Signed out: the profile page is the same with or without the feature; no mount, no data.
  const anonymous = await (await request('/people/pub-ada')).text()
  assert.equal(stripNonce(anonymous), stripNonce(await (await plain.request('/people/pub-ada')).text()))
  assert.doesNotMatch(anonymous, /data-private-context|\/api\/private-context|Synthetic secret|Loading your private context/)
  for (const path of ['/api/private-context/people/pub-ada', '/api/private-context/contacts/' + bo.id, '/api/private-context/entities/ent-ada/neighbourhood?depth=2']) {
    const answer = await request(path)
    assert.equal(answer.status, 401); assert.equal(answer.headers.get('cache-control'), 'no-store, private')
    assert.doesNotMatch(await answer.text(), /Synthetic secret|Ada|Bo/)
  }
  for (const path of ['/api/people/pub-ada', '/api/people?q=Ada', '/people', '/search-public?q=Ada']) assert.doesNotMatch(await (await request(path)).text(), /Synthetic secret|Older note|knows/)

  // The owner: the page carries only an empty mount; the data comes from the no-store endpoint.
  const mine = await signIn('owner-subject')
  const page = await (await request('/people/pub-ada', { headers: { Cookie: mine } })).text()
  assert.match(page, /data-private-context="\/api\/private-context\/people\/pub-ada"/)
  assert.doesNotMatch(page, /Synthetic secret|Older note/)
  const answer = await request('/api/private-context/people/pub-ada', { headers: { Cookie: mine } })
  assert.equal(answer.status, 200); assert.equal(answer.headers.get('cache-control'), 'no-store, private'); assert.equal(answer.headers.get('vary'), 'Cookie')
  const data = await answer.json()
  assert.equal(data.entities[0].notes[0].text, NOTE)
  assert.equal((await request('/api/private-context/people/pub-ada', { headers: { Cookie: mine, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await request('/api/private-context/people/pub-ada', { method: 'POST', headers: { Cookie: mine, Origin: baseUrl } })).status, 405)
  assert.equal((await request('/api/private-context/entities/ent-ada', { headers: { Cookie: mine } })).status, 404)
  assert.equal((await request('/api/private-context/entities/ent-ada/neighbourhood?depth=3', { headers: { Cookie: mine } })).status, 400)
  const hood = await (await request('/api/private-context/entities/ent-ada/neighbourhood?depth=2', { headers: { Cookie: mine } })).json()
  assert.equal(hood.links[0].to.name, 'Bo Private')
  // Imported contacts: the private row links to the owner's contact page, which mounts the panel.
  const network = await (await request('/network', { headers: { Cookie: mine } })).text()
  assert.match(network, new RegExp(`href="/network/contacts/${bo.id}"`))
  assert.doesNotMatch(network, /Synthetic secret|Bo note/)
  const contactPage = await request(`/network/contacts/${bo.id}`, { headers: { Cookie: mine } })
  assert.equal(contactPage.status, 200)
  const contactHtml = await contactPage.text()
  assert.match(contactHtml, /Bo Private/); assert.match(contactHtml, new RegExp(`data-private-context="/api/private-context/contacts/${bo.id}"`)); assert.doesNotMatch(contactHtml, /Bo note/)
  assert.equal((await request(`/network/contacts/${sha('nobody')}`, { headers: { Cookie: mine } })).status, 404)
  assert.equal((await request(`/network/contacts/${bo.id}`)).status, 401)
  // AI search over the owner's network never sees overlay notes.
  const csrf = network.match(/name="csrf" value="([^"]+)"/)[1]
  await request('/search-account', { method: 'POST', headers: { Cookie: mine, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: 'Ada', scope: 'own', csrf }) })
  assert.ok(prompts.length >= 1)
  assert.ok(prompts.every(prompt => !prompt.includes('Synthetic secret') && !prompt.includes('Bo note')))
  // The owner's export includes their overlay copy, marked as not deleted with the account.
  const exported = await (await request('/export', { headers: { Cookie: mine } })).json()
  assert.equal(exported.ideaflowPrivateContext.deletedWithUnlinkedAccount, false)
  assert.ok(JSON.stringify(exported.ideaflowPrivateContext).includes(NOTE))

  // Another account sees only its own (empty) context for the same person, and none of the owner's contacts.
  const theirs = await signIn('stranger-subject')
  assert.deepEqual(await (await request('/api/private-context/people/pub-ada', { headers: { Cookie: theirs } })).json(), { state: 'empty' })
  assert.equal((await request(`/api/private-context/contacts/${bo.id}`, { headers: { Cookie: theirs } })).status, 404)
  assert.equal((await request('/api/private-context/entities/ent-ada/neighbourhood', { headers: { Cookie: theirs } })).status, 404)
  assert.equal((await request(`/network/contacts/${bo.id}`, { headers: { Cookie: theirs } })).status, 404)
  const theirExport = await (await request('/export', { headers: { Cookie: theirs } })).json()
  assert.ok(!JSON.stringify(theirExport).includes(NOTE))
})

test('a runtime without the overlay secret shows no panel and answers unavailable', async t => {
  const { request, signIn } = await site(t, { privateContext: null })
  const mine = await signIn('owner-subject')
  assert.doesNotMatch(await (await request('/people/pub-ada', { headers: { Cookie: mine } })).text(), /data-private-context/)
  const answer = await request('/api/private-context/people/pub-ada', { headers: { Cookie: mine } })
  assert.equal(answer.status, 503); assert.deepEqual(await answer.json(), { state: 'unavailable' })
})

test('GET /people/add is the Add a person page, not a profile id (unlinked-u8z)', async t => {
  const { request, signIn } = await site(t, { privateContext: null })
  const mine = await signIn('owner-subject')
  const page = await request('/people/add', { headers: { Cookie: mine } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Add a person/)
  assert.notEqual((await request('/people/add')).status, 404)
  assert.equal((await request('/people/pub-ada', { method: 'HEAD' })).status, 200)
})
