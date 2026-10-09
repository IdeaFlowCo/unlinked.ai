import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { ACCOUNT_GRANT_TOOL_VERSIONS, ACCOUNT_WRITE_TOOLS, CURRENT_ACCOUNT_GRANT_VERSION, PRIVATE_NOTES_TOOLS, accountGrantTools, composeAccountScope, effectiveAccountGrant, parseAccountScope } from '../mcp-server/account-grants.mjs'
import { PRIVATE_NOTES_DESCRIPTIONS } from '../mcp-server/private-notes-tools.mjs'

// unlinked-9kk.5 (W3): the direct Unlinked key gains private people notes &
// relations through the Noos overlay, under a separate default-on permission.
const sha = value => createHash('sha256').update(value).digest('hex')
const BASE = ['owner_network', 'owner_network_and_public', 'owner_network_and_write', 'owner_network_and_public_and_write']

test('catalog v7: historical entries unchanged; every base scope keeps v6 tools and gains a private-notes twin', () => {
  assert.equal(CURRENT_ACCOUNT_GRANT_VERSION, 7)
  // Frozen history: v6 = v5 + lookup, and v7 base scopes equal v6 exactly.
  for (const scope of BASE) {
    assert.deepEqual(ACCOUNT_GRANT_TOOL_VERSIONS[6][scope].filter(name => name !== 'unlinked_lookup_contact'), [...ACCOUNT_GRANT_TOOL_VERSIONS[5][scope]])
    assert.deepEqual(accountGrantTools(7, scope), accountGrantTools(6, scope))
    assert.deepEqual(accountGrantTools(7, `${scope}_and_private_notes`), [...accountGrantTools(6, scope), ...PRIVATE_NOTES_TOOLS])
    for (const version of [1, 2, 3, 4, 5, 6]) assert.equal(accountGrantTools(version, `${scope}_and_private_notes`), null)
  }
  assert.equal(Object.keys(ACCOUNT_GRANT_TOOL_VERSIONS[7]).length, 8)
  for (const scope of Object.keys(ACCOUNT_GRANT_TOOL_VERSIONS[7])) assert.equal(composeAccountScope(parseAccountScope(scope)), scope)
  // Descriptions state the privacy contract the issue asks for.
  for (const name of PRIVATE_NOTES_TOOLS) {
    assert.match(PRIVATE_NOTES_DESCRIPTIONS[name], /Owner-only private knowledge/)
    assert.match(PRIVATE_NOTES_DESCRIPTIONS[name], /NOT a connection request and NOT messaging/)
    assert.match(PRIVATE_NOTES_DESCRIPTIONS[name], /Unlinked .*OpenChat/)
  }
})

test('historical keys gain private notes (default on) but never connection writes; OAuth connections need consent', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) for (const scope of Object.keys(ACCOUNT_GRANT_TOOL_VERSIONS[version])) {
    const stored = { version, scope, tools: [...accountGrantTools(version, scope)] }
    const key = effectiveAccountGrant(stored)
    assert.equal(key.version, 7)
    assert.ok(PRIVATE_NOTES_TOOLS.every(name => key.tools.includes(name)), `${version}/${scope} key gains private notes`)
    assert.equal(ACCOUNT_WRITE_TOOLS.some(name => key.tools.includes(name)), parseAccountScope(scope).write, `${version}/${scope} never gains connection writes`)
    const oauth = effectiveAccountGrant({ ...stored, connection: { kind: 'oauth', app: 'Claude' } })
    assert.equal(oauth.scope, scope)
    assert.ok(!PRIVATE_NOTES_TOOLS.some(name => oauth.tools.includes(name)), `${version}/${scope} OAuth grant needs re-consent`)
  }
  // A v7 record says exactly what it has: off stays off.
  assert.deepEqual(effectiveAccountGrant({ version: 7, scope: 'owner_network_and_public', tools: [...accountGrantTools(7, 'owner_network_and_public')] }).scope, 'owner_network_and_public')
  // Malformed records stay unauthorized.
  assert.equal(effectiveAccountGrant({ version: 6, scope: 'owner_network_and_private_notes', tools: [] }), null)
})

// ---- service-level behaviour against an in-memory stand-in for Noos /api/overlay ----
const owner = { ownerId: 'synthetic-notes-owner', userId: 'synthetic-notes-user' }
const other = { ownerId: 'synthetic-notes-other', userId: 'synthetic-notes-other-user' }
const identities = new Map([[owner.ownerId, { issuer: 'https://id.example', subject: 'subject-owner' }], [other.ownerId, { issuer: 'https://id.example', subject: 'subject-other' }]])
const row = (id, first, last, url) => ({ id, ownerId: owner.ownerId, importId: sha('import'), sourceId: sha('raw'), rowId: `Connections.csv#${id.slice(0, 4)}`, category: 'connections',
  fields: { 'first name': first, 'last name': last, url, company: 'Synthetic Co', position: 'Engineer' }, provenance: { source: 'recovered-legacy-storage-v1' } })
