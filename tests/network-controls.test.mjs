import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { orderNetwork, connectionDate } from '../src/utils/network-order.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const profile = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
const snapshot = { state: 'published', complete: true, revision: 'network-controls-test', profiles: Array.from({ length: 120 }, (_, i) => profile(`p${i}`, `Person ${String(i).padStart(3, '0')}`)), members: ['p0', 'p119'], connections: [] }

test('sort and filtering cover the full public dataset before paging; cursors cannot cross sort orders', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot, pageSize: 2 })
  const result = await reader.list({ sort: 'name-desc', includeTotal: true })
  assert.deepEqual(result.profiles.map(p => p.id), ['p119', 'p118']); assert.equal(result.total, 120)
  assert.deepEqual((await reader.list({ sort: 'name-desc', cursor: result.nextCursor })).profiles.map(p => p.id), ['p117', 'p116'])
  await assert.rejects(reader.list({ sort: 'name', cursor: result.nextCursor }), { status: 400 })
  const filtered = await reader.list({ query: '119', presence: 'member', sort: 'name' })
  assert.deepEqual(filtered.profiles.map(p => p.id), ['p119']); assert.equal(filtered.total, 1)
  await assert.rejects(reader.list({ sort: 'connected' }), { status: 400 })
})

test('date sorting distinguishes connected from imported, with unknown dates last and deterministic ties', () => {
  const rows = [{ id: 'b', name: 'B', connectedAt: 100, importedAt: 300 }, { id: 'a', name: 'A', connectedAt: 200, importedAt: 100 }, { id: 'c', name: 'C' }]
  assert.deepEqual(orderNetwork(rows, 'connected').map(r => r.id), ['a', 'b', 'c'])
  assert.deepEqual(orderNetwork(rows, 'imported').map(r => r.id), ['b', 'a', 'c'])
  assert.deepEqual(orderNetwork(rows, 'name-desc').map(r => r.id), ['c', 'b', 'a'])
  assert.equal(connectionDate('04 Oct 2026'), Date.UTC(2026, 9, 4))
  assert.equal(connectionDate('2026-10-04'), Date.UTC(2026, 9, 4))
  for (const value of ['', '10/04/2026', 'yesterday', undefined, '2026-02-31']) assert.equal(connectionDate(value), undefined)
})

test('one scoped native form preserves membership, personal scope, sort and exact mode; links preserve sorting', () => {
  const { content } = renderPeople({ query: 'Ada & co', presence: 'member', mode: 'exact', sort: 'connected', connectedCounts: { all: 5 }, connectedView: { rows: [], total: 0 } })
  const forms = [...content.matchAll(/<form[^>]*role="search"[^>]*>(.*?)<\/form>/gs)]
  assert.equal(forms.length, 1)
  for (const [name, value] of [['presence', 'member'], ['connected', '1'], ['mode', 'exact']]) assert.ok(forms[0][1].includes(`name="${name}" value="${value}"`))
  assert.match(forms[0][1], /value="connected" selected>Recently connected/)
  assert.match(content, /q=Ada%20%26%20co&amp;mode=exact&amp;connected=1&amp;sort=connected&amp;presence=shadow/)
  assert.match(content, /Unknown dates appear last/)
  assert.doesNotMatch(renderPeople({ everyone: [], total: 0 }).content, /<option value="connected"|<option value="imported"/)
})

test('HTTP list preserves state and accepted-connection dates without exposing owner metadata anonymously', async t => {
  const owner = { ownerId: 'controls-owner', userId: 'controls-user' }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test' }) }, resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {}, readPublishedSnapshot: async () => snapshot,
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], readResource: async () => null, readMemberConnections: async () => [{ requestId: 'first', name: 'Person 000', publicProfileId: 'p0', connectedAt: Date.UTC(2025, 1, 1) }, { requestId: 'last', name: 'Person 119', publicProfileId: 'p119', connectedAt: Date.UTC(2026, 1, 1) }] }) })
  const go = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const publicPage = await (await go('/network?presence=member&q=119&sort=name-desc')).text()
  assert.match(publicPage, /name="presence" value="member"/); assert.match(publicPage, /value="name-desc" selected/); assert.match(publicPage, /Showing 1 of 1 matching people/)
  assert.equal((await go('/network?sort=connected')).status, 400)
  const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await go('/auth/callback/ideaflow?state=test&code=test', loginCookie)
  const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await go('/network?connected=1&presence=member&sort=connected', cookie)).text()
  assert.ok(page.indexOf('href="/people/p119"') < page.indexOf('href="/people/p0"'), page.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ''))
  assert.match(page, /Connected <time datetime="2026-02-01"/)
  assert.match(page, /name="connected" value="1"/)
  assert.equal((await go('/network?connected=1&sort=bogus', cookie)).status, 400)
  const anonymous = await (await go('/api/people/p119')).json()
  assert.equal(anonymous.profile.connectedAt, undefined); assert.equal(anonymous.profile.importedAt, undefined)
})

test('an imported connection retains original connected-on separately from the batch creation date', async () => {
  const { createAccountNetwork } = await import('../src/utils/private-import/account-network.mjs')
  const { COMBINED_UPLOAD_CONSENT } = await import('../src/utils/private-import/consent.mjs')
  const owner = { ownerId: 'date-owner', userId: 'date-user' }, importId = '1'.repeat(64), rowId = '2'.repeat(64)
  const importedAt = Date.UTC(2026, 9, 5)
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: importedAt, status: 'indexed', assertionIds: [rowId], counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    [rowId, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: rowId, ownerId: owner.ownerId, importId, category: 'connections', fields: { 'first name': 'Alex', 'connected on': '01 Jan 2014' } } }],
  ])
  const network = await createAccountNetwork({ owner, getBackend: async () => ({ listImportIds: async () => [importId], readResource: async (_, id) => structuredClone(resources.get(id)) }) }).readNetwork()
  assert.equal(network.assertions[0].connectedAt, Date.UTC(2014, 0, 1))
  assert.equal(network.assertions[0].importedAt, importedAt)
})
