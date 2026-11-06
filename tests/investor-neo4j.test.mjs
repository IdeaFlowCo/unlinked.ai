import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fixture } from './helpers/investor-fixture.mjs'
const moduleRoot = process.env.UNLINKED_TEST_NOOS_MODULE_ROOT
const uri = process.env.NOOS_OPERATIONAL_TEST_URI
// Opt-in only via Noos scripts/test-operational.mjs, which owns a disposable
// synthetic DB. No .env or production credentials are loaded by this test.
test('investor CSV executes through real Neo4j overlay with >500 members and paged connector reads', { skip: !moduleRoot || !uri }, async t => {
  assert.match(uri, /^bolt:\/\/127\.0\.0\.1:\d+$/)
  const { default: neo4j } = await import(pathToFileURL(`${moduleRoot}/node_modules/neo4j-driver/lib/index.js`))
  const { OverlayStore } = await import(pathToFileURL(`${moduleRoot}/src/overlay/store.ts`))
  const { ownerKeyFor } = await import(pathToFileURL(`${moduleRoot}/src/overlay/contract.ts`))
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', 'synthetic-contract-only'))
  t.after(() => driver.close())
  const store = new OverlayStore(driver, 'neo4j'); await store.initialize()
  const overlay = { async request(identity, method, path, body) {
    const principal = { app: 'unlinked', ownerKey: ownerKeyFor(identity.issuer, identity.subject) }
    const url = new URL(path, 'https://synthetic.invalid/'), parts = url.pathname.split('/').filter(Boolean)
    try {
      let result
      if (path === 'lookup') { const entity = await store.lookup(principal, body.ref); return entity ? { status: 200, body: { entity } } : { status: 404, body: { error: 'not_found' } } }
      if (path === 'entities' && method === 'POST') result = body.refs ? await store.ensureRefs(principal, body) : await store.resolve(principal, body)
      else if (parts[0] === 'entity-pages') result = await store.listPage(principal, Object.fromEntries(url.searchParams))
      else if (parts[2] === 'link-pages') result = await store.linksPage(principal, parts[1], Object.fromEntries(url.searchParams))
      else if (parts[2] === 'notes') result = await store.addNote(principal, parts[1], body.text, body.provenance)
      else if (parts[2] === 'links') result = await store.addLink(principal, parts[1], body.relation, body.toId, body.provenance, { context: body.context })
      else if (parts.length === 2 && method === 'GET') result = { entity: await store.get(principal, parts[1]) }
      else throw Error('unexpected_test_route')
      return { status: 200, body: result }
    } catch (error) { if (error.status) return { status: error.status, body: { error: error.code } }; throw error }
  } }
  const f = fixture(overlay), tools = f.tools(), grant = { ownerId: 'real-csv', userId: 'real-csv', agent: 'synthetic' }
  const csv = 'Name,Comment\n' + Array.from({ length: 503 }, (_, i) => `Investor ${i},Private comment ${i}`).join('\n')
  const staged = await tools.unlinked_stage_investor_csv(grant, { csv, mapping: { name: 'Name', notes: ['Comment'] }, listName: '503 synthetic investors' })
  let status
  do { status = await tools.unlinked_resume_investor_import(grant, { importId: staged.importId, batchSize: 25 }) } while (status.status === 'processing')
  assert.equal(status.status, 'complete'); assert.equal(status.imported, 503)
  const lists = await tools.unlinked_list_private_things(grant, { kind: 'list', limit: 100 })
  assert.deepEqual(lists.entities.map(e => e.id), [status.listId])
  let after, members = new Set()
  do {
    const page = await tools.unlinked_get_private_thing(grant, { thingId: status.listId, limit: 73, after })
    for (const edge of page.entity.links) { assert.equal(edge.relation, 'contains'); assert.equal(edge.relationType, 'related'); assert.ok(!members.has(edge.other.id)); members.add(edge.other.id) }
    after = page.nextCursor ?? undefined
  } while (after)
  assert.equal(members.size, 503)
  const other = { ...grant, ownerId: 'foreign', userId: 'foreign' }
  assert.deepEqual((await tools.unlinked_list_private_things(other, { kind: 'list', limit: 100 })).entities, [])
  await assert.rejects(tools.unlinked_get_private_thing(other, { thingId: status.listId, limit: 73 }), e => e.code === 'not_found')
})
