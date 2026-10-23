// unlinked-t9fg: an operator `suspend` decision is the reversible whole-profile
// soft delete. It hides any profile, a member's included, from everyone and
// from the account itself, along with any profile carrying the same LinkedIn
// address, and restoring it brings back exactly the earlier projection. All
// people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { operateProfileDecisions } from '../mcp-server/profile-decisions-operator.mjs'
import { applyProfileDecisions, validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { linkedinRefHash, urlIdentitySuspensions } from '../src/utils/public-people/url-identity.mjs'
import { suspendedRow, withoutSuspendedRows } from '../src/utils/public-people/suspension-filter.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'

const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const base = () => ({ state: 'published', complete: true, revision: 'suspension-test',
  profiles: [
    profile('member', 'Avery Lee', { linkedinUrl: 'https://www.linkedin.com/in/avery-lee' }),
    profile('imported', 'Morgan Singh', { headline: 'Engineer at Northwind', linkedinUrl: 'https://www.linkedin.com/in/morgan-singh' }),
    profile('copy', 'Morgan Singh'),
    profile('other', 'Sasha Baptiste'),
    profile('legacy', 'Lena Ito'),
  ],
  connections: [{ fromId: 'member', toId: 'imported' }, { fromId: 'member', toId: 'copy' }, { fromId: 'member', toId: 'other' }, { fromId: 'other', toId: 'imported' }, { fromId: 'other', toId: 'member' }],
  members: ['member'], legacyMembers: ['legacy'] })
const merged = { id: 'm1', kind: 'merge', profileId: 'copy', survivorId: 'imported' }
const MORGAN = linkedinRefHash('morgan-singh')

test('a suspend decision hides an imported profile, its edges and merged addresses from every reader', async () => {
  const after = applyProfileDecisions(base(), [merged, { id: 's1', kind: 'suspend', profileId: 'imported' }])
  assert.deepEqual(after.profiles.map(value => value.id), ['member', 'other', 'legacy'])
  assert.deepEqual(after.connections, [{ fromId: 'member', toId: 'other' }, { fromId: 'other', toId: 'member' }])
  assert.deepEqual(after.aliases, {}); assert.deepEqual(after.suspended, ['copy', 'imported'])
  assert.notEqual(after.revision, applyProfileDecisions(base(), [merged]).revision)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => after })
  for (const id of ['imported', 'copy']) {
    assert.equal(await reader.profile({ id }), null); assert.equal(await reader.card({ id }), null)
    assert.equal(await reader.suspended({ id }), true)
  }
  assert.equal(await reader.suspended({ id: 'other' }), false)
  assert.equal((await reader.lookup({ ids: ['imported', 'copy', 'other'] })).size, 1)
  assert.equal(await reader.lookupLinkedin({ address: 'https://www.linkedin.com/in/morgan-singh' }), null)
  // Not in search, totals or anyone's connections.
  const search = await reader.list({ query: 'morgan' })
  assert.equal(search.profiles.length, 0); assert.equal(search.total, 0)
  assert.equal((await reader.list({ includeTotal: true })).total, 3)
  const other = await reader.profile({ id: 'other' })
  assert.deepEqual(other.profile.connections.map(value => value.id), ['member']); assert.equal(other.profile.connectionCount, 1)
})

test('a member can be suspended too, hidden from listings, presence and their own pages; restoring returns the exact projection', async () => {
  const before = base()
  const after = applyProfileDecisions(before, [{ id: 's1', kind: 'suspend', profileId: 'member' }])
  assert.deepEqual(after.members, []); assert.deepEqual(after.suspended, ['member'])
  assert.deepEqual(after.profiles.map(value => value.id), ['imported', 'copy', 'other', 'legacy'])
  assert.deepEqual(after.connections, [{ fromId: 'other', toId: 'imported' }])
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => after })
  assert.equal(await reader.profile({ id: 'member' }), null)
  assert.equal((await reader.list({ presence: 'member' })).profiles.length, 0)
  // Restoring is revoking the decision: the next build is the original one.
  assert.deepEqual(applyProfileDecisions(base(), []), before)
  assert.deepEqual(applyProfileDecisions(base(), [{ id: 's1', kind: 'suspend', profileId: 'member', revoked: true }].filter(value => !value.revoked)), before)
})

