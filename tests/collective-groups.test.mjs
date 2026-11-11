import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySavedSearchLists } from '../mcp-server/saved-search-lists.mjs'
import { createCollectiveGroups, GROUP_LIMITS } from '../mcp-server/collective-groups.mjs'
import { createCollectiveListProjection } from '../mcp-server/collective-group-lists.mjs'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'

const account = id => ({ ownerId: id, userId: id + '-user' })
const alice = account('alice'), bob = account('bob'), carol = account('carol')
const profiles = ['alice', 'bob', 'carol', 'public-a', 'public-b'].map(id => ({ id, name: id, headline: 'Public bio', positions: [], education: [], skills: [] }))
const recipient = { id: 'bob', name: 'Bob' }
const secret = 'Private fixture contact and query'

async function browser(t) {
  const store = createMemoryCollectiveGroupsStore()
  const registered = new Set(['alice', 'bob', 'carol'])
  const savedSearchLists = createMemorySavedSearchLists()
  const saved = await savedSearchLists.create(alice, { name: 'Reviewed set', queryUrl: '/network?q=private-query', refs: ['public:public-a', 'contact:private-contact'] })
  await savedSearchLists.create(alice, { name: 'Unselected set', queryUrl: '/network?q=unselected', refs: ['public:public-b'] })
  const foreign = await savedSearchLists.create(carol, { name: 'Carol private list', queryUrl: '/network', refs: ['public:public-b'] })
  let now = 1000
  const active = actor => registered.has(actor.ownerId) && actor.userId === account(actor.ownerId).userId
  const collectiveGroups = createCollectiveGroups({ store, now: () => now, active })
  const options = { collectiveGroups, savedSearchLists, networkFreshMs: 0,
    privateLists: {
      list: async owner => ({ lists: owner.ownerId === 'alice' ? [{ id: 'fixture-graph-list', name: 'Founder introductions' }] : [] }),
      get: async (owner, id) => {
        if (owner.ownerId !== 'alice' || id !== 'fixture-graph-list') throw Object.assign(Error('not_found'), { code: 'not_found' })
        return { list: { name: 'Founder introductions', description: secret }, members: [{ profileId: 'public-a', name: secret }, { name: secret }] }
      },
    },
    login: { begin: async () => ({ location: 'https://identity.invalid', transaction: { state: 'test' } }), finish: async url => ({ issuer: 'https://identity.invalid', subject: url.searchParams.get('code') }) },
    resolveOwner: async identity => registered.has(identity.subject) ? account(identity.subject) : null,
    signup: async identity => { registered.add(identity.subject); return account(identity.subject) },
    issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    selfClaims: { lookupSlug: async () => null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'v1', profiles, connections: [] }),
    ownProfileId: async owner => owner.ownerId,
    accountForProfile: async id => ['alice', 'bob', 'carol'].includes(id) ? account(id) : null,
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [] }),
  }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ ...options, baseUrl })
  const get = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const post = (path, cookie, fields, origin = baseUrl) => fetch(endpoint + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const login = async (who, next) => {
    const start = await get(next ? '/login?next=' + encodeURIComponent(next) : '/login')
    const loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await get('/auth/callback/ideaflow?state=test&code=' + who, loginCookie)
    const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
    const csrf = token(await (await get('/groups', cookie)).text())
    return { cookie, csrf, destination: callback.headers.get('location') }
  }
  return { get, post, login, saved, foreign, store, expire: () => { now += GROUP_LIMITS.inviteMs } }
}
const token = html => html.match(/name="csrf" value="([^"]+)"/)?.[1]
const proof = html => html.match(/name="proof" value="([^"]+)"/)?.[1]
const location = response => { assert.equal(response.status, 303); return response.headers.get('location') }
const invitePath = html => new URL(html.match(/readonly value="([^"]+\/invites\/[^"]+)"/)[1]).pathname
const revokePath = (html, label) => html.match(new RegExp('action="([^"]+/' + label + ')"'))?.[1]
const show = async (response, status = 200) => { assert.equal(response.status, status); return response.text() }

