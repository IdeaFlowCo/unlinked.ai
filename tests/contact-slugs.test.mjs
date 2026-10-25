// unlinked-uwqw: owner-private readable addresses for /network/contacts/<id>.
// A slug is unique per owner, never shown to anyone else, sticky once issued,
// and the old row-id address 301s to it for the same signed-in owner only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { CONTACT_ROW_ID, contactSlugCandidates, createContactSlugs, createMemoryContactSlugStore, createNeo4jContactSlugStore } from '../mcp-server/contact-slugs.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemoryProfileHandleStore, createProfileHandles } from '../mcp-server/profile-handles.mjs'
import { setProfileHandleLookup } from '../src/utils/public-people/profile-handles.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { privateId } from '../src/utils/private-import/job.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

const owner = { ownerId: 'slug-owner', userId: 'slug-user' }, other = { ownerId: 'slug-other', userId: 'slug-other-user' }
const hex = c => c.repeat(64)

test('candidates: public handle, name, LinkedIn slug, then the name numbered; never id-shaped or reserved', () => {
  assert.deepEqual(contactSlugCandidates({ publicHandle: 'roger-cole', name: 'Roger Cole', linkedinUrl: 'https://www.linkedin.com/in/rogercole1' }).slice(0, 4), ['roger-cole', 'rogercole1', 'roger-cole-2', 'roger-cole-3'])
  assert.deepEqual(contactSlugCandidates({ name: 'Jamie Heywood' }).slice(0, 2), ['jamie-heywood', 'jamie-heywood-2'])
  assert.deepEqual(contactSlugCandidates({ name: 'José Núñez', linkedinUrl: 'https://www.linkedin.com/in/jose-n' }).slice(0, 3), ['jose-nunez', 'jose-n', 'jose-nunez-2'])
  // No name: the LinkedIn slug first, then a neutral numbered fallback.
  assert.deepEqual(contactSlugCandidates({ name: '', linkedinUrl: 'https://www.linkedin.com/in/ada-l' }).slice(0, 2), ['ada-l', 'someone-2'])
  // Reserved words and id shapes are never offered.
  assert.equal(contactSlugCandidates({ name: 'Admin' }).includes('admin'), false)
  assert.equal(contactSlugCandidates({ publicHandle: hex('a') }).includes(hex('a')), false)
  for (const value of contactSlugCandidates({ name: 'Ada Example' })) assert.equal(CONTACT_ROW_ID.test(value), false)
})

test('registry: assigns once, sticky across name changes, numbered on collision, owner-scoped, removable', async () => {
  const slugs = createContactSlugs({ store: createMemoryContactSlugStore() })
  const rows = [
    { id: hex('1'), category: 'connections', connectedAt: 2, fields: { 'first name': 'Ada', 'last name': 'Example' } },
    { id: hex('2'), category: 'connections', connectedAt: 1, fields: { 'first name': 'Ada', 'last name': 'Example' } },
    { id: hex('3'), category: 'connections', connectedAt: 3, fields: { 'first name': 'Ada', 'last name': 'Example', url: 'https://www.linkedin.com/in/ada-ex' } },
    { id: hex('4'), category: 'connections', connectedAt: 9, fields: { 'first name': 'Bo', 'last name': 'Other' } },
  ]
  const describe = values => values.map(row => ({ name: [row.fields['first name'], row.fields['last name']].join(' '), linkedinUrl: row.fields.url, publicHandle: row.id === hex('4') ? 'ada-example' : null }))
  assert.equal(await slugs.ensure(owner, rows, async values => describe(values)), 4)
  // The person whose public handle it is keeps it; earliest connection gets the plain name next.
  assert.equal(slugs.slugFor(hex('4')), 'ada-example')
  assert.equal(slugs.slugFor(hex('2')), 'ada-example-2')
  assert.equal(slugs.slugFor(hex('1')), 'ada-example-3')
  assert.equal(slugs.slugFor(hex('3')), 'ada-ex')
  assert.equal(slugs.pathFor(hex('2')), '/network/contacts/ada-example-2')
  assert.equal(slugs.pathFor(hex('9')), `/network/contacts/${hex('9')}`, 'no slug: the row id')
  // Sticky: a renamed contact keeps its address; nothing is re-assigned.
  const renamed = rows.map(row => row.id === hex('2') ? { ...row, fields: { 'first name': 'Ada', 'last name': 'Renamed' } } : row)
  assert.equal(await slugs.ensure(owner, renamed, async values => describe(values)), 0)
  assert.equal(await slugs.resolve(owner, 'ada-example-2'), hex('2'))
  assert.equal(await slugs.resolve(owner, 'Ada-Example-2'), hex('2'), 'any case')
  // Another owner: the same name is theirs to use, and the first owner's slugs mean nothing to them.
  const theirs = [{ id: hex('5'), category: 'connections', fields: { 'first name': 'Ada', 'last name': 'Example' } }]
  await slugs.ensure(other, theirs, async values => describe(values))
  assert.equal(slugs.slugFor(hex('5')), 'ada-example')
  assert.equal(await slugs.resolve(other, 'ada-example'), hex('5'))
  assert.equal(await slugs.resolve(other, 'ada-ex'), null)
  assert.equal(await slugs.resolve(owner, 'ada-example'), hex('4'))
  // A failing describe (index warming) assigns nothing; a later read does.
  const fresh = [{ id: hex('6'), category: 'connections', fields: { 'first name': 'Cy', 'last name': 'New' } }]
  await assert.rejects(slugs.ensure(owner, fresh, async () => { throw Error('index_unavailable') }))
  assert.equal(slugs.slugFor(hex('6')), null)
  assert.equal(await slugs.ensure(owner, fresh, async values => describe(values)), 1)
  assert.equal(slugs.slugFor(hex('6')), 'cy-new')
  assert.deepEqual((await slugs.exportOwner(other)).map(value => value.slug), ['ada-example'])
  await slugs.removeOwner(owner)
  assert.equal(slugs.slugFor(hex('2')), null)
  assert.equal(await slugs.resolve(owner, 'ada-example-2'), null)
  assert.equal(await slugs.resolve(other, 'ada-example'), hex('5'))
})

