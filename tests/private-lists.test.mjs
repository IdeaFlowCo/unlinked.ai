import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateLists, PRIVATE_LIST_READ_TOOLS } from '../mcp-server/private-lists.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { composeAccountScope } from '../mcp-server/account-grants.mjs'
import { fixture } from './helpers/investor-fixture.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySavedSearchLists } from '../mcp-server/saved-search-lists.mjs'
import { renderListImport } from '../mcp-server/private-onboarding-views.mjs'

test('browser projection works through real scoped tool service and Noos page contracts', async () => {
  const requested = [], entity = { id: 'list1', kind: 'list', name: 'Investors', refs: [] }
  const f = fixture({ request: async (identity, method, path) => {
    requested.push({ identity, method, path })
    assert.equal(method, 'GET')
    if (identity.subject !== 'alice') return { status: 404, body: { error: 'not_found' } }
    if (path === 'entity-pages?kind=list&limit=50') return { status: 200, body: { entities: [entity], nextCursor: null } }
    if (path === 'entities/list1') return { status: 200, body: { entity } }
    if (path === 'entities/list1/link-pages?limit=50') return { status: 200, body: { links: [{ direction: 'out', relation: 'contains', other: { id: 'person1', kind: 'person', name: 'Ada', refs: ['unlinked:person:ada'] } }], nextCursor: null } }
    throw Error('unexpected path: ' + path)
  } })
  const service = createAccountToolService(f.options)
  const grant = owner => ({ ...owner, scope: composeAccountScope({ privateNotes: true }), tools: [...PRIVATE_LIST_READ_TOOLS], app: true })
  const lists = createPrivateLists({ call: async (owner, name, input) => (await service.call({ grant: grant(owner), name, input })).result })
  const owner = { ownerId: 'alice', userId: 'alice-user' }
  assert.equal((await lists.list(owner)).lists[0].id, 'list1')
  assert.equal((await lists.get(owner, 'list1')).members[0].profileId, 'ada')
  await assert.rejects(lists.get({ ownerId: 'bob', userId: 'bob-user' }, 'list1'), { code: 'not_found' })
  await assert.rejects(service.call({ grant: grant(owner), name: 'unlinked_save_private_thing', input: { kind: 'list', name: 'Forbidden' } }), { code: 'scope_not_granted' })
  assert.ok(requested.every(value => value.method === 'GET'))
})

test('private list reads use exact owner, paginated tools, and outgoing person membership only', async () => {
  const owner = { ownerId: 'alice', userId: 'alice-user' }, calls = []
  const service = createPrivateLists({ call: async (who, name, input) => {
    calls.push({ who, name, input })
    if (name === 'unlinked_list_private_things') return { entities: [{ id: 'list1', kind: 'list', name: 'Investors' }], nextCursor: 'next' }
    return { entity: { id: input.thingId, kind: input.thingId === 'person' ? 'person' : 'list', links: [
      { direction: 'out', relation: 'contains', other: { id: 'member', kind: 'person', name: 'Ada' } },
      { direction: 'in', relation: 'contains', other: { id: 'incoming', kind: 'person' } },
      { direction: 'out', relation: 'knows', other: { id: 'nonmember', kind: 'person' } },
      { direction: 'out', relation: 'contains', other: { id: 'company', kind: 'company' } },
    ] }, nextCursor: 'more-links' }
  } })
  assert.equal((await service.list(owner)).nextCursor, 'next')
  assert.deepEqual(calls[0], { who: owner, name: 'unlinked_list_private_things', input: { kind: 'list', limit: 50 } })
  const page = await service.get(owner, 'list1', 'cursor')
  assert.deepEqual(page.members.map(value => value.id), ['member']); assert.equal(page.nextCursor, 'more-links')
  assert.deepEqual(calls[1].input, { thingId: 'list1', limit: 50, after: 'cursor' })
  await assert.rejects(service.get(owner, 'person'), { code: 'not_found' })
  await assert.rejects(service.get(owner, '../other'), { code: 'not_found' })
  await assert.rejects(service.list(owner, 'x'.repeat(513)), { code: 'invalid_input' })
})

