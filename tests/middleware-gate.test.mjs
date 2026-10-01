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