test('browser: invitation is recipient bound and read only until consent; cancellation, expiration and removal close access', async t => {
  const b = await browser(t)
  const owner = await b.login('alice'), member = await b.login('bob'), outsider = await b.login('carol')
  assert.match(await show(await b.get('/lists', owner.cookie)), /href="\/groups"/)
  const create = { csrf: owner.csrf, name: 'Climate founders' }
  assert.equal((await b.post('/groups', owner.cookie, create, 'https://elsewhere.invalid')).status, 403)
  assert.equal((await b.post('/groups', owner.cookie, { ...create, csrf: 'bad' })).status, 400)
  const group = location(await b.post('/groups', owner.cookie, create))
  assert.equal((await b.get(group, member.cookie)).status, 404)
  const makeInvite = async () => {
    location(await b.post(group + '/invite', owner.cookie, { csrf: owner.csrf, profile: 'https://www.unlinked.ai/people/bob' }))
    const html = await show(await b.get(group, owner.cookie))
    assert.match(html, /chat\.ideaflow\.app\/app\/\?intent=compose/)
    return invitePath(html)
  }
  const cancelled = await makeInvite()
  location(await b.post(cancelled + '/revoke', owner.cookie, { csrf: owner.csrf }))
  assert.equal((await b.post(cancelled, member.cookie, { csrf: member.csrf, decision: 'accept' })).status, 404)
  const stale = await makeInvite()
  b.expire()
  assert.equal((await b.get(stale, member.cookie)).status, 404)
  assert.equal((await b.post(stale, member.cookie, { csrf: member.csrf, decision: 'accept' })).status, 404)
  const current = await makeInvite()
  const signedOut = await b.get(current)
  assert.equal(signedOut.status, 401)
  assert.equal(signedOut.headers.get('cache-control'), 'no-store')
  assert.match(await signedOut.text(), new RegExp(encodeURIComponent(current)))
  assert.equal((await b.get(current, outsider.cookie)).status, 404)
  assert.equal((await b.post(current, outsider.cookie, { csrf: outsider.csrf, decision: 'accept' })).status, 404)
  assert.match(await show(await b.get(current, member.cookie)), /Accept invitation/)
  assert.equal((await b.get(group, member.cookie)).status, 404)
  assert.equal((await b.post(current, member.cookie, { csrf: owner.csrf, decision: 'accept' })).status, 400)
  assert.equal(location(await b.post(current, member.cookie, { csrf: member.csrf, decision: 'accept' })), group)
  assert.equal((await b.post(current, member.cookie, { csrf: member.csrf, decision: 'accept' })).status, 404)
  const visible = await show(await b.get(group, member.cookie))
  assert.match(visible, /Climate founders/)
  assert.doesNotMatch(visible, /Create invitation|Choose a list to share/)
  const remove = revokePath(await show(await b.get(group, owner.cookie)), 'remove')
  assert.equal((await b.post(remove, member.cookie, { csrf: member.csrf })).status, 404)
  location(await b.post(remove, owner.cookie, { csrf: owner.csrf }))
  assert.equal((await b.get(group, member.cookie)).status, 404)
  assert.equal((await b.get(current, member.cookie)).status, 404)
})

test('browser: only selected list projection is shared and every direct link rechecks access', async t => {
  const b = await browser(t)
  const owner = await b.login('alice'), member = await b.login('bob'), outsider = await b.login('carol')
  const group = location(await b.post('/groups', owner.cookie, { csrf: owner.csrf, name: 'Reviewers' }))
  location(await b.post(group + '/invite', owner.cookie, { csrf: owner.csrf, profile: 'https://www.unlinked.ai/people/bob' }))
  const invite = invitePath(await show(await b.get(group, owner.cookie)))
  location(await b.post(invite, member.cookie, { csrf: member.csrf, decision: 'accept' }))
  const select = group + '/select', source = 'saved:' + b.saved.id
  assert.equal((await b.get(select, member.cookie)).status, 404)
  assert.equal((await b.get(select + '?source=' + encodeURIComponent('saved:' + b.foreign.id), owner.cookie)).status, 400)
  const choose = await show(await b.get(select, owner.cookie))
  assert.match(choose, /Reviewed set/)
  assert.match(choose, /Unselected set/)
  const preview = await show(await b.get(select + '?source=' + encodeURIComponent(source), owner.cookie))
  assert.match(preview, /Share with this group/)
  assert.doesNotMatch(preview, /private-query|private-contact|Unselected set/)
  assert.equal((await b.post(select, owner.cookie, { csrf: owner.csrf, source, proof: 'wrong' })).status, 409)
  assert.equal((await b.post(select, member.cookie, { csrf: member.csrf, source, proof: proof(preview) })).status, 404)
  location(await b.post(select, owner.cookie, { csrf: owner.csrf, source, proof: proof(preview) }))
  const share = revokePath(await show(await b.get(group, owner.cookie)), 'revoke').replace(/\/revoke$/, '')
  assert.equal((await b.get(share, outsider.cookie)).status, 404)
  assert.equal((await b.get(share)).status, 401)
  const access = await b.get(share, member.cookie)
  assert.equal(access.headers.get('cache-control'), 'no-store')
  assert.match(access.headers.get('x-robots-tag'), /noindex/)
  const html = await show(access)
  assert.match(html, /href="\/people\/public-a"/)
  assert.doesNotMatch(html, /private-query|private-contact|public-b|Unselected set/)
  assert.equal((await b.get(group + '/lists/' + randomUUID(), member.cookie)).status, 404)
  assert.equal((await b.get('/lists/' + b.saved.id, member.cookie)).status, 404)
  assert.equal((await b.post(share + '/revoke', member.cookie, { csrf: member.csrf })).status, 404)
  location(await b.post(share + '/revoke', owner.cookie, { csrf: owner.csrf }))
  assert.equal((await b.get(share, member.cookie)).status, 404)
  const graphSource = 'private:fixture-graph-list'
  const graphPreview = await show(await b.get(select + '?source=' + encodeURIComponent(graphSource), owner.cookie))
  assert.doesNotMatch(graphPreview, new RegExp(secret))
  location(await b.post(select, owner.cookie, { csrf: owner.csrf, source: graphSource, proof: proof(graphPreview) }))
  const organizerPage = await show(await b.get(group, owner.cookie))
  const graphShare = organizerPage.match(/href="([^"]+\/lists\/[^"]+)">Founder introductions/)[1]
  assert.match(await show(await b.get(graphShare, member.cookie)), /href="\/people\/public-a"/)
  location(await b.post(revokePath(organizerPage, 'remove'), owner.cookie, { csrf: owner.csrf }))
  assert.equal((await b.get(graphShare, member.cookie)).status, 404)
})

