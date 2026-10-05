import test from 'node:test'
import assert from 'node:assert/strict'
import { runMiddlewareGate } from '../src/utils/middleware-gate.mjs'

const request = (method, pathname) => ({ method, nextUrl: { pathname } })

test('canonical callback GET and HEAD bypass the legacy session backend', async () => {
  let legacyCalls = 0
  const gate = method => runMiddlewareGate(request(method, '/auth/callback/ideaflow'), {
    nextResponse: { next: () => ({ kind: 'next', method }) },
    updateSession: async () => {
      legacyCalls += 1
      throw new Error('legacy Supabase session backend unavailable')
    },
  })

  assert.deepEqual(await gate('GET'), { kind: 'next', method: 'GET' })
  assert.deepEqual(await gate('HEAD'), { kind: 'next', method: 'HEAD' })
  assert.equal(legacyCalls, 0)
})

test('canonical callback bypass is exact by method and path', async () => {
  const followedLegacy = []
  const updateSession = async req => {
    followedLegacy.push(`${req.method} ${req.nextUrl.pathname}`)
    return { kind: 'legacy' }
  }
  const nextResponse = { next: () => ({ kind: 'next' }) }

  assert.deepEqual(await runMiddlewareGate(request('POST', '/auth/callback/ideaflow'), { nextResponse, updateSession }), { kind: 'legacy' })
  assert.deepEqual(await runMiddlewareGate(request('GET', '/auth/callback/ideaflow/'), { nextResponse, updateSession }), { kind: 'legacy' })
  assert.deepEqual(await runMiddlewareGate(request('GET', '/profiles'), { nextResponse, updateSession }), { kind: 'legacy' })
  assert.deepEqual(followedLegacy, [
    'POST /auth/callback/ideaflow',
    'GET /auth/callback/ideaflow/',
    'GET /profiles',
  ])
})

test('public directory GET/HEAD renders even when legacy Supabase is unavailable', async () => {
  let legacyCalls = 0
  const options = { nextResponse: { next: () => ({ kind: 'next' }) }, updateSession: async () => { legacyCalls++; throw Error('legacy Supabase unavailable') } }
  for (const method of ['GET', 'HEAD']) for (const path of ['/search-public', '/search-public/', '/people', '/people/', '/people/public-id', '/people/public-id/']) {
    assert.deepEqual(await runMiddlewareGate(request(method, path), options), { kind: 'next' })
  }
  assert.equal(legacyCalls, 0)
  for (const [method, path] of [['POST', '/people'], ['POST', '/people/public-id'], ['GET', '/people/id/private'], ['GET', '/api/people'], ['GET', '/profiles']]) {
    await assert.rejects(runMiddlewareGate(request(method, path), options), /legacy Supabase unavailable/)
  }
  assert.equal(legacyCalls, 5)
})
