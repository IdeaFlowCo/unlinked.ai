import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { applyProfileDecisions, validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createMemberPublicIndex, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { operateProfileDecisions } from '../mcp-server/profile-decisions-operator.mjs'

const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
// old and new are one person under two LinkedIn addresses; each was listed by a different member.
const base = () => ({ state: 'published', complete: true, revision: 'decisions-fixture-1',
  profiles: [person('old', 'Sarah Wilson', { headline: 'VP of Technology at 3cycle', positions: [{ title: 'VP of Technology', company: '3cycle' }] }), person('new', 'Sarah Wilson', { headline: 'VP of Technology at 3cycle' }), person('eden', 'Eden Chan'), person('isaac', 'Isaac Jiang'), person('test', 'Jacob Cole'), person('jacob', 'Jacob Cole')],
  connections: [{ fromId: 'eden', toId: 'old' }, { fromId: 'isaac', toId: 'new' }, { fromId: 'old', toId: 'new' }, { fromId: 'eden', toId: 'new' }], members: ['jacob'] })
const merge = (id, profileId, survivorId) => ({ id, kind: 'merge', profileId, survivorId })
const rename = (id, profileId, name) => ({ id, kind: 'rename', profileId, name })

test('a merge keeps the survivor, takes over the merged edges and fills missing fields; a rename changes only the name', () => {
  const before = base()
  const after = applyProfileDecisions(before, [merge('d1', 'old', 'new'), rename('d2', 'test', 'Jacob Cole (testing 1)')])
  assert.deepEqual(after.profiles.map(value => value.id), ['new', 'eden', 'isaac', 'test', 'jacob'])
  const survivor = after.profiles.find(value => value.id === 'new')
  assert.deepEqual(survivor.positions, [{ title: 'VP of Technology', company: '3cycle' }]); assert.equal(survivor.headline, 'VP of Technology at 3cycle')
  assert.deepEqual(after.connections, [{ fromId: 'eden', toId: 'new' }, { fromId: 'isaac', toId: 'new' }])
  assert.deepEqual(after.aliases, { old: 'new' }); assert.equal(after.profiles.find(value => value.id === 'test').name, 'Jacob Cole (testing 1)')
  assert.notEqual(after.revision, before.revision); assert.ok(after.revision.length <= 128)
  // Inputs are untouched, and no decisions means the original snapshot.
  assert.deepEqual(before, base()); assert.equal(applyProfileDecisions(before, []), before)
})

test('decisions never merge a claimed profile away, ignore unknown profiles, and refuse chains and repeats', () => {
  const after = applyProfileDecisions(base(), [merge('d1', 'jacob', 'test'), merge('d2', 'ghost', 'new'), rename('d3', 'ghost', 'Nobody')])
  assert.deepEqual(after.profiles.map(value => value.id), base().profiles.map(value => value.id)); assert.deepEqual(after.aliases, {})
  for (const decisions of [[merge('a', 'old', 'new'), merge('b', 'new', 'eden')], [merge('a', 'old', 'new'), merge('b', 'old', 'eden')], [rename('a', 'test', 'x'), rename('b', 'test', 'y')], [merge('a', 'old', 'old')], [rename('a', 'test', 'bad\u0000')], [{ id: 'a', kind: 'delete', profileId: 'old' }], [merge('a', 'old', 'new'), rename('a', 'test', 'x')]])
    assert.throws(() => validateProfileDecisions(decisions), /profile_decisions_invalid/)
})

test('the reader resolves a merged address to its survivor for pages, lookups and agents', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => applyProfileDecisions(base(), [merge('d1', 'old', 'new')]) })
  assert.deepEqual(await reader.profile({ id: 'old' }), { moved: 'new' })
  assert.deepEqual((await reader.profile({ id: 'new' })).profile.connections.map(value => value.id), ['eden', 'isaac'])
  const found = await reader.lookup({ ids: ['old', 'eden'] })
  assert.equal(found.get('old').id, 'new'); assert.equal(found.get('eden').id, 'eden')
  await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: async () => ({ ...base(), aliases: { old: 'missing' } }) }).list(), { status: 503 })
})

