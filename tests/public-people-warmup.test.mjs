import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'
import { warmPublicPeopleIndex } from '../mcp-server/public-people-warmup.mjs'

const snapshot = () => ({ state: 'published', complete: true, revision: 'warmup-v1',
  profiles: [{ id: 'warm-person', name: 'Warm Person', positions: [], education: [], skills: [] }], connections: [] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const request = (port, path) => new Promise((resolve, reject) => {
  get({ hostname: '127.0.0.1', port, path, headers: { host: 'pilot.invalid', 'user-agent': 'Googlebot' } }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value })
    response.on('end', () => resolve({ status: response.statusCode, body }))
  }).on('error', reject)
})
async function freePort() {
  for (;;) {
    const port = 7000 + Math.floor(Math.random() * 3000), server = createServer()
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      await new Promise(resolve => server.close(resolve)); return port
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
}
const options = port => ({ baseUrl: 'https://pilot.invalid', port,
  login: { begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'test' } }), finish: async () => ({}) },
  resolveOwner: async () => { throw Error('owner_must_not_be_used_for_warmup') },
  getBackend: async () => { throw Error('private_backend_must_not_be_used_for_warmup') },
  complete: async () => { throw Error('model_must_not_be_used_for_warmup') } })

test('startup warms before listening and first public navigation retains live revocation checks', async t => {
  const port = await freePort(), entered = deferred(), release = deferred()
  let reads = 0, active = true
  const readPublishedSnapshot = async ({ viewer }) => {
    assert.equal(viewer, null); reads++
    if (reads === 1) { entered.resolve(); await release.promise }
    return active ? snapshot() : null
  }
  readPublishedSnapshot.revisionIdentifiesContent = true
  const starting = startPrivatePilot({ ...options(port), readPublishedSnapshot })
  t.after(() => release.resolve())
  await entered.promise
  await assert.rejects(request(port, '/people'), { code: 'ECONNREFUSED' })
  release.resolve()
  const runtime = await starting
  t.after(() => runtime.stop())
  assert.equal(reads, 1)
  const first = await request(port, '/people')
  assert.equal(first.status, 200); assert.match(first.body, /Warm Person/)
  assert.equal(reads, 2)
  active = false
  const revoked = await request(port, '/api/people')
  assert.equal(revoked.status, 503)
  assert.deepEqual(JSON.parse(revoked.body), { error: 'public_people_unavailable' })
})

test('unavailable public publication still allows the runtime and login to start', async t => {
  const port = await freePort()
  const readPublishedSnapshot = async () => { throw Error('publication_unavailable') }
  readPublishedSnapshot.revisionIdentifiesContent = true
  const runtime = await startPrivatePilot({ ...options(port), readPublishedSnapshot })
  t.after(() => runtime.stop())
  assert.equal((await request(port, '/login')).status, 303)
  assert.equal((await request(port, '/api/people')).status, 503)
})

test('warmup skips absent or non-content-addressed sources and aborts a stalled trusted source', async () => {
  let calls = 0, aborted = false
  const source = async () => { calls++; return snapshot() }
  assert.equal(await warmPublicPeopleIndex(), false)
  assert.equal(await warmPublicPeopleIndex({ readPublishedSnapshot: source }), false)
  assert.equal(calls, 0)
  const stalled = ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(null) }, { once: true })
  })
  stalled.revisionIdentifiesContent = true
  assert.equal(await warmPublicPeopleIndex({ readPublishedSnapshot: stalled, timeoutMs: 20 }), false)
  assert.equal(aborted, true)
})
