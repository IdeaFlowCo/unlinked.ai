import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { networkExportInput, streamNetworkExport } from '../mcp-server/network-export.mjs'
const person = id => ({ id, name: id, positions: [], education: [], skills: [], email: 'secret@example.invalid' })
const snapshot = () => ({ state: 'published', complete: true, revision: 'export-v1', profiles: ['alice', 'bob', 'carol', 'hidden'].map(person), members: ['alice', 'bob', 'carol'], connections: [{ fromId: 'alice', toId: 'bob' }, { fromId: 'bob', toId: 'carol' }, { fromId: 'alice', toId: 'hidden' }], connectionPrivacy: { alice: { audience: 'only_me', scope: 'all' } }, unlisted: [{ id: 'hidden' }] })
const response = () => {
  const chunks = [], stream = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(chunk.toString()); setImmediate(done) } })
  stream.writeHead = (status, headers) => { stream.status = status; stream.headers = headers }
  stream.rows = () => chunks.join('').trim().split('\n').map(line => JSON.parse(line))
  return stream
}
test('visible graph export is paginated, sanitizes profiles and uses the same directional privacy as browsing', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot(), pageSize: 1 })
  let cursor, profiles = [], edges = []
  do { const page = await reader.exportPage({ viewer: { signedIn: true, id: 'carol' }, cursor }); profiles.push(...page.profiles); edges.push(...page.connections); cursor = page.nextCursor } while (cursor)
  assert.deepEqual(profiles.map(p => p.id).sort(), ['alice', 'bob', 'carol'])
  assert.ok(profiles.every(p => !('email' in p)))
  assert.ok(!edges.some(e => e.fromId === 'alice'))
  assert.ok(edges.some(e => e.fromId === 'bob' && e.toId === 'carol'))
  const self = await reader.exportPage({ viewer: { signedIn: true, id: 'alice' }, ids: ['alice', 'bob'] })
  assert.ok(self.connections.some(e => e.fromId === 'alice' && e.toId === 'bob'))
  await assert.rejects(reader.exportPage({}), { status: 400 })
})
test('selected IDs and query intersect; unseen IDs never appear, and cursors bind the selection and viewer', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot(), pageSize: 1 }), viewer = { signedIn: true, id: 'alice' }
  const page = await reader.exportPage({ viewer, ids: ['bob', 'hidden', 'missing'] })
  assert.deepEqual(page.profiles.map(p => p.id), ['bob']); assert.equal(page.total, 1)
  const first = await reader.exportPage({ viewer })
  await assert.rejects(reader.exportPage({ viewer: { signedIn: true, id: 'bob' }, cursor: first.nextCursor }), { status: 400 })
  await assert.rejects(reader.exportPage({ viewer, ids: ['bob'], cursor: first.nextCursor }), { status: 400 })
  assert.equal((await reader.exportPage({ viewer, query: 'alice', ids: ['bob'] })).total, 0)
})
test('stream respects backpressure, verifies authorization repeatedly, and finishes with accurate totals', async () => {
  const res = response(), reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot(), pageSize: 1 })
  let checks = 0
  await streamNetworkExport({ response: res, input: { scope: 'everyone', query: '', ids: [] }, authorize: async () => { checks++ }, readPage: options => reader.exportPage({ ...options, viewer: { signedIn: true, id: 'alice' } }) })
  assert.equal(res.status, 200); assert.equal(res.rows()[0].type, 'export'); assert.equal(res.rows().at(-1).type, 'complete')
  assert.equal(res.rows().at(-1).profiles, 3); assert.ok(checks >= 5)
  assert.equal(res.headers['Cache-Control'], 'no-store, private')
})
test('revocation and publication changes never emit a completion footer', async () => {
  const res = response(); let checks = 0
  await assert.rejects(streamNetworkExport({ response: res, input: { scope: 'everyone', query: '', ids: [] }, authorize: async () => { if (++checks === 4) throw Error('revoked') }, readPage: async () => ({ revision: 'v1', profiles: [person('alice')], connections: [] }) }), /revoked/)
  assert.ok(!res.rows().some(row => row.type === 'complete'))
  const changed = response(); let reads = 0
  await assert.rejects(streamNetworkExport({ response: changed, input: { scope: 'everyone', query: '', ids: [] }, authorize: async () => {}, readPage: async () => ({ revision: ++reads === 1 ? 'v1' : 'v2', profiles: [], connections: [] }) }), /publication_changed/)
  assert.ok(!changed.rows().some(row => row.type === 'complete'))
})
test('owned export filters private observations without accessing the public graph; input is strict', async () => {
  const res = response()
  await streamNetworkExport({ response: res, input: { scope: 'mine', query: 'engineer', ids: [] }, authorize: async () => {}, readOwned: async () => ({ assertions: [{ id: 'a', fields: { position: 'Engineer' } }, { id: 'b', fields: { position: 'Artist' } }] }), readPage: () => { throw Error('wrong scope') } })
  assert.equal(res.rows().at(-1).observations, 1)
  assert.deepEqual(networkExportInput(new URLSearchParams('ids=alice,bob&scope=everyone')), { scope: 'everyone', query: '', ids: ['alice', 'bob'] })
  for (const input of ['scope=admin', 'ownerId=other', 'ids=bad%3Cscript', 'scope=mine&scope=everyone']) assert.throws(() => networkExportInput(new URLSearchParams(input)), /input_invalid/)
})
