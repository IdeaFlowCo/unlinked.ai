import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V1UnipileProvider, configuredProvider } from '../src/utils/unipile-provider.ts'
import { UnipileLab } from '../src/utils/unipile-lab.ts'

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
    return new Response(JSON.stringify({ object: 'LinkedinSearch', items: [{ id: 'person-1', name: 'Visible person' }], cursor: 'next' }), { status: 200 })
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

test('v1 account must contain ready LinkedIn source before owner profile is read', async () => {
  const prior = global.fetch
  const provider = new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key')
  const calls = []
  try {
    for (const sources of [undefined, [], [{ status: 'CREDENTIALS' }], [{ status: 'CONNECTING' }], [{ status: 'STOPPED' }], [{}], [{ status: 'OK' }, { status: 'CREDENTIALS' }]]) {
      global.fetch = async url => {
        calls.push(String(url))
        return Response.json({ object: 'Account', id: 'account-one', type: 'LINKEDIN', sources })
      }
      await assert.rejects(provider.verifyAccount('account-one'), error => error.code === 'unavailable')
      assert.equal(calls.at(-1).includes('/accounts/account-one'), true)
    }
    global.fetch = async () => Response.json({ object: 'Account', id: 'account-one', type: 'LINKEDIN', sources: [{ status: 'OK' }] })
    await provider.verifyAccount('account-one')
  } finally { global.fetch = prior }
})

test('non-ready source cannot attach even if an owner profile would be available', async () => {
  const priorFetch = global.fetch
  const priorGate = process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED
  process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED = 'true'
  let hostedInput
  const paths = []
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname
    paths.push(path)
    if (path.endsWith('/hosted/accounts/link')) {
      hostedInput = JSON.parse(init.body)
      return Response.json({ url: 'https://account.unipile.com/synthetic' })
    }
    if (path.endsWith('/accounts/account-one')) return Response.json({ id: 'account-one', type: 'LINKEDIN', sources: [{ status: 'CREDENTIALS' }] })
    return Response.json({ provider_id: 'owner-one', first_name: 'Owner' })
  }
  try {
    const lab = new UnipileLab(new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key'), 'demo')
    await lab.start('alice', 'https://test.example')
    const callbackUrl = new URL(hostedInput.notify_url)
    await assert.rejects(lab.callback({ state: callbackUrl.searchParams.get('state'), token: callbackUrl.searchParams.get('token'), name: hostedInput.name, status: 'CREATION_SUCCESS', accountId: 'account-one' }), error => error.code === 'unavailable')
    assert.equal(lab.get('alice').connected, false)
    assert.equal(paths.some(path => path.endsWith('/users/me')), false)
  } finally {
    global.fetch = priorFetch
    if (priorGate === undefined) delete process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED
    else process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED = priorGate
  }
})

test('v1 page decoder distinguishes valid empty, content, and malformed responses', async () => {
  const prior = global.fetch
  const provider = new V1UnipileProvider('https://api1.unipile.com:13111/', 'fake-key')
  try {
    global.fetch = async () => Response.json({ object: 'UserRelationsList', items: [], cursor: null })
    assert.deepEqual(await provider.ownConnections('account-one'), { people: [], partial: false })
    const ownRequests = []
    global.fetch = async url => {
      ownRequests.push(String(url))
      return Response.json({ object: 'UserRelationsList', items: [{ object: 'UserRelation', member_id: 'v1-member', first_name: 'Ada', last_name: 'Lovelace', headline: 'Engineer' }], cursor: null })
    }
    assert.deepEqual((await provider.ownConnections('account-one')).people[0], { id: 'v1-member', name: 'Ada Lovelace', headline: 'Engineer', publicUrl: undefined })
    assert.equal(ownRequests.length, 1)
    assert.match(ownRequests[0], /\/users\/relations\?account_id=account-one&limit=10$/)
    global.fetch = async () => Response.json({ object: 'UserRelationsList', items: Array.from({ length: 11 }, (_, i) => ({ member_id: `member-${i}`, first_name: 'Member' })), cursor: 'next' })
    const boundedOwn = await provider.ownConnections('account-one')
    assert.equal(boundedOwn.people.length, 10)
    assert.equal(boundedOwn.partial, true)
    global.fetch = async () => Response.json({ object: 'LinkedinSearch', items: [], cursor: null })
    assert.deepEqual(await provider.targetConnections('demo', 'target'), { people: [], partial: false })
    global.fetch = async () => Response.json({ object: 'LinkedinSearch', items: [{ id: 'person-one', first_name: 'Ada', last_name: 'Lovelace' }] })
    assert.equal((await provider.targetConnections('demo', 'target')).people[0].name, 'Ada Lovelace')
    for (const bad of [null, { object: 'UnexpectedResult', items: [] }, { object: 'LinkedinSearch' }, { object: 'LinkedinSearch', items: null }, { object: 'LinkedinSearch', items: [{}] }, { object: 'LinkedinSearch', items: [], cursor: 5 }]) {
      global.fetch = async () => Response.json(bad)
      await assert.rejects(provider.targetConnections('demo', 'target'), error => error.code === 'unavailable')
    }
    global.fetch = async () => Response.json({ object: 'UserRelationsList', items: [{ id: 'v2-id-without-member-id' }] })
    await assert.rejects(provider.ownConnections('account-one'), error => error.code === 'unavailable')
  } finally { global.fetch = prior }
})