test('no resurrection: a replacement profile with the same LinkedIn address stays hidden, even after the original disappears', () => {
  const snapshot = base()
  // Someone signs up claiming the same LinkedIn address, and a new import mints another copy.
  snapshot.profiles.push(profile('member-signup-x', 'Morgan S.', { linkedinUrl: 'https://linkedin.com/in/Morgan-Singh/' }), profile('public-new', 'Morgan Singh'))
  snapshot.members.push('member-signup-x')
  const rows = [{ publicId: 'public-new', subject: 'https://www.linkedin.com/in/morgan-singh' }, { publicId: 'public-other', subject: 'https://www.linkedin.com/in/someone-else' }]
  const explicit = [{ id: 's1', kind: 'suspend', profileId: 'imported', linkedinRefHash: MORGAN }]
  const automatic = urlIdentitySuspensions({ rows, explicit })
  assert.deepEqual(automatic, [{ id: 'suspend-url:public-new', kind: 'suspend', profileId: 'public-new' }])
  const after = applyProfileDecisions(snapshot, [...explicit, ...automatic])
  assert.deepEqual(after.profiles.map(value => value.id), ['member', 'copy', 'other', 'legacy'])
  assert.deepEqual(after.members, ['member'])
  // The original import was deleted: the stored address still suppresses replacements.
  const later = base(); later.profiles = later.profiles.filter(value => value.id !== 'imported'); later.connections = later.connections.filter(edge => edge.toId !== 'imported')
  later.profiles.push(profile('member-signup-x', 'Morgan S.', { linkedinUrl: 'https://www.linkedin.com/in/morgan-singh' }))
  assert.equal(applyProfileDecisions(later, explicit).profiles.some(value => value.id === 'member-signup-x'), false)
  // Without a stored address, the published profile's own address is used.
  assert.equal(applyProfileDecisions(snapshot, [{ id: 's2', kind: 'suspend', profileId: 'imported' }]).profiles.some(value => value.id === 'member-signup-x'), false)
})

test('suspend decisions are validated', () => {
  assert.throws(() => validateProfileDecisions([{ id: 'a', kind: 'suspend', profileId: 'x' }, { id: 'b', kind: 'suspend', profileId: 'x' }]), /profile_decisions_invalid/)
  assert.throws(() => validateProfileDecisions([{ id: 'a', kind: 'suspend' }]), /profile_decisions_invalid/)
  assert.throws(() => validateProfileDecisions([{ id: 'a', kind: 'suspend', profileId: 'x', linkedinRefHash: 'morgan-singh' }]), /profile_decisions_invalid/)
  // A suspension and a removal of the same profile can coexist.
  assert.doesNotThrow(() => validateProfileDecisions([{ id: 'a', kind: 'suspend', profileId: 'x', linkedinRefHash: MORGAN }, { id: 'b', kind: 'remove', profileId: 'x' }]))
  // An inert (unknown) suspension never breaks the build.
  assert.deepEqual(applyProfileDecisions(base(), [{ id: 's1', kind: 'suspend', profileId: 'nobody' }]).profiles.length, 5)
})

test('the operator suspends with who and why and the LinkedIn identity hash only, and restores with an audited reason', async () => {
  const nodes = []
  const session = {
    executeRead: work => work({ run: async () => ({ records: nodes.filter(value => !value.revoked).map(value => ({ get: () => value })) }) }),
    executeWrite: work => work({ run: async (query, params) => {
      if (/^CREATE/.test(query)) { nodes.push({ ...params.decision }); return { records: [] } }
      const node = nodes.find(value => value.id === params.id && !value.revoked && (!/kind: 'suspend'/.test(query) || value.kind === 'suspend'))
      if (node) Object.assign(node, { revoked: true, revokedBy: params.by, ...(params.reason ? { restoreReason: params.reason } : {}) })
      return { records: node ? [{ get: () => node.id }] : [] }
    } }),
  }
  const linkedinRefFor = async id => id === 'imported' ? MORGAN : null
  const suspended = await operateProfileDecisions({ args: ['suspend', 'imported', 'operator', 'removal request 1A2B3C4D'], session, linkedinRefFor })
  assert.equal(suspended.decision.kind, 'suspend'); assert.equal(suspended.decision.linkedinRefHash, MORGAN)
  assert.equal(suspended.decision.reason, 'removal request 1A2B3C4D'); assert.equal(suspended.decision.decidedBy, 'operator')
  assert.doesNotMatch(JSON.stringify(suspended), /morgan-singh/)
  await assert.rejects(operateProfileDecisions({ args: ['suspend', 'imported', 'operator', 'again'], session, linkedinRefFor }), /profile_decisions_invalid/)
  const member = await operateProfileDecisions({ args: ['suspend', 'member', 'operator', 'test', 'https://www.linkedin.com/in/avery-lee'], session })
  assert.equal(member.decision.linkedinRefHash, linkedinRefHash('avery-lee'))
  await assert.rejects(operateProfileDecisions({ args: ['suspend', 'other', 'operator', 'x', 'not a url'], session }), /arguments_invalid/)
  await assert.rejects(operateProfileDecisions({ args: ['suspend', 'other', 'operator'], session }), /arguments_invalid/)
  // Restore only lifts suspensions, and records why.
  const removal = await operateProfileDecisions({ args: ['remove', 'legacy', 'operator', 'removal'], session })
  await assert.rejects(operateProfileDecisions({ args: ['restore', removal.decision.id, 'operator', 'x'], session }), /not_found/)
  await assert.rejects(operateProfileDecisions({ args: ['restore', suspended.decision.id, 'operator'], session }), /arguments_invalid/)
  assert.deepEqual(await operateProfileDecisions({ args: ['restore', suspended.decision.id, 'operator', 'request withdrawn'], session }), { action: 'restore', restored: suspended.decision.id })
  assert.equal(nodes.find(value => value.id === suspended.decision.id).restoreReason, 'request withdrawn')
  await assert.rejects(operateProfileDecisions({ args: ['restore', suspended.decision.id, 'operator', 'again'], session }), /not_found/)
})

