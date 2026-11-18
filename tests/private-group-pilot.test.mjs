import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createNoosGroupRecords, groupRecordId } from '../mcp-server/private-group-records.mjs'
import { createPrivateGroupPilot } from '../mcp-server/private-group-pilot.mjs'
import { parseGroupRoster } from '../mcp-server/private-group-roster.mjs'
import { createCollectiveGroups } from '../mcp-server/collective-groups.mjs'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'
import { isLiveImport } from '../src/utils/private-import/noos-adapter.mjs'
import { createPrivateGroupBrowser } from '../mcp-server/private-group-browser.mjs'

const actor = id => ({ ownerId: id, userId: `${id}-user` })
const owner = actor('owner'), member = actor('member'), admin = actor('admin'), stranger = actor('stranger')
const row = (name = 'Fictional Founder') => ({ display_name: name, phone_hash: 'a'.repeat(64), participant_id: randomUUID() })
const bytes = rows => Buffer.from(JSON.stringify(rows))
function memoryBackend() {
  const rows = new Map(), calls = []
  return { rows, calls,
    async readResource(type, id) { calls.push(['read', type, id]); return structuredClone(rows.get(id) ?? null) },
    async writeBatch(items) { return this.writeImportBatch(items) },
    async writeImportBatch(items) {
      calls.push(['write', items.length])
      for (const item of items) {
        assert.equal(item.audience, 'owner')
        assert.equal(item.type, 'import')
        assert.ok(Buffer.byteLength(JSON.stringify(item)) < 64 * 1024)
        const old = rows.get(item.sourceId)
        if ((old?.sourceRevision ?? null) !== item.expectedRevision) throw Error('revision_conflict')
      }
      for (const item of items) rows.set(item.sourceId, structuredClone(item))
    },
  }
}
async function fixture({ enabled = true, allowedOwnerIds = ['owner'], memberBlocks } = {}) {
  const backend = memoryBackend(), store = createMemoryCollectiveGroupsStore(), active = new Set(['owner', 'admin', 'member', 'stranger'])
  const groups = createCollectiveGroups({ store, active: a => active.has(a.ownerId) && a.userId === actor(a.ownerId).userId })
  const group = await groups.create(owner, 'MIT Early-Stage Investors/Founders Group', 'owner-profile')
  const join = async who => {
    // Fixture represents an already accepted seat, not a roster-based join.
    await store.change(group.id, g => { g.members.push({ id: randomUUID(), actor: who, name: who.ownerId, profileId: who.ownerId + '-profile' }); return g })
  }
  await join(member); await join(admin)
  const pilot = createPrivateGroupPilot({ enabled, allowedOwnerIds, groups, memberBlocks, accountForProfile: async id => actor(id), groupOwner: async id => (await store.get(id))?.organizer,
    getBackend: async () => backend, active: async a => active.has(a.ownerId) && a.userId === actor(a.ownerId).userId })
  const records = createNoosGroupRecords({ backend, owner })
  return { pilot, group, groups, store, backend, active, records, join }
}
const keepPublished = async ids => new Map(ids.map(id => [id, { id, name: 'Fictional Founder', presence: id === 'p1' ? 'member' : 'profile' }]))
const notFound = promise => assert.rejects(promise, /not_found/)
async function importRows(f, rows) {
  const preview = await f.pilot.preview(owner, f.group.id, bytes(rows), 'json')
  await f.pilot.commit(owner, f.group.id, preview, 'retain_privately')
  return preview
}

test('Noos contract: owner/admin/member/nonmember isolation; no roster fields in joined projections', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  const node = await f.records.group(id), edges = await f.records.memberships(node)
  await f.records.publishGroup(id, { name: node.name }, edges.map(e => ({ actor: e.actor, name: e.name, profileId: e.profileId, role: e.actor.ownerId === 'admin' ? 'admin' : e.role })), node.revision)
  const imported = row('Private Secret Founder')
  await importRows(f, [imported])
  for (const who of [owner, admin, member]) {
    const detail = await f.pilot.detail(who, id)
    assert.equal(detail.members.length, 3)
    assert.equal(detail.owner, who === owner)
    assert.doesNotMatch(JSON.stringify(detail), /Private Secret Founder|phone_hash|pending|participant_id/)
  }
  for (const who of [admin, member, stranger, null, { ...owner, userId: 'forged' }]) {
    await notFound(f.pilot.roster(who, id))
    await notFound(f.pilot.preview(who, id, bytes([row()]), 'json'))
    await notFound(f.pilot.draft(who, id, imported.participant_id))
  }
  await notFound(f.pilot.detail(stranger, id))
  assert.equal((await f.pilot.roster(owner, id))[0].display_name, imported.display_name)
  assert.doesNotMatch(JSON.stringify(await f.pilot.roster(owner, id)), /phone_hash|aaaaaaaa/)
  for (const resource of f.backend.rows.values()) assert.equal(isLiveImport(resource, resource.sourceId, owner.ownerId), false)
})