test('concurrent ensures for one owner settle on one slug per row', async () => {
  const slugs = createContactSlugs({ store: createMemoryContactSlugStore() })
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), category: 'connections', fields: { 'first name': 'Same', 'last name': 'Name' } }))
  const describe = async values => values.map(() => ({ name: 'Same Name' }))
  await Promise.all([slugs.ensure(owner, rows, describe), slugs.ensure(owner, rows.slice().reverse(), describe), slugs.ensure(owner, rows, describe)])
  const assigned = rows.map(row => slugs.slugFor(row.id))
  assert.equal(new Set(assigned).size, 30)
  assert.equal(assigned[0], 'same-name')
  assert.equal((await slugs.exportOwner(owner)).length, 30)
})

test('the slug store is part of shared recovery snapshots', () => {
  // An unknown Unlinked label makes the shared export fail closed (deploy/private-pilot/graph-migration.mjs).
  assert.ok(LABELS.includes('UnlinkedContactSlug'))
})

// End to end over HTTP: two owners, a profile-less joiner (Jamie), an imported
// contact with a public handle (Roger) and two people who share a name.
const ROGER = 'fda3008a-5990-4816-86ff-3834cfa6825d'
const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = { state: 'published', complete: true, revision: 'contact-slugs-test', profiles: [profile(ROGER, 'Roger Cole', { headline: 'Founder', linkedinUrl: 'https://www.linkedin.com/in/roger-cole' }), profile('alex-a', 'Alex Kim', { headline: 'Designer' })], members: [ROGER], connections: [], aliases: {} }

