// The public People index worker (src/utils/public-people/index-host.mjs):
// readers answer exactly as in-process, photos stay resolved on the main
// thread, a lost worker is replaced, and a worker that cannot start leaves
// readers compiling in-process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { activePublicIndexHost, createPublicIndexHost, installPublicIndexHost } from '../src/utils/public-people/index-host.mjs'

const person = (id, name, extra = {}) => ({ id, name, headline: `${name} at Example Labs`, positions: [{ title: 'Engineer', company: 'Example Labs' }], education: [{ institution: 'Example University' }], skills: ['graphs'], ...extra })
const published = (revision = 'worker-v1') => ({ state: 'published', complete: true, revision,
  profiles: [person('ada', 'Ada Lovelace', { linkedinUrl: 'https://www.linkedin.com/in/ada-l' }), person('grace', 'Grace Hopper'), person('alan', 'Alan Turing'), person('old-ada', 'Ada Copy')].filter(row => row.id !== 'old-ada'),
  connections: [{ fromId: 'ada', toId: 'grace' }, { fromId: 'grace', toId: 'alan' }, { fromId: 'alan', toId: 'ada' }],
  members: ['ada', 'grace'], aliases: { 'old-ada': 'ada' } })
const photoFor = id => id === 'ada' ? '/people/member-import-' + 'a'.repeat(64) + '/photo?v=' + 'b'.repeat(16) : null
const withHost = async (t, options) => {
  const host = createPublicIndexHost(options)
  const previous = activePublicIndexHost()
  installPublicIndexHost(host)
  t.after(async () => { installPublicIndexHost(previous); await host.close() })
  return host
}
const calls = [
  ['list', {}], ['list', { query: 'ada' }], ['list', { presence: 'member', includeTotal: true }], ['list', { exclude: ['grace'] }],
  ['profile', { id: 'ada' }], ['profile', { id: 'old-ada' }], ['profile', { id: 'missing' }], ['profile', { id: 'grace', known: new Set(['ada']), viewer: { signedIn: true } }],
  ['card', { id: 'ada', known: new Set(['grace']) }], ['suggest', { query: 'ada' }], ['company', { name: 'Example Labs' }],
  ['lookup', { ids: ['ada', 'old-ada', 'nobody'] }], ['lookup', { ids: ['ada'], details: true }], ['lookupLinkedin', { address: 'https://www.linkedin.com/in/ada-l' }],
  ['linkedinProfileIds', { id: 'ada' }], ['linkedinRef', { id: 'ada' }], ['linked', { fromId: 'ada', toId: 'grace' }], ['neighbors', { id: 'grace' }],
  ['unlistedGroup', { id: 'ada' }], ['suspended', { id: 'ada' }], ['suspensions', {}], ['addresses', {}],
]

test('every reader method answers through the worker exactly as in-process, photos included', async t => {
  const source = async () => published()
  source.revisionIdentifiesContent = true
  const local = createPublicPeopleReader({ readPublishedSnapshot: source, photoFor })
  const expected = []
  for (const [method, request] of calls) expected.push(await local[method](request))
  const host = await withHost(t)
  const remote = createPublicPeopleReader({ readPublishedSnapshot: source, photoFor })
  for (const [index, [method, request]] of calls.entries()) assert.deepEqual(await remote[method](request), expected[index], method)
  assert.equal(host.stats().installs, 1, 'one install per revision')
  assert.ok(host.stats().calls >= calls.length)
  // Returned rows are frozen like compiled rows.
  const rows = (await remote.list({})).profiles
  assert.ok(rows.every(Object.isFrozen))
  assert.match((await remote.list({ query: 'ada' })).profiles[0].photo, /\/photo\?v=/)
  // Errors keep their status and code.
  await assert.rejects(remote.list({ cursor: 'not!a!cursor' }), { status: 400, code: 'public_people_input_invalid' })
  await assert.rejects(remote.profile({ id: '' }), { status: 400 })
})

test('a new revision installs once; a page pinned to the previous revision still pages through it', async t => {
  let revision = 'worker-v1'
  const source = async () => ({ ...published(revision), profiles: Array.from({ length: 120 }, (_, i) => person(`p${i}`, `Person ${String(i).padStart(3, '0')}`)), connections: [], members: [], aliases: {} })
  source.revisionIdentifiesContent = true
  const host = await withHost(t)
  const pinned = createPublicPeopleReader({ readPublishedSnapshot: source, reuse: true })
  const first = await pinned.list({})
  assert.ok(first.nextCursor)
  revision = 'worker-v2'
  const fresh = createPublicPeopleReader({ readPublishedSnapshot: source })
  const next = await fresh.list({})
  assert.equal(host.stats().installs, 2)
  // The pinned reader keeps its revision for its next page (a cursor of the
  // other revision would fail closed).
  const second = await pinned.list({ cursor: first.nextCursor })
  assert.equal(second.profiles[0].id, 'p50')
  assert.equal(second.profiles.length, 50)
  // A cursor from the old revision fails closed on a reader of the new one.
  await assert.rejects(fresh.list({ cursor: first.nextCursor }), { status: 503 })
  assert.ok(next.profiles.length)
})

test('a lost worker fails pending calls closed, then the next read starts a new one and installs again', async t => {
  const source = async () => published()
  source.revisionIdentifiesContent = true
  const workers = []
  const host = await withHost(t, { backoffMs: 0, createWorker: (url, options) => { const worker = new Worker(url, options); workers.push(worker); return worker } })
  const reader = createPublicPeopleReader({ readPublishedSnapshot: source })
  assert.equal((await reader.list({})).profiles.length, 3)
  // The worker dies (for example on its own heap limit); the process does not.
  await workers[0].terminate()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.stats().crashed, 1)
  assert.equal((await reader.list({})).profiles.length, 3, 'the next read starts a new worker and installs again')
  assert.deepEqual([host.stats().spawned, host.stats().installs], [2, 2])
})

test('a worker that cannot start disables the host and readers compile in-process', async t => {
  let attempts = 0
  const createWorker = () => { attempts++; const fake = new EventEmitter(); fake.postMessage = () => {}; fake.terminate = async () => {}; fake.ref = fake.unref = () => {}; setImmediate(() => fake.emit('error', Error('cannot start'))); return fake }
  const host = await withHost(t, { createWorker, backoffMs: 0, onDisabled: () => {} })
  const source = async () => published()
  source.revisionIdentifiesContent = true
  for (let i = 0; i < 3; i++) await assert.rejects(createPublicPeopleReader({ readPublishedSnapshot: source }).list({}), { status: 503 })
  assert.equal(host.available(), false)
  assert.equal(attempts, 3)
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list({})).profiles.length, 3)
})

test('an aborted call fails closed without waiting for the worker', async t => {
  const source = async () => published()
  source.revisionIdentifiesContent = true
  await withHost(t)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: source })
  await reader.list({})
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(reader.list({ signal: controller.signal }), { status: 503 })
})

test('sources that do not identify content by revision never use the worker', async t => {
  const source = async () => published()
  const host = await withHost(t)
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: source }).list({})).profiles.length, 3)
  assert.equal(host.stats().installs, 0)
})