test('flag, allowlist and absent Noos authorization fail closed without initialization', async () => {
  for (const settings of [{ enabled: false }, { allowedOwnerIds: [] }]) {
    const f = await fixture(settings)
    assert.equal(await f.pilot.available(owner, f.group.id), false)
    await notFound(f.pilot.enable(owner, f.group.id))
    assert.equal(f.backend.calls.length, 0)
  }
  const f = await fixture()
  await notFound(f.pilot.detail(owner, f.group.id))
  await assert.rejects(createPrivateGroupPilot({ enabled: true, allowedOwnerIds: ['owner'], groups: f.groups,
    groupOwner: async () => owner, active: async () => true, getBackend: async () => ({}) }).enable(owner, f.group.id), /group_backend_required/)
})

test('strict CSV/JSON rejects raw phones, nested/extra fields, malformed rows and duplicate identifiers', () => {
  const good = row(), noPhone = { ...row('Fictional Investor'), phone_hash: null }
  assert.deepEqual(parseGroupRoster(bytes([good, noPhone]), 'json'), [good, noPhone])
  const csv = `participant_id,display_name,phone_hash\r\n${good.participant_id},"Founder, Fictional",${good.phone_hash}\r\n${noPhone.participant_id},Fictional Investor,\r\n`
  assert.equal(parseGroupRoster(Buffer.from(csv), 'csv')[1].phone_hash, null)
  for (const bad of [[{ ...good, phone: '+15555550123' }], [{ ...good, display_name: '+1 (555) 555-0123' }], [{ ...good, phone_hash: '+15555550123' }],
    [{ ...good, participant_id: '15555550123@s.whatsapp.net' }], [good, good], [{ ...good, display_name: { raw: 'private' } }], [], [{ ...good, display_name: '' }]]) {
    assert.throws(() => parseGroupRoster(bytes(bad), 'json'), /invalid_roster/)
  }
  for (const bad of ['display_name,phone_hash,phone_hash\na,b,c', 'display_name,phone_hash,participant_id\n"unterminated', '\ufffd']) {
    assert.throws(() => parseGroupRoster(Buffer.from(bad), 'csv'), /invalid_roster/)
  }
  assert.throws(() => parseGroupRoster(Buffer.from([0xff]), 'json'), /invalid_roster/)
  assert.throws(() => parseGroupRoster(Buffer.alloc(2 * 1024 * 1024 + 1), 'json'), /invalid_roster/)
})

test('1,024 fictional rows publish in bounded chunks only after ack; stale previews and replay denied', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  const rows = Array.from({ length: 1024 }, (_, i) => ({ ...row(`Fictional Founder ${i}`), phone_hash: i === 1023 ? null : 'b'.repeat(64) }))
  const preview = await f.pilot.preview(owner, id, bytes(rows), 'json')
  assert.equal((await f.pilot.roster(owner, id)).length, 0)
  await assert.rejects(f.pilot.commit(owner, id, preview, ''), /acknowledgement_required/)
  await f.pilot.commit(owner, id, preview, 'retain_privately')
  assert.equal((await f.pilot.roster(owner, id)).length, 1024)
  const manifest = await f.records.rosterManifest(id)
  assert.equal(manifest.chunks.length, 41)
  assert.ok(f.backend.calls.filter(c => c[0] === 'write').every(c => c[1] <= 600))
  await assert.rejects(f.pilot.commit(owner, id, preview, 'retain_privately'), /review_changed/)
  const pending = await f.pilot.preview(owner, id, bytes([row()]), 'json')
  await f.join(actor('later')) // node reconcile invalidates preview even before later account is active
  f.active.add('later')
  await f.pilot.detail(owner, id)
  await assert.rejects(f.pilot.commit(owner, id, pending, 'retain_privately'), /review_changed/)
})