test('a merged profile address answers 301 to the survivor, as a page and as JSON', async t => {
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live', readPublishedSnapshot: async () => applyProfileDecisions(base(), [merge('d1', 'old', 'new')]),
    login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'state' } }), finish: async () => { throw Error('unused') } },
    resolveOwner: async () => null, signup: async () => null, getBackend: async () => { throw Error('unused') }, issueAccountGrant: async () => {}, revokeAccountGrant: async () => {} })
  for (const [path, location] of [['/people/old', '/people/new'], ['/api/people/old', '/api/people/new']]) {
    const response = await fetch(endpoint + path, { redirect: 'manual' })
    assert.equal(response.status, 301); assert.equal(response.headers.get('location'), location)
  }
  assert.equal((await fetch(endpoint + '/people/new', { redirect: 'manual' })).status, 200)
})

test('the shared index applies decisions last and adds accepted invites as edges between published profiles', async () => {
  let decisions = [merge('d1', 'old', 'new')], invites = [{ fromId: 'jacob', toId: 'isaac' }, { fromId: 'jacob', toId: 'unpublished' }]
  const read = createMemberPublicIndex({ readLegacy: async () => base(), discover: async () => [], getBackend: async () => null, publicPeople: { read: async dataset => { assert.equal(dataset, ENRICHMENT_DATASET); return null } },
    readMembers: async () => ['jacob'], readDecisions: async () => decisions, readInviteEdges: async () => invites })
  const first = await read()
  assert.deepEqual(first.aliases, { old: 'new' }); assert.ok(first.connections.some(edge => edge.fromId === 'jacob' && edge.toId === 'isaac'))
  assert.ok(!first.connections.some(edge => edge.toId === 'unpublished'))
  invites = []; decisions = []
  const second = await read()
  assert.ok(!second.connections.some(edge => edge.fromId === 'jacob')); assert.deepEqual(second.aliases, undefined); assert.notEqual(first.revision, second.revision)
})

test('people connected by an accepted invite appear in each owner network, linking to a public profile when there is one', async () => {
  const owner = { ownerId: 'owner', userId: 'user' }
  const getBackend = async () => ({ listImportIds: async () => [], readInviteConnections: async () => [{ invitationId: 'inv-1', other: { ownerId: 'o2', userId: 'u2' }, name: 'Ada Lovelace', publicProfileId: 'ada-profile' }, { invitationId: 'inv-2', other: { ownerId: 'o3', userId: 'u3' }, name: 'Grace Hopper', publicProfileId: null }] })
  const network = await createAccountNetwork({ owner, getBackend }).readNetwork()
  assert.deepEqual(network.assertions.map(row => [row.fields['first name'], row.category, row.provenance]), [['Ada Lovelace', 'connections', { source: 'unlinked-invite', invitationId: 'inv-1', toId: 'ada-profile' }], ['Grace Hopper', 'connections', { source: 'unlinked-invite', invitationId: 'inv-2' }]])
})

test('the operator records who decided and why, keeps the active set valid, and revokes instead of deleting', async () => {
  const nodes = []
  const session = {
    executeRead: work => work({ run: async () => ({ records: nodes.filter(value => !value.revoked).map(value => ({ get: () => value })) }) }),
    executeWrite: work => work({ run: async (query, params) => {
      if (/^CREATE/.test(query)) { nodes.push({ ...params.decision }); return { records: [] } }
      const node = nodes.find(value => value.id === params.id && !value.revoked)
      if (node) Object.assign(node, { revoked: true, revokedBy: params.by })
      return { records: node ? [{ get: () => node.id }] : [] }
    } }),
  }
  const merged = await operateProfileDecisions({ args: ['merge', 'old', 'new', 'claude-opus', 'same LinkedIn member id'], session })
  assert.equal(merged.decision.kind, 'merge'); assert.equal(merged.decision.evidence, 'same LinkedIn member id'); assert.equal(merged.decision.decidedBy, 'claude-opus')
  await assert.rejects(operateProfileDecisions({ args: ['merge', 'new', 'eden', 'claude-opus', 'chain'], session }), /profile_decisions_invalid/)
  await assert.rejects(operateProfileDecisions({ args: ['rename', 'test', 'x', 'claude-opus'], session }), /arguments_invalid/)
  await operateProfileDecisions({ args: ['rename', 'test', 'Jacob Cole (testing 1)', 'jacob', 'test account'], session })
  assert.equal((await operateProfileDecisions({ args: ['list'], session })).decisions.length, 2)
  await operateProfileDecisions({ args: ['revoke', merged.decision.id, 'jacob'], session })
  assert.equal((await operateProfileDecisions({ args: ['list'], session })).decisions.length, 1); assert.equal(nodes.length, 2)
  await assert.rejects(operateProfileDecisions({ args: ['revoke', merged.decision.id, 'jacob'], session }), /not_found/)
})