async function harness(t) {
  const importId = hex('a'), rogerRow = hex('b'), alexRow = hex('c'), otherAlexRow = hex('d')
  const row = (id, fields) => [id, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id, ownerId: owner.ownerId, importId, category: 'connections', fields } }]
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: Date.UTC(2026, 0, 5), status: 'indexed', assertionIds: [rogerRow, alexRow, otherAlexRow], counts: { accepted: 3, indexed: 3, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    row(rogerRow, { 'first name': 'Roger', 'last name': 'Cole', position: 'Founder', company: 'Sleep Intelligence', url: 'https://www.linkedin.com/in/roger-cole', 'connected on': '12 Mar 2019' }),
    row(alexRow, { 'first name': 'Alex', 'last name': 'Kim', position: 'Designer', company: 'Northwind', url: 'https://www.linkedin.com/in/alex-kim-northwind' }),
    row(otherAlexRow, { 'first name': 'Alex', 'last name': 'Kim', position: 'Engineer', company: 'Fabrikam', url: 'https://www.linkedin.com/in/alex-kim-fabrikam' }),
  ])
  const profileHandles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await profileHandles.initialize()
  await profileHandles.assignMany([{ id: ROGER, handle: 'roger-cole', kind: 'linkedin' }])
  const contactSlugs = createContactSlugs({ store: createMemoryContactSlugStore() })
  const reviews = []
  const contactEnrichment = { inspect: async () => ({ status: 'not_started' }), review: async (who, value, input) => { reviews.push({ who, id: value.id, ...input }) }, preferences: async () => null, addresses: async () => new Map(), exportOwner: async () => [], removeOwner: async () => {} }
  let subject = 'owner', handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => setProfileHandleLookup(null))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const slugs = { 'roger-cole': ROGER, 'alex-kim-northwind': 'alex-a' }
  handler = createPrivateBrowserHandler({ baseUrl, login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject, displayName: subject }) },
    resolveOwner: async identity => identity.subject === 'owner' ? owner : other, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    readPublishedSnapshot: async () => snapshot, ownProfileId: async () => null, profileHandles, contactSlugs, contactEnrichment,
    selfClaims: { lookupSlug: async slug => slugs[slug] ?? null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    getBackend: async who => who.ownerId === owner.ownerId
      ? { adapter: {}, listImportIds: async () => [importId], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async (_, id) => structuredClone(resources.get(id) ?? null),
        readMemberConnections: async () => [{ requestId: 'jamie-request', name: 'Jamie Heywood', connectedAt: Date.UTC(2026, 9, 20) }] }
      : { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null,
        readMemberConnections: async () => [{ requestId: 'their-jamie', name: 'Jamie Heywood', connectedAt: Date.UTC(2026, 9, 21) }] } })
  const go = (path, cookie, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } })
  const signIn = async name => {
    subject = name
    const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await go('/auth/callback/ideaflow?state=test&code=test', loginCookie)
    const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await go('/network', cookie)).text()
    return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)[1], network: page }
  }
  return { go, signIn, baseUrl, reviews, rogerRow, alexRow, otherAlexRow, jamieRow: privateId(owner.ownerId, 'member-connection', 'jamie-request'), theirJamie: privateId(other.ownerId, 'member-connection', 'their-jamie') }
}

test('end to end: the old hash address 301s to the owner’s slug, which renders the private contact; links prefer slugs; auth unchanged', async t => {
  const h = await harness(t)
  const me = await h.signIn('owner'), them = await h.signIn('other')
  // /network links the profile-less joiner and the imported record by slug.
  assert.match(me.network, /href="\/network\/contacts\/jamie-heywood"/)
  // A card with a published profile still opens the public page (which carries the owner's private panel).
  assert.match(me.network, /href="\/people\/roger-cole"/)
  assert.match(me.network, /href="\/network\/contacts\/alex-kim-fabrikam"/, 'a name collision takes the LinkedIn slug')
  assert.doesNotMatch(me.network, /\/network\/contacts\/[0-9a-f]{64}/, 'no hash addresses are emitted')
  // The exact old address moves to the readable one, uncached.
  let response = await h.go(`/network/contacts/${h.jamieRow}`, me.cookie)
  assert.equal(response.status, 301); assert.equal(response.headers.get('location'), '/network/contacts/jamie-heywood'); assert.equal(response.headers.get('cache-control'), 'no-store')
  response = await h.go('/network/contacts/Jamie-Heywood', me.cookie)
  assert.equal(response.status, 301); assert.equal(response.headers.get('location'), '/network/contacts/jamie-heywood')
  response = await h.go('/network/contacts/jamie-heywood', me.cookie)
  assert.equal(response.status, 200)
  let page = await response.text()
  assert.match(page, /<h1>Jamie Heywood/); assert.match(page, /private to you/)
  assert.match(page, /action="\/network\/contacts\/jamie-heywood\/enrichment"/)
  // A contact with a public handle keeps its private page (no redirect to /people).
  response = await h.go(`/network/contacts/${h.rogerRow}`, me.cookie)
  assert.equal(response.status, 301); assert.equal(response.headers.get('location'), '/network/contacts/roger-cole')
  response = await h.go('/network/contacts/roger-cole', me.cookie)
  assert.equal(response.status, 200); assert.match(await response.text(), /private to you/)
  // Signed out: sign-in required at every address, nothing about the contact revealed.
  for (const path of ['/network/contacts/jamie-heywood', `/network/contacts/${h.jamieRow}`]) {
    response = await h.go(path)
    assert.equal(response.status, 401, path); assert.doesNotMatch(await response.text(), /Jamie/)
  }
  // Another owner: Jacob's slugs and rows are not found; the same name is their own contact.
  assert.equal((await h.go('/network/contacts/roger-cole', them.cookie)).status, 404)
  assert.equal((await h.go('/network/contacts/alex-kim-fabrikam', them.cookie)).status, 404)
  assert.equal((await h.go(`/network/contacts/${h.jamieRow}`, them.cookie)).status, 404)
  response = await h.go('/network/contacts/jamie-heywood', them.cookie)
  assert.equal(response.status, 200)
  response = await h.go(`/network/contacts/${h.theirJamie}`, them.cookie)
  assert.equal(response.headers.get('location'), '/network/contacts/jamie-heywood')
  assert.equal((await h.go(`/network/contacts/${h.theirJamie}`, me.cookie)).status, 404)
  // Private detail actions work at the slug, for the owner only, and come back to it.
  const post = (path, who, values) => h.go(path, who.cookie, { method: 'POST', headers: { Origin: h.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: who.csrf, ...values }) })
  response = await post('/network/contacts/jamie-heywood/enrichment', me, { action: 'retry' })
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/network/contacts/jamie-heywood')
  assert.deepEqual(h.reviews.map(value => [value.who.ownerId, value.id]), [[owner.ownerId, h.jamieRow]])
  assert.equal((await post('/network/contacts/roger-cole/enrichment', them, { action: 'retry' })).status, 404)
  // The owner's export lists their own addresses only.
  const exported = await (await h.go('/export', me.cookie)).json()
  assert.deepEqual(exported.contactAddresses.map(value => value.slug).sort(), ['alex-kim', 'alex-kim-fabrikam', 'jamie-heywood', 'roger-cole'])
})