test('live revocation and source-owner fences prevent retained membership/roster reads', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id); await importRows(f, [row()])
  f.active.delete('owner')
  await notFound(f.pilot.detail(member, id)); await notFound(f.pilot.roster(owner, id))
  f.active.add('owner')
  await f.store.change(id, g => { g.members = g.members.filter(m => m.actor.ownerId !== 'member'); return g })
  await notFound(f.pilot.detail(member, id))
  const nodeId = groupRecordId(owner.ownerId, id, 'node')
  f.backend.rows.get(nodeId).sourceOwnerId = 'foreign'
  await notFound(f.pilot.roster(owner, id))
})

test('drafts never write or invite; name matches stay ambiguous and low confidence; jobs resume', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  const input = Array.from({ length: 26 }, () => row('Fictional Founder'))
  await importRows(f, input)
  let queries = 0
  const read = async query => { assert.equal(query, 'Fictional Founder'); queries++; return [{ id: 'p1', name: query, presence: 'member' }, { id: 'p2', name: query }] }
  const suggestions = await f.pilot.suggestions(owner, id, read, 0, keepPublished)
  assert.equal(suggestions.rows.length, 25); assert.equal(suggestions.nextOffset, 25)
  assert.ok(suggestions.rows.every(r => r.resolution.status === 'ambiguous' && r.resolution.candidates.every(c => c.confidence === 'low')))
  const before = f.backend.calls.filter(c => c[0] === 'write').length
  const draft = await f.pilot.draft(owner, id, input[0].participant_id)
  assert.match(draft.notice, /Nothing was sent/)
  assert.equal(f.backend.calls.filter(c => c[0] === 'write').length, before)
  assert.equal((await f.store.get(id)).invites.length, 0)
  assert.equal((await f.store.get(id)).members.length, 2)
  const first = await f.pilot.resolveNext(owner, id, read, keepPublished)
  assert.equal(first.cursor, 25); assert.equal(first.state, 'pending')
  const second = await f.pilot.resolveNext(owner, id, read, keepPublished)
  assert.equal(second.cursor, 26); assert.equal(second.state, 'complete')
  assert.equal((await f.pilot.resolveNext(owner, id, read, keepPublished)).revision, second.revision)
  assert.equal(queries, 51)
  await f.pilot.clear(owner, id, 'delete_pending_roster')
  assert.deepEqual(await f.pilot.roster(owner, id), [])
})

test('browser preview is owner/session bound; CSRF, ack, escaping and no-member roster leak', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  let clock = 1000
  const browser = createPrivateGroupBrowser({ pilot: f.pilot, now: () => clock, body: async req => Buffer.from(req.input) })
  const request = async (path, who = owner, fields, csrf = 'fixture') => {
    const request = { method: fields ? 'POST' : 'GET', input: fields ? new URLSearchParams(fields).toString() : '',
      headers: { origin: 'https://fixture.invalid', 'content-type': 'application/x-www-form-urlencoded' } }
    let response
    await browser.handle({ request, url: new URL(path, 'https://fixture.invalid'), session: { owner: who, csrf }, readCandidates: async () => [],
      render: (view, status = 200) => { response = { status, html: view.content } }, redirect: location => { response = { status: 303, location } } })
    return response
  }
  const input = row('<script>alert("fixture")</script>')
  assert.equal((await request(`/groups/${id}/roster`, member)).status, 404)
  assert.equal((await request(`/groups/${id}/roster/preview`, owner, { csrf: 'wrong', roster: JSON.stringify([input]), format: 'json' })).status, 400)
  const preview = await request(`/groups/${id}/roster/preview`, owner, { csrf: 'fixture', roster: JSON.stringify([input]), format: 'json' })
  assert.equal(preview.status, 200); assert.doesNotMatch(preview.html, /<script>alert/)
  assert.doesNotMatch(preview.html, /aaaaaaaa|phone_hash.*value=/)
  const token = preview.html.match(/name="review" value="([^"]+)"/)[1]
  const commit = { csrf: 'fixture', review: token, ack: 'retain_privately' }
  assert.equal((await request(`/groups/${id}/roster/commit`, owner, commit, 'different-session')).status, 400)
  assert.equal((await request(`/groups/${id}/roster/commit`, owner, commit)).status, 303)
  assert.equal((await request(`/groups/${id}/roster/commit`, owner, commit)).status, 409)
  const visible = await request(`/groups/${id}/private`, member)
  assert.equal(visible.status, 200); assert.doesNotMatch(visible.html, /pending roster|alert\(&quot;fixture/)
  assert.match(visible.html, /WhatsApp group \(ask Jacob for an invite\)/)
  clock += 11 * 60000
})