const alice = row(sha('alice'), 'Alice', 'Synthetic', 'https://www.linkedin.com/in/synthetic-alice')
const bob = row(sha('bob'), 'Bob', 'Synthetic', 'https://www.linkedin.com/in/synthetic-bob')
const backendFor = who => ({ listImportIds: async () => [], readLegacyFiles: async () => null,
  readLegacyObservations: async () => (who.ownerId === owner.ownerId ? { assertions: [alice, bob] } : { assertions: [] }), readMemberConnections: async () => [] })

function fakeOverlay() {
  const owners = new Map(), calls = []
  let next = 0
  const state = identity => { const key = `${identity.issuer}\n${identity.subject}`; if (!owners.has(key)) owners.set(key, { entities: new Map(), refs: new Map(), notes: new Map(), links: new Map() }); return owners.get(key) }
  const refsOf = (s, entity) => [...s.refs].filter(([, id]) => id === entity.id).map(([ref]) => ref)
  const detail = (s, entity) => ({ ...entity, refs: refsOf(s, entity),
    notes: [...s.notes.values()].filter(note => note.entityId === entity.id),
    links: [...s.links.values()].filter(link => link.fromId === entity.id || link.toId === entity.id).map(link => ({ ...link, direction: link.fromId === entity.id ? 'out' : 'in', other: (end => ({ ...end, refs: refsOf(s, end) }))(s.entities.get(link.fromId === entity.id ? link.toId : link.fromId)) })) })
  const make = (s, kind, name) => { const entity = { id: `e${++next}`, kind, name, card: {} }; s.entities.set(entity.id, entity); return entity }
  return { calls, owners, async request(identity, method, path, body) {
    calls.push({ identity, method, path, body })
    const s = state(identity), url = new URL(path, 'https://overlay.invalid/')
    const parts = url.pathname.slice(1).split('/')
    if (method === 'POST' && path === 'lookup') { const id = s.refs.get(body.ref); return id ? { status: 200, body: { entity: detail(s, s.entities.get(id)) } } : { status: 404, body: { error: 'not_found' } } }
    if (method === 'POST' && path === 'entities') {
      if (body.refs) {
        const existing = body.refs.map(ref => s.refs.get(ref)).find(Boolean)
        const entity = existing ? s.entities.get(existing) : make(s, body.kind, body.name)
        for (const ref of body.refs) if (!s.refs.has(ref)) s.refs.set(ref, entity.id)
        return { status: existing ? 200 : 201, body: { entity, created: !existing, unattached: [] } }
      }
      const same = [...s.entities.values()].filter(entity => entity.kind === body.kind && entity.name === body.name && ![...s.refs.values()].includes(entity.id))
      if (body.createNew) { const ref = `unlinked:private:${sha(body.clientRequestId).slice(0, 32)}`; const id = s.refs.get(ref); const entity = id ? s.entities.get(id) : make(s, body.kind, body.name); s.refs.set(ref, entity.id); return { status: 201, body: { entity, created: !id } } }
      if (same.length > 1) return { status: 409, body: { error: 'ambiguous_name', candidates: same.map(entity => ({ ...entity, refs: [] })) } }
      if (same.length === 1) return { status: 200, body: { entity: same[0], created: false } }
      return { status: 201, body: { entity: make(s, body.kind, body.name), created: true } }
    }
    if (parts[0] === 'entities' && parts.length === 2 && method === 'GET') { const entity = s.entities.get(parts[1]); return entity ? { status: 200, body: { entity: detail(s, entity) } } : { status: 404, body: { error: 'not_found' } } }
    if (parts[0] === 'entities' && parts.length === 1 && method === 'GET') return { status: 200, body: { entities: [...s.entities.values()].map(entity => detail(s, entity)) } }
    if (parts[0] === 'entities' && parts[2] === 'notes') {
      if (!s.entities.has(parts[1])) return { status: 404, body: { error: 'not_found' } }
      const found = [...s.notes.values()].find(note => note.entityId === parts[1] && note.text === body.text)
      if (found) return { status: 200, body: { note: found, created: false } }
      const note = { id: `n${++next}`, entityId: parts[1], text: body.text, ...body.provenance }; s.notes.set(note.id, note); return { status: 201, body: { note, created: true } }
    }
    if (parts[0] === 'entities' && parts[2] === 'links') {
      if (!s.entities.has(parts[1]) || !s.entities.has(body.toId)) return { status: 404, body: { error: 'not_found' } }
      const found = [...s.links.values()].find(link => link.fromId === parts[1] && link.toId === body.toId && link.relation === body.relation)
      if (found) return { status: 200, body: { link: found, created: false } }
      const link = { id: `l${++next}`, fromId: parts[1], toId: body.toId, relation: body.relation, relationType: body.relation === 'knows' ? 'knows' : 'other', ...body.provenance }
      s.links.set(link.id, link); return { status: 201, body: { link: { ...link, direction: 'out', other: s.entities.get(body.toId) }, created: true } }
    }
    if (parts[0] === 'search') return { status: 200, body: { entities: [], links: [...s.links.values()].filter(link => link.relation.includes(url.searchParams.get('q') ?? '')).map(link => ({ ...link, from: s.entities.get(link.fromId), to: s.entities.get(link.toId) })), truncated: false } }
    if (parts[0] === 'links' && method === 'DELETE') return s.links.delete(parts[1]) ? { status: 204, body: null } : { status: 404, body: { error: 'not_found' } }
    if (parts[0] === 'notes' && method === 'DELETE') return s.notes.delete(parts[1]) ? { status: 204, body: null } : { status: 404, body: { error: 'not_found' } }
    if (parts[0] === 'entities' && method === 'DELETE') { if (!s.entities.delete(parts[1])) return { status: 404, body: { error: 'not_found' } }; return { status: 200, body: { deleted: true, notesRemoved: 0, linksRemoved: 0, refsRemoved: 0 } } }
    return { status: 404, body: { error: 'not_found' } }
  } }
}

