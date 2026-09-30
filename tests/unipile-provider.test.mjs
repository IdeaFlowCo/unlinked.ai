import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V1UnipileProvider, configuredProvider } from '../src/utils/unipile-provider.ts'

test('fixture transport is the default; live mode requires complete configuration', () => {
  const prior = process.env.UNLINKED_UNIPILE_TEST_MODE
  try {
    delete process.env.UNLINKED_UNIPILE_TEST_MODE
    assert.equal(configuredProvider().mode, 'fixture')
    process.env.UNLINKED_UNIPILE_TEST_MODE = 'live'
    assert.throws(() => configuredProvider(), /incomplete/)
  } finally {
    if (prior === undefined) delete process.env.UNLINKED_UNIPILE_TEST_MODE
    else process.env.UNLINKED_UNIPILE_TEST_MODE = prior
  }
})

test('v1 target network uses one Classic connections_of page, never own relations', async () => {
  const prior = global.fetch
  const calls = []
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ items: [{ id: 'person-1', name: 'Visible person' }], cursor: 'next' }), { status: 200 })
  }
  try {
    const provider = new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key')
    const result = await provider.targetConnections('demo', 'target')
    assert.equal(result.partial, true)
    assert.equal(result.people.length, 1)
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/api\/v1\/linkedin\/search\?account_id=demo&limit=10$/)
    assert.deepEqual(JSON.parse(calls[0].init.body), { api: 'classic', category: 'people', connections_of: ['target'] })
  } finally { global.fetch = prior }
})

test('provider denial, rate and server errors are typed without leaking bodies', async () => {
  const prior = global.fetch
  const provider = new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key')
  try {
    for (const [status, code] of [[401, 'denied'], [403, 'denied'], [429, 'unavailable'], [500, 'unavailable'], [501, 'unsupported']]) {
      global.fetch = async () => new Response(JSON.stringify({ private_profile: 'secret' }), { status })
      await assert.rejects(provider.targetProfile('demo', 'target'), error => error.code === code && !error.message.includes('secret'))
    }
  } finally { global.fetch = prior }
})

test('hosted connection stays disabled until sync scope is reviewed', async () => {
  const prior = process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED
  delete process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED
  try {
    const provider = new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key')
    await assert.rejects(provider.hostedLink({ name: 'nonce', notifyUrl: 'https://test.example/callback', successUrl: 'https://test.example/ok', failureUrl: 'https://test.example/fail' }), /sync scope/)
  } finally {
    if (prior === undefined) delete process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED
    else process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED = prior
  }
})