test('owner catalog journals interrupted stages; erasure includes superseded rows and fences delayed publication', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  await importRows(f, [row('Old Private Person')])
  await importRows(f, [row('New Private Person')])
  const beforeErase = await f.records.exportOwner()
  assert.equal(beforeErase[0].pendingRoster[0].display_name, 'New Private Person')
  const preview = await f.pilot.preview(owner, id, bytes([row('Delayed Person')]), 'json')
  await f.records.removeOwner()
  for (const r of f.backend.rows.values()) assert.equal(r.deleted, true, r.payload?.kind)
  await notFound(f.pilot.commit(owner, id, preview, 'retain_privately'))
  await f.records.removeOwner() // idempotent tombstones
})

test('atomic final publication failure exposes no provisional roster; deletion can erase staged chunks', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  const original = f.backend.writeImportBatch.bind(f.backend)
  f.backend.writeImportBatch = async items => {
    if (items.some(i => i.payload?.kind === 'group_roster_manifest')) throw Error('fixture_interrupted')
    return original(items)
  }
  const preview = await f.pilot.preview(owner, id, bytes(Array.from({ length: 26 }, () => row())), 'json')
  await assert.rejects(f.pilot.commit(owner, id, preview, 'retain_privately'), /fixture_interrupted/)
  assert.deepEqual(await f.pilot.roster(owner, id), [])
  f.backend.writeImportBatch = original
  await f.records.removeOwner()
  assert.ok([...f.backend.rows.values()].every(r => r.deleted))
})