test('graph list projection drops removed and unlisted entries and does not add later entries', async () => {
  let members = [{ profileId: 'a' }, { name: secret }], publicIds = new Set(['a', 'b'])
  const projection = createCollectiveListProjection({
    privateLists: { get: async () => ({ list: { name: 'Graph list', description: secret }, members }) },
    lookup: async ids => new Map(ids.filter(id => publicIds.has(id)).map(id => [id, { id, name: id, email: secret }])),
  })
  const source = 'private:fixture', selection = await projection.preview(alice, 'group', source)
  assert.deepEqual(selection.ids, ['a'])
  assert.deepEqual(selection.profiles, [{ id: 'a', name: 'a', headline: undefined }])
  members.push({ profileId: 'b' })
  assert.deepEqual((await projection.project(alice, source, selection.ids)).map(row => row.id), ['a'])
  publicIds.delete('a')
  assert.deepEqual(await projection.project(alice, source, selection.ids), [])
  publicIds.add('a')
  members = [{ profileId: 'b' }]
  assert.deepEqual(await projection.project(alice, source, selection.ids), [])
})

test('revocation and membership replacement deny a share whose projection was already running', async () => {
  const groups = createCollectiveGroups({ store: createMemoryCollectiveGroupsStore(), active: () => true })
  const group = await groups.create(alice, 'Private group')
  let seat = await groups.invite(alice, group.id, bob, recipient)
  await groups.respond(bob, group.id, seat, 'accept')
  const selection = { ids: ['a'], source: 'saved:fixture', name: 'Private list' }
  for (const revoke of ['share', 'member']) {
    const share = await groups.share(alice, group.id, selection)
    let begin, finish
    const projecting = new Promise(resolve => { begin = resolve })
    const slow = new Promise(resolve => { finish = resolve })
    const read = groups.readShare(bob, group.id, share.id, () => { begin(); return slow })
    await projecting
    await groups.revoke(alice, group.id, revoke, revoke === 'share' ? share.id : seat)
    if (revoke === 'member') {
      seat = await groups.invite(alice, group.id, bob, recipient)
      await groups.respond(bob, group.id, seat, 'accept')
    }
    finish([{ id: 'a' }])
    await assert.rejects(read, { code: 'not_found' })
  }
})

const flyerPath = html => new URL(html.match(/readonly value="([^"]+\/join\/[^"]+)"/)[1]).pathname
const startFlyer = async (b, organizer, mode, capacity = '5') => {
  const group = location(await b.post('/groups', organizer.cookie, { csrf: organizer.csrf, name: 'YC Fall 2026 collective network' }))
  location(await b.post(group + '/flyer', organizer.cookie, { csrf: organizer.csrf, capacity, mode }))
  const path = flyerPath(await show(await b.get(group, organizer.cookie)))
  return { group, path }
}