async function site(t, { decisions, readSuppressions, indexDown = () => false }) {
  const owner = { ownerId: 'suspension-owner', userId: 'suspension-user' }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const photo = { sha256: 'a'.repeat(64), type: 'image/jpeg', bytes: Buffer.from('jpeg') }
  const legacyId = '11111111-2222-4333-8444-555555555555'
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test', verifiedEmail: 'avery@example.invalid', displayName: 'Avery Lee' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async () => null, ...(readSuppressions ? { readSuppressions } : {}) }),
    ownProfileId: async () => legacyId,
    profilePhotos: { read: async id => id === legacyId ? photo : null, urlFor: () => null, refresh: async () => {} },
    readPublishedSnapshot: async () => {
      if (indexDown()) throw Error('index_unavailable')
      const snapshot = base()
      snapshot.profiles.push(profile(legacyId, 'Avery Lee')); snapshot.members.push(legacyId)
      snapshot.connections.push({ fromId: 'other', toId: legacyId })
      return applyProfileDecisions(snapshot, decisions())
    } })
  const go = (path, init = {}) => fetch(endpoint + path, { redirect: 'manual', ...init })
  const signIn = async () => {
    const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await go('/auth/callback/ideaflow?state=test&code=test', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { go, signIn, legacyId }
}

test('over HTTP: direct links, the API, photos and the account\'s own /profile and /card are unavailable while suspended, and come back on restore', async t => {
  let active = []
  const app = await site(t, { decisions: () => active })
  const id = app.legacyId
  assert.equal((await app.go(`/people/${id}`)).status, 200)
  assert.equal((await app.go(`/people/${id}/photo`)).status, 200)
  active = [merged, { id: 's1', kind: 'suspend', profileId: id }, { id: 's2', kind: 'suspend', profileId: 'imported' }]
  for (const path of [`/people/${id}`, `/api/people/${id}`, `/people/${id}/connections`, `/people/${id}/photo`, '/people/imported', '/api/people/imported', '/people/imported/removal', `/api/people/${id}/card`]) {
    const response = await app.go(path)
    assert.equal(response.status, 404, path)
    assert.doesNotMatch(await response.text(), /Avery Lee|Morgan Singh/, path)
  }
  const directory = await (await app.go('/api/people?q=morgan')).text()
  assert.doesNotMatch(directory, /Morgan Singh|imported/)
  const cookie = await app.signIn()
  for (const path of ['/profile', '/card', '/scan', `/people/${id}`, '/people/imported']) {
    const response = await app.go(path, { headers: { Cookie: cookie } })
    assert.equal(response.status, 404, path)
    const page = await response.text()
    if (['/profile', '/card', '/scan'].includes(path)) assert.match(page, /temporarily unavailable/)
    assert.doesNotMatch(page, /Morgan Singh/)
  }
  const network = await (await app.go('/network?q=morgan', { headers: { Cookie: cookie } })).text()
  assert.doesNotMatch(network, /Morgan Singh/)
  // Restore: the profile, its photo and the account's own pages are back.
  active = []
  assert.equal((await app.go(`/people/${id}`)).status, 200)
  assert.equal((await app.go(`/people/${id}/photo`)).status, 200)
  assert.match(await (await app.go('/people/imported')).text(), /Morgan Singh/)
  assert.notEqual((await app.go('/profile', { headers: { Cookie: cookie } })).status, 404)
})

test('a suspension is kept as a tombstone while its profile is unpublished, with its LinkedIn reference', async () => {
  const after = applyProfileDecisions(base(), [{ id: 's1', kind: 'suspend', profileId: 'retracted-profile', linkedinRefHash: MORGAN }])
  assert.ok(after.suspended.includes('retracted-profile'))
  assert.deepEqual(after.suspendedRefs, [MORGAN])
  // The stored address still hides the published profile that carries it.
  assert.equal(after.profiles.some(value => value.id === 'imported'), false)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => after })
  assert.equal(await reader.suspended({ id: 'retracted-profile' }), true)
  const { ids, refs } = await reader.suspensions()
  assert.ok(ids.has('retracted-profile') && ids.has('imported')); assert.ok(refs.has(MORGAN))
  // A tombstone without any published profile or address still answers.
  const bare = applyProfileDecisions(base(), [{ id: 's2', kind: 'suspend', profileId: 'gone' }])
  assert.deepEqual(bare.suspended, ['gone']); assert.equal(bare.profiles.length, 5)
  assert.equal(await createPublicPeopleReader({ readPublishedSnapshot: async () => bare }).suspended({ id: 'gone' }), true)
})