test('WhatsApp link refresh stays inside joined projection and rejects arbitrary destinations', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  await f.groups.updateMetadata(owner, id, { description: 'Fictional fixture', chatUrl: 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV', openChatUrl: '' })
  assert.match((await f.pilot.detail(member, id)).externalLink, /^https:\/\/chat.whatsapp.com\//)
  await notFound(f.pilot.detail(stranger, id))
  const node = await f.records.group(id)
  await assert.rejects(f.records.publishGroup(id, { name: node.name, chatUrl: 'javascript:alert(1)' }, await f.records.memberships(node), node.revision), /invalid_chat_url/)
})

test('Noos adapter transport preserves owner audience and CAS for group records', async () => {
  const { createNoosOwnerBackend } = await import('../src/utils/private-import/noos-adapter.mjs')
  const backing = memoryBackend(), seen = []
  const backend = createNoosOwnerBackend({ baseUrl: 'https://noos.fixture.invalid/v1', ownerId: owner.ownerId, accessToken: 'fictional-not-a-secret',
    fetchImpl: async (url, options = {}) => {
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.Authorization, 'Bearer fictional-not-a-secret')
      const path = new URL(url).pathname
      seen.push([options.method ?? 'GET', path])
      if (path.endsWith('/batch')) {
        await backing.writeImportBatch(JSON.parse(options.body))
        return new Response('{}', { status: 200 })
      }
      const value = await backing.readResource('import', path.split('/').at(-1))
      return value ? Response.json(value) : new Response(null, { status: 404 })
    } })
  const records = createNoosGroupRecords({ backend, owner }), id = randomUUID()
  await records.publishGroup(id, { name: 'Transport fixture' }, [{ actor: owner, name: 'Fixture owner', role: 'owner' }], null)
  assert.equal((await records.group(id)).name, 'Transport fixture')
  assert.ok(seen.every(([, path]) => path.startsWith('/v1/unlinked/')))
  assert.equal((await records.memberships(await records.group(id)))[0].role, 'owner')
})

test('prepared file picker loads ordinary CSV locally and emits no upload', async () => {
  const { renderPrivateGroup } = await import('../mcp-server/private-group-views.mjs')
  const view = renderPrivateGroup({}, { id: randomUUID(), name: 'Fixture', tags: [], members: [] })
  let listener
  const fields = { format: { value: '' }, roster: { value: '' } }, status = {}
  const picker = { form: { elements: fields }, files: [{ name: 'prepared.csv', size: 200,
    text: async () => '\uFEFFdisplay_name,phone_hash,participant_id\r\nFictional,,' }], addEventListener: (event, callback) => { listener = callback } }
  const document = { querySelector: () => picker, getElementById: () => status }
  new Function('document', view.script)(document)
  await listener()
  assert.equal(fields.format.value, 'csv'); assert.match(fields.roster.value, /Fictional/)
  assert.match(status.textContent, /loaded locally/)
  picker.files[0].text = async () => 'display_name,phone,participant_id\nFictional,+15555550123,id'
  await listener(); assert.equal(fields.roster.value, '')
})

test('standalone HTTP: pilot extends existing groups, disabled paths 404, and member-only URLs stay private', async t => {
  const { createServer } = await import('node:http')
  const { createPrivateBrowserHandler } = await import('../mcp-server/private-browser.mjs')
  const f = await fixture(), id = f.group.id
  const backend = { ...f.backend, adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [] }
  const options = { collectiveGroups: f.groups, privateGroupPilot: f.pilot,
    login: { begin: async () => ({ location: 'https://identity.invalid', transaction: { state: 'fixture' } }),
      finish: async url => ({ issuer: 'https://identity.invalid', subject: url.searchParams.get('code') }) },
    resolveOwner: async identity => actor(identity.subject), signup: async identity => actor(identity.subject),
    issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {}, getBackend: async () => backend,
    selfClaims: { lookupSlug: async () => null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    accountForProfile: async () => null, ownProfileId: async a => a.ownerId + '-profile',
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'fixture',
      profiles: [{ id: 'fictional-person', name: 'Fictional Founder', headline: 'Fixture', positions: [], education: [], skills: [] }], connections: [] }),
  }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const get = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const post = (path, cookie, fields) => fetch(endpoint + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  handler = createPrivateBrowserHandler({ ...options, baseUrl, privateGroupPilot: undefined })
  assert.equal((await get(`/groups/${id}/roster`)).status, 404)
  handler = createPrivateBrowserHandler({ ...options, baseUrl })
  const login = async who => {
    const start = await get('/login'), transaction = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await get('/auth/callback/ideaflow?state=fixture&code=' + who, transaction)
    const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
    const html = await (await get('/groups', cookie)).text()
    return { cookie, csrf: html.match(/name="csrf" value="([^"]+)"/)[1] }
  }
  const own = await login('owner'), joined = await login('member'), outside = await login('stranger')
  const enable = await post(`/groups/${id}/private/enable`, own.cookie, { csrf: own.csrf })
  assert.equal(enable.status, 303)
  const privatePage = await get(`/groups/${id}/private`, joined.cookie)
  assert.equal(privatePage.status, 200); assert.equal(privatePage.headers.get('cache-control'), 'no-store')
  assert.match(await privatePage.text(), /WhatsApp group \(ask Jacob for an invite\)/)
  assert.equal((await get(`/groups/${id}/private`, outside.cookie)).status, 404)
  assert.equal((await get(`/groups/${id}/roster`, joined.cookie)).status, 404)
  const input = row()
  const preview = await post(`/groups/${id}/roster/preview`, own.cookie, { csrf: own.csrf, format: 'json', roster: JSON.stringify([input]) })
  assert.equal(preview.status, 200)
  const html = await preview.text(), review = html.match(/name="review" value="([^"]+)"/)[1]
  assert.equal((await post(`/groups/${id}/roster/commit`, own.cookie, { csrf: own.csrf, review, ack: 'retain_privately' })).status, 303)
  const roster = await get(`/groups/${id}/roster`, own.cookie)
  assert.equal(roster.status, 200)
  assert.match(await roster.text(), /fictional-person/)
  assert.equal((await f.store.get(id)).invites.length, 0)
})

test('account cleanup of an absent group catalog requires no write capability', async () => {
  const records = createNoosGroupRecords({ backend: { readResource: async () => null }, owner })
  await records.removeOwner()
})