test('HTTP lists require sign-in, isolate owners, preserve empty-page cursors, escape names and fail visibly', async t => {
  const alice = { ownerId: 'alice', userId: 'alice-user' }, bob = { ownerId: 'bob', userId: 'bob-user' }
  let handler, unavailable = false
  const saved = createMemorySavedSearchLists()
  await saved.create(alice, { name: 'Saved founders', queryUrl: '/network', refs: ['public:founder'] })
  const privateLists = createPrivateLists({ call: async (owner, name, input) => {
    if (unavailable) throw Object.assign(Error('sensitive upstream detail'), { code: 'upstream_unavailable' })
    if (name === 'unlinked_list_private_things') return { entities: owner.ownerId === 'alice' ? [{ id: 'list1', kind: 'list', name: '<script>Private investors</script>' }] : [], nextCursor: owner.ownerId === 'alice' && !input.after ? 'next-private' : null }
    if (owner.ownerId !== 'alice') throw Object.assign(Error('missing'), { code: 'not_found' })
    return { entity: { id: input.thingId, kind: 'list', name: 'Private investors', links: input.after ? [{ direction: 'out', relation: 'contains', other: { kind: 'person', name: '<img src=x>', profileId: 'ada' } }] : [{ direction: 'in', relation: 'contains', other: { kind: 'person', name: 'Incoming hidden' } }] }, nextCursor: input.after ? null : 'next-members' }
  } })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const options = { baseUrl, privateLists, savedSearchLists: saved, login: { begin: async () => ({ location: 'https://identity.invalid', transaction: { state: 'test' } }), finish: async url => ({ issuer: 'https://identity.invalid', subject: url.searchParams.get('code') }) }, resolveOwner: async who => who.subject === 'bob' ? bob : alice, signup: async () => alice, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {}, getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [] }) }
  handler = createPrivateBrowserHandler(options)
  const get = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const login = async who => { const start = await get('/login'), cookie = start.headers.getSetCookie()[0].split(';')[0]; const callback = await get('/auth/callback/ideaflow?state=test&code=' + who, cookie); return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0] }
  const anon = await get('/lists'); assert.notEqual(anon.status, 200); assert.doesNotMatch(await anon.text(), /Private investors/)
  const cookie = await login('alice'), other = await login('bob')
  const response = await get('/lists', cookie), body = await response.text()
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/)
  assert.match(body, /Private lists/); assert.match(body, /Saved founders/); assert.match(body, /&lt;script&gt;Private investors&lt;\/script&gt;/)
  assert.match(body, /href="\/lists\?after=next-private#private-lists"/)
  assert.match(body, /role="menuitem" href="\/lists">Lists/); assert.match(body, /href="\/lists" aria-current="page"/)
  assert.doesNotMatch(await (await get('/lists', other)).text(), /Private investors|Saved founders/)
  assert.equal((await get('/lists/private/list1', other)).status, 404)
  const first = await (await get('/lists/private/list1', cookie)).text()
  assert.match(first, /Load more/); assert.doesNotMatch(first, /Incoming hidden/)
  const second = await (await get('/lists/private/list1?after=next-members', cookie)).text()
  assert.match(second, /&lt;img src=x&gt;/); assert.match(second, /href="\/people\/ada"/)
  const tableResponse = await get('/lists/private/list1?view=table&after=next-members', cookie)
  const table = await tableResponse.text()
  assert.equal(tableResponse.status, 200)
  assert.match(table, /<title>Private investors · Table · Unlinked<\/title>/)
  assert.match(table, /<table class="private-members-table">/)
  assert.match(table, /&lt;img src=x&gt;/)
  assert.equal((await get('/lists/private/list1?view=table', other)).status, 404)
  assert.notEqual((await get('/lists/private/list1?view=table')).status, 200)
  assert.equal((await get('/lists/private/list1?after=a&after=b', cookie)).status, 400)
  unavailable = true
  const error = await get('/lists/private/list1', cookie); assert.equal(error.status, 503); assert.doesNotMatch(await error.text(), /sensitive upstream detail/)
  const partial = await (await get('/lists', cookie)).text(); assert.match(partial, /couldn’t be loaded/); assert.match(partial, /Saved founders/)
  handler = createPrivateBrowserHandler({ ...options, savedSearchLists: null }); unavailable = false
  assert.match(await (await get('/lists', await login('alice'))).text(), /Private investors/)
})

test('import results link back to the existing graph list', () => {
  const view = renderListImport({ csrf: 'test', list: { status: 'complete', listName: 'Investors', listId: 'list1' } })
  assert.match(view.content, /href="\/lists\/private\/list1">Open list/)
})