const setup = ({ identityFor = async who => identities.get(who.ownerId) ?? null } = {}) => {
  const overlay = fakeOverlay()
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'notes-fixture', connections: [], profiles: [] })
  const service = createAccountToolService({ getBackend: async who => backendFor(who), readPublishedSnapshot, overlay, identityFor })
  return { overlay, service }
}
const grantFor = (who, scope = 'owner_network_and_private_notes', agent = 'Muse') => ({ ...who, agent, scope, version: 7, tools: [...accountGrantTools(7, scope)] })
const call = (service, name, input, grant = grantFor(owner)) => service.call({ grant, name, input }).then(value => value.result)

test('records "X knows Y" between two imported contacts with refs from the owner import and agent provenance', async () => {
  const { overlay, service } = setup()
  const added = await call(service, 'unlinked_add_private_link', { subjectKind: 'unlinked', subjectId: alice.id, relation: 'knows', toKind: 'unlinked', toId: 'https://www.linkedin.com/in/synthetic-bob' })
  assert.equal(added.created, true)
  assert.equal(added.visibility, 'owner_private')
  assert.equal(added.from.connectionId, alice.id)
  assert.equal(added.to.linkedinRefHash, sha('synthetic-bob'))
  // Refs come only from the owner's own import: linkedin:in:<sha256(slug)>, never a plaintext address.
  const ensures = overlay.calls.filter(value => value.path === 'entities' && value.body?.refs)
  assert.deepEqual(ensures.map(value => value.body.refs), [[`linkedin:in:${sha('synthetic-alice')}`], [`linkedin:in:${sha('synthetic-bob')}`]])
  assert.ok(!JSON.stringify(overlay.calls).includes('linkedin.com/in/'))
  const write = overlay.calls.find(value => value.path.endsWith('/links'))
  assert.deepEqual(write.body.provenance, { author: 'agent:Muse', source: 'direct-key', assertion: 'stated' })
  // Idempotent: the overlay owns it, retries return the same link.
  const again = await call(service, 'unlinked_add_private_link', { subjectKind: 'unlinked', subjectId: alice.id, relation: 'knows', toKind: 'unlinked', toId: bob.id })
  assert.equal(again.created, false)
  // Read back through the person card, by connection id and by LinkedIn address.
  const card = await call(service, 'unlinked_get_person_private', { profileId: alice.id })
  assert.equal(card.person.connectionId, alice.id)
  assert.equal(card.entities.length, 1)
  assert.equal(card.entities[0].links[0].relation, 'knows')
  assert.equal(card.entities[0].links[0].other.connectionId, bob.id)
  assert.equal(card.entities[0].links[0].author, 'agent:Muse')
  assert.ok(!('refs' in card.entities[0]))
  const found = await call(service, 'unlinked_search_private', { query: 'knows' })
  assert.equal(found.links.length, 1)
  // Notes carry inferred when the agent says so.
  const note = await call(service, 'unlinked_add_private_note', { subjectKind: 'unlinked', subjectId: bob.id, text: 'Met at a synthetic dinner', assertion: 'inferred' })
  assert.equal(note.note.assertion, 'inferred')
  assert.equal(note.note.source, 'direct-key')
  await call(service, 'unlinked_delete_private_note', { noteId: note.note.id })
  await call(service, 'unlinked_delete_private_link', { linkId: added.link.id })
  assert.equal((await call(service, 'unlinked_get_person_private', { profileId: alice.id })).entities[0].links.length, 0)
})