test('owner-private rows are matched by published id or LinkedIn identity only, never by name', () => {
  const suppressions = { ids: new Set(['imported']), refs: new Set([MORGAN]) }
  assert.equal(suspendedRow({ subject: 'https://www.linkedin.com/in/morgan-singh', fields: { 'first name': 'M' } }, suppressions), true)
  assert.equal(suspendedRow({ fields: { 'first name': 'M', url: 'linkedin.com/in/Morgan-Singh/' } }, suppressions), true)
  assert.equal(suspendedRow({ fields: { 'first name': 'Someone' }, provenance: { toId: 'imported' } }, suppressions), true)
  assert.equal(suspendedRow({ subject: 'https://www.linkedin.com/in/morgan-singh-2', fields: { 'first name': 'Morgan', 'last name': 'Singh' } }, suppressions), false)
  assert.equal(suspendedRow({ subject: 'unlinked:added-person:abc', fields: { 'first name': 'Morgan', 'last name': 'Singh' } }, suppressions), false)
  assert.equal(withoutSuspendedRows([{ subject: 'x' }], null).length, 1)
})

test('the owner network, its search and agent tools hide a suspended person even from the owner who imported them', async () => {
  const owner = { ownerId: 'owner-a', userId: 'user-a' }
  let suppressions = { ids: new Set(['imported']), refs: new Set([MORGAN]) }
  const backend = {
    listImportIds: async () => [],
    readMemberConnections: async () => [{ requestId: 'r1', name: 'Morgan Singh', publicProfileId: 'imported' }, { requestId: 'r2', name: 'Sasha Baptiste', publicProfileId: 'other' }],
    readLegacyObservations: async () => ({ assertions: [
      { id: 'l1', category: 'connections', rowId: 'a', fields: { 'first name': 'Morgan', 'last name': 'Singh', url: 'https://www.linkedin.com/in/morgan-singh' } },
      { id: 'l2', category: 'connections', rowId: 'b', fields: { 'first name': 'Morgan', 'last name': 'Singh', url: 'https://www.linkedin.com/in/another-morgan' } }] }),
    readSuppressions: async () => suppressions,
  }
  const network = createAccountNetwork({ owner, getBackend: async () => backend })
  const rows = (await network.readNetwork()).assertions
  assert.deepEqual(rows.map(row => row.id ?? row.rowId).sort(), ['l2', rows.find(row => row.rowId === 'connection:r2').id].sort())
  const search = await network.searchNetwork({ query: 'morgan' })
  assert.equal(search.total, 1); assert.doesNotMatch(JSON.stringify(search), /morgan-singh"|Morgan Singh"/)
  // Fails closed: an unreadable suspension list is an error, not a full network.
  backend.readSuppressions = async () => { throw Error('graph_unavailable') }
  await assert.rejects(network.readNetwork(), /graph_unavailable/)
  // Restored: everything is back.
  backend.readSuppressions = async () => null
  assert.equal((await network.readNetwork()).assertions.length, 4)
  suppressions = { ids: new Set(['imported']), refs: new Set() }
  backend.readSuppressions = async () => suppressions
  const notifications = { list: async () => [{ id: 'n1', kind: 'connection_request', actorName: 'Morgan Singh', actorProfileId: 'imported', createdAt: 1 }, { id: 'n2', kind: 'connection_request', actorName: 'Sasha Baptiste', actorProfileId: 'other', createdAt: 2 }], counts: async () => ({ unseen: 0, unread: 0 }) }
  const memberConnections = { received: async () => [{ id: 'q1', direction: 'received', status: 'pending', name: 'Morgan Singh', profileId: 'imported', createdAt: 1 }], sent: async () => [] }
  const service = createAccountToolService({ getBackend: async () => backend, notifications, memberConnections })
  const grant = { ownerId: owner.ownerId, userId: owner.userId, scope: 'account', tools: ['unlinked_list_notifications', 'unlinked_list_connection_requests'] }
  const listed = (await service.call({ grant, name: 'unlinked_list_notifications' })).text
  assert.doesNotMatch(listed, /Morgan Singh/); assert.match(listed, /Sasha Baptiste/)
  assert.doesNotMatch((await service.call({ grant, name: 'unlinked_list_connection_requests' })).text, /Morgan Singh/)
})