test('the isolated pilot forwards the slug registry to the browser', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../mcp-server/private-pilot.mjs', import.meta.url), 'utf8'))
  // Regression shape from 0.6.25: a store the composition creates must reach the browser and private context.
  assert.match(source, /contactEnrichment, contactSlugs, accountGrantKey/)
  assert.match(source, /contactEnrichment, contactSlugs, getBackend, complete, readPublishedSnapshot,\n {4}issueAccountGrant/)
  assert.match(source, /contactPath: id => contactSlugs\.pathFor\(id\)/)
  const composition = await import('node:fs/promises').then(fs => fs.readFile(new URL('../mcp-server/private-composition.mjs', import.meta.url), 'utf8'))
  assert.match(composition, /createContactSlugStore: createNeo4jContactSlugStore/)
  assert.match(composition, /\n {6}contactSlugs,\n/)
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const neo4jEnabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('durable slugs: owner-scoped, active-binding gated, concurrent assignment settles, removable', { skip: !neo4jEnabled }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const tag = randomUUID().slice(0, 8), a = { ownerId: `slug-a-${tag}`, userId: `user-a-${tag}` }, b = { ownerId: `slug-b-${tag}`, userId: `user-b-${tag}` }
  const run = async (query, params) => { const session = driver.session(); try { return await session.run(query, params) } finally { await session.close() } }
  for (const who of [a, b]) await run("CREATE (:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId,active:true})", who)
  t.after(async () => {
    await run('MATCH (n) WHERE (n:UnlinkedContactSlug OR n:OperationalOwner) AND (n.ownerId IN $ids OR n.sourceOwnerId IN $ids) DETACH DELETE n', { ids: [a.ownerId, b.ownerId] })
    await driver.close()
  })
  const store = createNeo4jContactSlugStore(driver)
  const slugs = createContactSlugs({ store })
  await slugs.initialize()
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: `${tag}${index.toString(16)}`.padEnd(64, '0').replace(/[^0-9a-f]/g, '0'), category: 'connections', connectedAt: index }))
  const describe = async values => values.map(() => ({ name: 'Neo Fictional' }))
  // Two processes (two registries over one store) race; the owner lock settles them.
  const second = createContactSlugs({ store })
  await Promise.all([slugs.ensure(a, rows, describe), second.ensure(a, rows.slice().reverse(), describe)])
  const listed = await store.list(a)
  assert.equal(listed.length, 12)
  assert.equal(new Set(listed.map(value => value.slug)).size, 12)
  assert.equal(new Set(listed.map(value => value.rowId)).size, 12)
  assert.equal(listed.find(value => value.rowId === rows[0].id)?.slug, 'neo-fictional')
  // Owner b gets the same strings in its own namespace; a's are invisible to b.
  await slugs.ensure(b, [{ id: hex('e'), category: 'connections' }], describe)
  assert.equal(await slugs.resolve(b, 'neo-fictional'), hex('e'))
  assert.equal(await slugs.resolve(b, 'neo-fictional-2'), null)
  // An inactive binding reads nothing and writes nothing.
  await run('MATCH (o:OperationalOwner {sourceOwnerId:$ownerId}) SET o.active=false', b)
  assert.deepEqual(await store.list(b), [])
  await assert.rejects(store.assign(b, [{ rowId: hex('f'), candidates: ['someone-new'] }]))
  await slugs.removeOwner(a)
  assert.deepEqual(await store.list(a), [])
})
