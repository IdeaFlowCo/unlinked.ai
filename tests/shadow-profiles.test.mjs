import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createMemberPublicIndex, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
import { renderPeople, renderPerson } from '../mcp-server/private-onboarding-views.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const person = (id, name, headline) => ({ id, name, ...(headline ? { headline } : {}), positions: [], education: [], skills: [] })
// first is a member; second is a shadow known to two people; third is a stub.
const published = (extra = {}) => ({ state: 'published', complete: true, revision: 'shadow-fixture-1', profiles: [person('first', 'First Member'), person('second', 'Second Shadow', 'Engineer'), person('third', 'Third Stub'), person('fourth', 'Fourth Uploader')], connections: [{ fromId: 'first', toId: 'second' }, { fromId: 'first', toId: 'third' }, { fromId: 'fourth', toId: 'second' }], ...extra })

test('a snapshot that names members marks presence and reach on every surface; one without members adds nothing', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => published({ members: ['first'] }) })
  const second = (await reader.profile({ id: 'second' })).profile
  assert.equal(second.presence, 'shadow'); assert.equal(second.connectionCount, 2)
  assert.deepEqual(second.connections.map(value => [value.id, value.presence, value.connectionCount]), [['first', 'member', 2], ['fourth', 'shadow', 1]])
  assert.deepEqual((await reader.list()).profiles.map(value => [value.id, value.presence]), [['first', 'member'], ['fourth', 'shadow'], ['second', 'shadow'], ['third', 'shadow']])
  const found = await reader.lookup({ ids: ['third', 'missing', 'second'] })
  assert.deepEqual([...found.keys()], ['third', 'second']); assert.equal(found.get('third').connectionCount, 1)
  await assert.rejects(reader.lookup({ ids: 'second' }), { status: 400 })
  await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => published({ members: ['nobody'] }) }).list(), { status: 503 })
  const plain = (await createPublicPeopleReader({ readPublishedSnapshot: async () => published() }).profile({ id: 'second' })).profile
  assert.equal(plain.presence, undefined); assert.equal(plain.connectionCount, undefined)
})

test('claimed legacy profiles become members, unknown claims are ignored, and membership changes the revision', async () => {
  const legacy = published()
  let claimed = ['first', 'not-in-index']
  const read = createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => [], getBackend: async () => { throw Error('no member imports') },
    publicPeople: { read: async dataset => { assert.equal(dataset, ENRICHMENT_DATASET); return null } }, readMembers: async () => claimed })
  const before = await read(); assert.deepEqual(before.members, ['first'])
  claimed = []; const after = await read(); assert.deepEqual(after.members, []); assert.notEqual(before.revision, after.revision)
  const without = await createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => [], getBackend: async () => null, publicPeople: { read: async () => null } })()
  assert.equal(without.members, undefined)
})

test('shadow rows link and carry a network or stub mark; members and private rows carry none', () => {
  const own = [{ id: 'second', name: 'Second <Shadow>', presence: 'shadow', connectionCount: 1200 }, { id: 'third', name: 'Third Stub', presence: 'shadow', connectionCount: 1 }, { id: 'first', name: 'First Member', presence: 'member', connectionCount: 2 }, { name: 'Private Only', linkedinUrl: 'https://www.linkedin.com/in/private-only' }]
  const content = renderPeople({ csrf: 'token', own, everyone: [] }).content
  assert.match(content, /<a href="\/people\/second">Second &lt;Shadow&gt;<\/a><span class="shadow net"[^>]*>.*?Imported · 1,200<\/span>/)
  assert.match(content, /<a href="\/people\/third">Third Stub<\/a><span class="shadow" title="[^"]*one connection[^"]*">.*?Imported<\/span>/)
  assert.match(content, /<a href="\/people\/first">First Member<\/a><\/h3>/)
  assert.match(content, /<h3>Private Only<\/h3>/); assert.doesNotMatch(content, /href="\/people\/undefined"/)
  const page = renderPerson({ profile: { id: 'second', name: 'Second Shadow', presence: 'shadow', connectionCount: 2, positions: [], connections: [{ id: 'fourth', name: 'Fourth Uploader', presence: 'shadow', connectionCount: 1 }] } }).content
  assert.match(page, /2 connections/); assert.match(page, /Not on Unlinked yet/); assert.match(page, /href="\/join">Claim it/)
  assert.match(page, /<a class="crow" href="\/people\/fourth">.*?<span class="shadow"/)
  const member = renderPerson({ csrf: 'token', profile: { id: 'first', name: 'First Member', presence: 'member', connectionCount: 2, positions: [], connections: [] } }).content
  assert.doesNotMatch(member, /Not on Unlinked yet|class="shadow/)
})

test('signed-in People and profile rows link to the published profile of a legacy connection, with its mark', async t => {
  const owner = { ownerId: 'owner-one', userId: 'user-one' }
  const legacy = { profileId: 'first', receiptId: 'receipt', sourceSha256: 'a'.repeat(64), revision: 'legacy-public-v1:' + 'a'.repeat(64), profile: { name: 'First Member', positions: [], education: [], skills: [] },
    profiles: [person('first', 'First Member'), person('second', 'Second Shadow'), person('third', 'Third Stub'), person('gone', 'Unpublished Person')], connections: [{ fromId: 'first', toId: 'second' }, { fromId: 'first', toId: 'third' }, { fromId: 'first', toId: 'gone' }] }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const identity = { issuer: 'https://identity.invalid', subject: 'signed-subject', clientId: 'client', verifiedAt: Math.floor(Date.now() / 1000), verifiedEmail: 'member@example.invalid', emailEvidence: 'signed-ideaflow-beta-v1', displayName: 'First Member' }
  handler = createPrivateBrowserHandler({ baseUrl, login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => identity },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {},
    readPublishedSnapshot: async () => published({ members: ['first'] }),
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], readResource: async () => null, readLegacyProfile: async () => legacy }) })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const begin = await request('/login')
  const callback = await request('/auth/callback/ideaflow?code=code&state=state', { headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] } })
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const network = await (await request('/network', { headers: { Cookie: cookie } })).text()
  const own = network.slice(network.indexOf('aria-label="People you know"'), network.indexOf('aria-label="Everyone on Unlinked"'))
  assert.match(own, /<a href="\/people\/second">Second Shadow<\/a><span class="shadow net"[^>]*>.*?Imported · 2<\/span>/)
  assert.match(own, /<a href="\/people\/third">Third Stub<\/a><span class="shadow" /)
  assert.match(own, /<h3>Unpublished Person<\/h3>/)
  const profile = await (await request('/profile', { headers: { Cookie: cookie } })).text()
  assert.match(profile, /<a class="crow" href="\/people\/second">/); assert.match(profile, /<a class="crow" href="\/people\/third">/)
})

test('a reader may reuse a built index briefly; by default every request reads the snapshot', async () => {
  let reads = 0
  const source = async () => { reads++; return published({ members: ['first'] }) }
  const reusing = createPublicPeopleReader({ readPublishedSnapshot: source, reuseMs: 60000 })
  await reusing.list(); await reusing.lookup({ ids: ['second'] }); await reusing.profile({ id: 'second' })
  assert.equal(reads, 1)
  const fresh = createPublicPeopleReader({ readPublishedSnapshot: source })
  await fresh.list(); await fresh.list(); assert.equal(reads, 3)
  assert.throws(() => createPublicPeopleReader({ readPublishedSnapshot: source, reuseMs: 120000 }), TypeError)
})