test('the operator requires a LinkedIn identity for a suspension, and plain revoke cannot lift one', async () => {
  const nodes = []
  const session = {
    executeRead: work => work({ run: async () => ({ records: nodes.filter(value => !value.revoked).map(value => ({ get: () => value })) }) }),
    executeWrite: work => work({ run: async (query, params) => {
      if (/^CREATE/.test(query)) { nodes.push({ ...params.decision }); return { records: [] } }
      const node = nodes.find(value => value.id === params.id && !value.revoked && (/<> 'suspend'/.test(query) ? value.kind !== 'suspend' : value.kind === 'suspend'))
      if (node) node.revoked = true
      return { records: node ? [{ get: () => node.id }] : [] }
    } }),
  }
  await assert.rejects(operateProfileDecisions({ args: ['suspend', 'member-signup-x', 'operator', 'reason'], session }), /linkedin_required/)
  const accepted = await operateProfileDecisions({ args: ['suspend', 'member-signup-x', 'operator', 'reason', '-'], session })
  assert.equal(accepted.decision.linkedinRefHash, undefined)
  await assert.rejects(operateProfileDecisions({ args: ['revoke', accepted.decision.id, 'operator'], session }), /not_found/)
  assert.equal((await operateProfileDecisions({ args: ['restore', accepted.decision.id, 'operator', 'done'], session })).restored, accepted.decision.id)
})

test('a suspended owner sees no identifying page while the public index is down; unknown status is unavailable, never the profile', async t => {
  let down = false, suppressions = null
  const app = await site(t, { decisions: () => [], indexDown: () => down, readSuppressions: async () => suppressions })
  const cookie = await app.signIn()
  const pages = ['/profile', '/card', '/scan']
  // Directly suspended (the stored decision names this account's profile): hidden, with the index down.
  down = true; suppressions = { ids: new Set([app.legacyId]), refs: new Set(), complete: false }
  for (const path of pages) {
    const response = await app.go(path, { headers: { Cookie: cookie } })
    assert.equal(response.status, 404, path)
    const page = await response.text()
    assert.match(page, /temporarily unavailable/); assert.doesNotMatch(page, /Avery Lee|linkedin\.com\/in\/avery/, path)
  }
  // Someone else is suspended and the index cannot say whether this profile shares their address: unavailable.
  suppressions = { ids: new Set(['imported']), refs: new Set([MORGAN]), complete: false }
  for (const path of pages) {
    const response = await app.go(path, { headers: { Cookie: cookie } })
    assert.equal(response.status, 503, path)
    assert.doesNotMatch(await response.text(), /Avery Lee|linkedin\.com\/in\/avery/, path)
  }
  // The suspension lookup itself failing is unavailable too.
  suppressions = null
  const failing = await site(t, { decisions: () => [], indexDown: () => true, readSuppressions: async () => { throw Error('graph_unavailable') } })
  const other = await failing.signIn()
  for (const path of pages) {
    const response = await failing.go(path, { headers: { Cookie: other } })
    assert.notEqual(response.status, 200, path)
    assert.doesNotMatch(await response.text(), /Avery Lee/, path)
  }
  // Nothing suspended is an authoritative answer: the account's own pages work during an index outage.
  assert.notEqual((await app.go('/profile', { headers: { Cookie: cookie } })).status, 503)
})