test('phone names reject Unicode separators/digits and group revocation during staging prevents final publication', async () => {
  for (const name of ['+1–555–555–0123', '+１．５５５．５５５．０１２３', '١٥٥٥٥٥٥٠١٢٣', '+1☎555☎555☎0123']) {
    assert.throws(() => parseGroupRoster(bytes([row(name)]), 'json'), /invalid_roster/)
  }
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id)
  const original = f.backend.writeImportBatch.bind(f.backend)
  f.backend.writeImportBatch = async items => {
    await original(items)
    if (items.some(i => i.payload?.kind === 'group_pending_roster_edges')) await f.store.change(id, () => null)
  }
  const preview = await f.pilot.preview(owner, id, bytes([row()]), 'json')
  await notFound(f.pilot.commit(owner, id, preview, 'retain_privately'))
  assert.equal(await f.records.rosterManifest(id), null)
})

test('name candidates exclude live outgoing-profile and incoming-account blocks; failures fail closed', async () => {
  const { filterGroupCandidates } = await import('../mcp-server/private-group-roster.mjs')
  const profiles = [{ id: 'outgoing', name: 'Fictional' }, { id: 'incoming', name: 'Fictional' }, { id: 'visible', name: 'Fictional' }]
  const memberBlocks = { list: async () => [{ blockedProfileId: 'outgoing' }], between: async (_, other) => other.ownerId === 'incoming' }
  const result = await filterGroupCandidates({ profiles, owner, memberBlocks, accountForProfile: async id => actor(id) })
  assert.deepEqual(result.map(p => p.id), ['visible'])
  await assert.rejects(filterGroupCandidates({ profiles, owner, memberBlocks: { ...memberBlocks, list: async () => { throw Error('fixture_unavailable') } }, accountForProfile: async id => actor(id) }), /fixture_unavailable/)
})

test('service refreshes two-way candidate blocks after the batch before showing name suggestions', async () => {
  let blocked = false, queries = 0
  const memberBlocks = { list: async () => [], between: async () => blocked }
  const f = await fixture({ memberBlocks }), id = f.group.id
  await f.pilot.enable(owner, id); await importRows(f, [row(), row()])
  const result = await f.pilot.suggestions(owner, id, async () => {
    if (++queries === 2) blocked = true
    return [{ id: 'candidate', name: 'Fictional Founder', presence: 'member' }]
  }, 0, keepPublished)
  assert.ok(result.rows.every(r => r.resolution.candidates.length === 0 && r.resolution.status === 'unmatched'))
})

test('final name projection removes unpublished candidates and follows current merged profile values', async () => {
  const f = await fixture(), id = f.group.id
  await f.pilot.enable(owner, id); await importRows(f, [row(), row()])
  let queries = 0, removed = false
  const search = async () => {
    if (++queries % 2 === 0) removed = true
    return [{ id: 'removed-profile', name: 'Fictional Founder' }, { id: 'old-id', name: 'Fictional Founder' }]
  }
  const lookup = async ids => {
    assert.equal(removed, true)
    assert.deepEqual(ids.sort(), ['old-id', 'removed-profile'])
    return new Map([['old-id', { id: 'merged-id', name: 'Current Public Name', presence: 'member' }]])
  }
  const result = await f.pilot.suggestions(owner, id, search, 0, lookup)
  assert.ok(result.rows.every(r => r.resolution.candidates.length === 1 && r.resolution.candidates[0].profileId === 'merged-id' && r.resolution.candidates[0].name === 'Current Public Name' && r.resolution.candidates[0].presence === 'member'))
  const job = await f.pilot.resolveNext(owner, id, search, lookup)
  assert.equal(job.state, 'complete')
  for (const resource of f.backend.rows.values()) if (resource.payload?.kind === 'group_resolution_results') assert.doesNotMatch(JSON.stringify(resource), /removed-profile|old-id/)
})


test('roster is an owner-only add-on to the exact collective group, with no second group navigation', async () => {
  const f = await fixture(), id = f.group.id
  const browser = createPrivateGroupBrowser({ pilot: f.pilot })
  await f.pilot.enable(owner, id)
  const detail = await f.pilot.detail(owner, id)
  assert.equal(detail.id, id)
  assert.equal(detail.name, 'MIT Early-Stage Investors/Founders Group')
  assert.match(await browser.navigation(owner, id, {}), new RegExp(`/groups/${id}/roster`))
  assert.equal(await browser.navigation(member, id, {}), '')
  assert.equal(await browser.navigation(stranger, id, {}), '')
  const before = await f.groups.roster(owner, id)
  await f.pilot.preview(owner, id, bytes([row()]), 'json')
  assert.deepEqual(await f.groups.roster(owner, id), before)
  assert.equal((await f.pilot.roster(owner, id)).length, 0)
})