test('flyer HTTP: preview, sign-in and signup preserve the exact invite without joining; two accounts opt in; revoke rejects new joins', async t => {
  const b = await browser(t)
  const organizer = await b.login('alice')
  const { group, path } = await startFlyer(b, organizer, 'join')
  const id = group.split('/').at(-1)
  const campaign = path + '?src=yc-f26-flyer&utm_campaign=founders'
  const anonymous = await b.get(campaign)
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  assert.match(anonymous.headers.get('x-robots-tag'), /noindex/)
  const landing = await show(anonymous)
  assert.match(landing, /<h1 class="hq">YC Fall 2026 collective network<\/h1>/)
  assert.match(landing, new RegExp(encodeURIComponent(campaign)))
  assert.doesNotMatch(landing, /name="decision"|Reviewed set|Founder introductions|\balice\b/)
  assert.equal((await b.store.get(id)).members.length, 0)
  assert.equal((await b.post(campaign, undefined, { decision: 'join' })).status, 401)
  assert.equal((await b.get(campaign + '&src=other')).status, 404)
  assert.equal((await b.get(path + '?next=https%3A%2F%2Fevil.invalid')).status, 404)
  const newAccount = await b.login('new-founder', campaign)
  const existing = await b.login('bob', campaign)
  assert.equal(newAccount.destination, campaign)
  assert.equal(existing.destination, campaign)
  for (const member of [newAccount, existing]) {
    assert.match(await show(await b.get(campaign, member.cookie)), /Join this group/)
    assert.equal((await b.get(group, member.cookie)).status, 404)
  }
  assert.equal((await b.store.get(id)).members.length, 0)
  assert.equal((await b.post(campaign, newAccount.cookie, { csrf: 'wrong', decision: 'join' })).status, 400)
  for (const member of [newAccount, existing, newAccount]) {
    assert.equal(location(await b.post(campaign, member.cookie, { csrf: member.csrf, decision: 'join' })), group)
    assert.match(await show(await b.get(group, member.cookie)), /Private group · Member/)
    assert.equal((await b.get('/lists/' + b.saved.id, member.cookie)).status, 404)
  }
  const result = await b.store.get(id)
  assert.equal(result.members.length, 2)
  assert.match(await show(await b.get(campaign, existing.cookie)), /You’re a member of this collective network/)
  assert.deepEqual(result.members.map(member => member.flyer.source), Array(2).fill({ src: 'yc-f26-flyer', utm_campaign: 'founders' }))
  const ownerPage = await show(await b.get(group, organizer.cookie))
  assert.match(ownerPage, /3 of 5 seats used/)
  assert.equal(flyerPath(ownerPage), path)
  const revoke = ownerPage.match(/action="([^"]+\/flyer\/[^"]+\/revoke)"/)[1]
  location(await b.post(revoke, organizer.cookie, { csrf: organizer.csrf }))
  assert.equal((await b.get(campaign)).status, 404)
  const third = await b.login('carol')
  assert.equal((await b.post(campaign, third.cookie, { csrf: third.csrf, decision: 'join' })).status, 404)
  assert.equal((await b.get(group, third.cookie)).status, 404)
  assert.match(await show(await b.get(group, existing.cookie)), /Private group · Member/)
})

test('flyer capacity and organizer approval are applied before a seat grants access', async t => {
  const b = await browser(t)
  const organizer = await b.login('alice'), first = await b.login('bob'), second = await b.login('carol')
  const { group, path } = await startFlyer(b, organizer, 'approval', '2')
  const apply = member => b.post(path, member.cookie, { csrf: member.csrf, decision: 'join' })
  assert.match(await show(await apply(first)), /Request sent/)
  assert.match(await show(await b.get(path, first.cookie)), /Request sent/)
  assert.equal((await b.get(group, first.cookie)).status, 404)
  assert.equal((await apply(second)).status, 400)
  const html = await show(await b.get(group, organizer.cookie))
  const request = html.match(/action="([^"]+\/requests\/[^"]+)"/)[1]
  assert.equal((await b.post(request, second.cookie, { csrf: second.csrf, decision: 'approve' })).status, 404)
  location(await b.post(request, organizer.cookie, { csrf: organizer.csrf, decision: 'approve' }))
  assert.match(await show(await b.get(group, first.cookie)), /Private group · Member/)
  assert.equal((await apply(second)).status, 400)
  const remove = revokePath(await show(await b.get(group, organizer.cookie)), 'remove')
  location(await b.post(remove, organizer.cookie, { csrf: organizer.csrf }))
  assert.equal((await apply(first)).status, 404)
  assert.equal((await b.get(group, first.cookie)).status, 404)
})