test('privacy: another owner cannot name the first owner contacts and sees an empty overlay', async () => {
  const { overlay, service } = setup()
  await call(service, 'unlinked_add_private_note', { subjectKind: 'unlinked', subjectId: alice.id, text: 'Synthetic private fact' })
  const grant = grantFor(other)
  await assert.rejects(service.call({ grant, name: 'unlinked_get_person_private', input: { profileId: alice.id } }), error => error.code === 'not_found')
  await assert.rejects(service.call({ grant, name: 'unlinked_add_private_note', input: { subjectKind: 'unlinked', subjectId: alice.id, text: 'x' } }), error => error.code === 'not_found')
  assert.deepEqual((await service.call({ grant, name: 'unlinked_list_private_things', input: {} })).result.entities, [])
  // Every overlay call is made as the grant owner's own verified identity.
  assert.ok(overlay.calls.every(value => ['subject-owner', 'subject-other'].includes(value.identity.subject)))
  assert.ok(overlay.calls.filter(value => value.identity.subject === 'subject-other').every(value => value.method === 'GET'))
})

test('permission and identity gates: off keys are refused; no Ideaflow identity is typed; ambiguity is returned to ask the user', async () => {
  const { service } = setup()
  const off = grantFor(owner, 'owner_network')
  await assert.rejects(service.call({ grant: off, name: 'unlinked_search_private', input: { query: 'x' } }), error => error.code === 'scope_not_granted' && error.status === 403)
  // Even a forged tool list cannot bypass the scope check.
  await assert.rejects(service.call({ grant: { ...off, tools: [...off.tools, 'unlinked_search_private'] }, name: 'unlinked_search_private', input: { query: 'x' } }), error => error.code === 'scope_not_granted')
  const { service: noIdentity } = setup({ identityFor: async () => null })
  await assert.rejects(noIdentity.call({ grant: grantFor(owner), name: 'unlinked_list_private_things', input: {} }), error => error.code === 'identity_unavailable')
  const unconfigured = createAccountToolService({ getBackend: async who => backendFor(who) })
  await assert.rejects(unconfigured.call({ grant: grantFor(owner), name: 'unlinked_list_private_things', input: {} }), error => error.code === 'upstream_unavailable')
  await call(service, 'unlinked_save_private_thing', { kind: 'person', name: 'Maya' })
  await call(service, 'unlinked_save_private_thing', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'second-maya' })
  // The ref-less Maya plus a createNew one: the stand-in reports ambiguity only for ref-less matches.
  const third = await call(service, 'unlinked_save_private_thing', { kind: 'person', name: 'Maya' })
  assert.equal(third.created, false)
  await assert.rejects(service.call({ grant: grantFor(owner), name: 'unlinked_save_private_thing', input: { kind: 'person', name: 'Maya', createNew: true } }), error => error.code === 'invalid_input')
  await assert.rejects(service.call({ grant: grantFor(owner), name: 'unlinked_add_private_link', input: { subjectKind: 'thing', subjectId: third.entity.id, relation: 'knows', toKind: 'person' } }), error => error.code === 'invalid_input')
  // An OpenChat person the owner never wrote about: empty, never created.
  assert.deepEqual((await call(service, 'unlinked_get_neighbourhood', { subjectKind: 'user', subjectId: 'oc-user' })).entities, [])
})

test('ambiguous names come back with the owner candidates', async () => {
  const { overlay, service } = setup()
  const identity = identities.get(owner.ownerId)
  await overlay.request(identity, 'POST', 'entities', { kind: 'person', name: 'Sam' })
  const state = [...overlay.owners.values()][0]
  state.entities.set('dup', { id: 'dup', kind: 'person', name: 'Sam', card: {} })
  await assert.rejects(service.call({ grant: grantFor(owner), name: 'unlinked_add_private_link', input: { subjectKind: 'unlinked', subjectId: alice.id, relation: 'knows', toKind: 'person', toName: 'Sam' } }),
    error => error.code === 'ambiguous_name' && error.status === 409 && error.details.candidates.length === 2 && error.details.candidates.every(value => value.name === 'Sam' && !('refs' in value)))
})
