import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UnipileLab, LabError, isAllowedTester, parseLinkedInUrl } from '../src/utils/unipile-lab.ts'

test('flag off, signed out, and nonallowlisted testers cannot access the lab', () => {
  assert.equal(isAllowedTester(false, 'alice', 'alice'), false)
  assert.equal(isAllowedTester(true, 'alice', null), false)
  assert.equal(isAllowedTester(true, 'alice', 'bob'), false)
  assert.equal(isAllowedTester(true, 'alice,bob', 'bob'), true)
})

function fixture() {
  const calls = []
  const provider = {
    async hostedLink(input) { calls.push(['hosted', input]); return 'https://account.unipile.com/test' },
    async verifyAccount(id) { calls.push(['verify', id]); if (id === 'denied') throw new LabError('denied', 'Denied') },
    async ownProfile(id) { calls.push(['own', id]); return { id: `owner-${id}`, name: 'Owner' } },
    async targetProfile(id, slug) { calls.push(['target', id, slug]); return { id: slug, name: slug } },
    async ownConnections(id) { calls.push(['own-relations', id]); return { people: [], partial: false } },
    async targetConnections(id, target) { calls.push(['target-relations', id, target]); return { people: [], partial: false } },
  }
  return { provider, calls }
}

function callbackOf(calls, accountId = 'account-one') {
  const input = calls.findLast(call => call[0] === 'hosted')[1]
  const callback = new URL(input.notifyUrl)
  return { state: callback.searchParams.get('state'), token: callback.searchParams.get('token'), name: input.name, status: input.reconnectAccount ? 'RECONNECTED' : 'CREATION_SUCCESS', accountId }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('accepts only plain LinkedIn profile URLs', () => {
  assert.equal(parseLinkedInUrl('https://www.linkedin.com/in/jacob-test'), 'jacob-test')
  for (const value of ['http://linkedin.com/in/person', 'https://evil.com/in/person', 'https://linkedin.com.evil.com/in/person', 'https://linkedin.com/company/foo', 'https://linkedin.com/in/a?x=1', 'https://user@linkedin.com/in/person', 'https://linkedin.com/in/a']) {
    assert.throws(() => parseLinkedInUrl(value), LabError)
  }
})

test('callback consumes a pending state once and verifies provider account and owner', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  const callback = callbackOf(calls)
  await assert.rejects(lab.callback({ ...callback, token: 'forged' }), /did not match/)
  assert.equal(lab.get('alice').connected, false)
  await lab.callback(callback)
  assert.equal(lab.get('alice').connected, true)
  assert.equal(lab.get('alice').preview.target.name, 'Owner')
  await assert.rejects(lab.callback(callback), /used/)
  assert.deepEqual(calls.map(call => call[0]), ['hosted', 'verify', 'own'])
})

test('expiry, cancellation and provider denial never bind an account', async () => {
  let now = 1000
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo', () => now)
  await lab.start('alice', 'https://test.example')
  const expired = callbackOf(calls)
  now += 600_001
  await assert.rejects(lab.callback(expired), /expired/)
  await lab.start('alice', 'https://test.example')
  const canceled = callbackOf(calls)
  await assert.rejects(lab.callback({ ...canceled, status: 'CANCELED' }), /not confirmed/)
  await lab.start('alice', 'https://test.example')
  await assert.rejects(lab.callback(callbackOf(calls, 'denied')), /Denied/)
  assert.equal(lab.get('alice').connected, false)
})

test('reconnect and account assignment cannot cross tester or demo boundaries', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  await lab.callback(callbackOf(calls))
  await lab.start('bob', 'https://test.example')
  await assert.rejects(lab.callback(callbackOf(calls)), /already assigned/)
  await lab.start('alice', 'https://test.example', true)
  await assert.rejects(lab.callback(callbackOf(calls, 'account-two')), /does not belong/)
  await lab.start('bob', 'https://test.example')
  await assert.rejects(lab.callback(callbackOf(calls, 'demo')), /already assigned/)
  assert.equal(lab.get('bob').connected, false)
})

test('reconnect preserves the verified LinkedIn owner identity', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  await lab.callback(callbackOf(calls, 'account-one'))
  await lab.start('alice', 'https://test.example', true)
  provider.ownProfile = async () => ({ id: 'different-owner', name: 'Different owner' })
  await assert.rejects(lab.callback(callbackOf(calls, 'account-one')), /owner did not match/)
  assert.equal(lab.get('alice').connected, false)
  assert.equal(lab.get('alice').hasSource, true)
  assert.equal(lab.get('alice').preview, undefined)
  await assert.rejects(lab.ownConnections('alice'), /not verified/)
  await lab.start('alice', 'https://test.example', true)
  provider.ownProfile = async () => ({ id: 'owner-account-one', name: 'Original owner' })
  await lab.callback(callbackOf(calls, 'account-one'))
  assert.equal(lab.get('alice').connected, true)
  assert.equal((await lab.ownConnections('alice')).outcome, 'empty')
})

test('reconnect quarantines source reads before and after non-ready provider failure', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  await lab.callback(callbackOf(calls, 'account-one'))
  await lab.start('alice', 'https://test.example', true)
  assert.equal(lab.get('alice').connected, false)
  await assert.rejects(lab.ownConnections('alice'), /not verified/)
  provider.verifyAccount = async () => { throw new LabError('unavailable', 'Source not ready') }
  await assert.rejects(lab.callback(callbackOf(calls, 'account-one')), /Source not ready/)
  assert.equal(lab.get('alice').hasSource, true)
  await assert.rejects(lab.ownConnections('alice'), /not verified/)
  provider.verifyAccount = async () => {}
  await lab.start('alice', 'https://test.example', true)
  await lab.callback(callbackOf(calls, 'account-one'))
  assert.equal(lab.get('alice').connected, true)
})

test('reconnect waits for an in-flight own page, then quarantines its result', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  await lab.callback(callbackOf(calls, 'account-one'))
  const hold = deferred()
  provider.ownConnections = async () => await hold.promise
  const page = lab.ownConnections('alice')
  await assert.rejects(lab.start('alice', 'https://test.example', true), /already running/)
  hold.resolve({ people: [{ id: 'changed-owner-relation', name: 'Private' }], partial: false })
  assert.equal((await page).people[0].id, 'changed-owner-relation')
  await lab.start('alice', 'https://test.example', true)
  assert.equal(lab.get('alice').preview, undefined)
  await assert.rejects(lab.ownConnections('alice'), /not verified/)
  provider.ownProfile = async () => ({ id: 'changed-owner', name: 'Changed owner' })
  await assert.rejects(lab.callback(callbackOf(calls, 'account-one')), /owner did not match/)
  assert.equal(lab.get('alice').preview, undefined)
  await assert.rejects(lab.ownConnections('alice'), /not verified/)
})

test('demo lookup and connection action use target ID and keep tester previews separate', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo')
  await lab.previewTarget('alice', 'https://linkedin.com/in/target-one')
  await lab.previewTarget('bob', 'https://linkedin.com/in/target-two')
  assert.equal(lab.get('alice').preview.target.id, 'target-one')
  const result = await lab.targetConnections('alice')
  assert.equal(result.outcome, 'empty')
  assert.equal(result.mode, 'demo')
  assert.deepEqual(calls.at(-1), ['target-relations', 'demo', 'target-one'])
  const callCount = calls.length
  await lab.targetConnections('alice')
  await lab.previewTarget('alice', 'https://linkedin.com/in/target-one')
  assert.equal(calls.length, callCount)
  assert.equal(lab.get('bob').preview.target.id, 'target-two')
  lab.reset('alice')
  assert.equal(lab.get('alice').preview, undefined)
  assert.ok(lab.get('bob').preview)
})

test('missing demo config and repeated simultaneous taps stop before transport', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider)
  await assert.rejects(lab.previewTarget('alice', 'https://linkedin.com/in/person'), /not configured/)
  assert.equal(calls.length, 0)
  let release
  provider.hostedLink = async () => await new Promise(resolve => { release = resolve })
  const first = lab.start('alice', 'https://test.example')
  await assert.rejects(lab.start('alice', 'https://test.example'), /already running/)
  release('https://account.unipile.com/test')
  await first
})

test('live target allowlist rejects unapproved URLs before provider access', async () => {
  const { provider, calls } = fixture()
  const lab = new UnipileLab(provider, 'demo', undefined, ['approved-person'])
  await assert.rejects(lab.previewTarget('alice', 'https://linkedin.com/in/unapproved-person'), /not approved/)
  assert.equal(calls.length, 0)
  await lab.previewTarget('alice', 'https://linkedin.com/in/approved-person')
  assert.deepEqual(calls.at(-1), ['target', 'demo', 'approved-person'])
})

test('one page is capped at ten and marked partial', async () => {
  const { provider } = fixture()
  provider.targetConnections = async () => ({ people: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, name: `${i}` })), partial: false })
  const lab = new UnipileLab(provider, 'demo')
  await lab.previewTarget('alice', 'https://linkedin.com/in/person')
  const result = await lab.targetConnections('alice')
  assert.equal(result.people.length, 10)
  assert.equal(result.outcome, 'partial')
})

test('distinct callbacks cannot assign the same account to two testers', async () => {
  const { provider, calls } = fixture()
  const hold = deferred()
  provider.verifyAccount = async () => { await hold.promise }
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  const alice = callbackOf(calls, 'shared-account')
  await lab.start('bob', 'https://test.example')
  const bob = callbackOf(calls, 'shared-account')
  const results = [lab.callback(alice), lab.callback(bob)]
  hold.resolve()
  const settled = await Promise.allSettled(results)
  assert.deepEqual(settled.map(result => result.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(Number(lab.get('alice').connected) + Number(lab.get('bob').connected), 1)
})

test('one tester cannot start two create flows or replace an in-flight callback', async () => {
  const { provider, calls } = fixture()
  const hold = deferred()
  provider.verifyAccount = async () => { await hold.promise }
  const lab = new UnipileLab(provider, 'demo')
  await lab.start('alice', 'https://test.example')
  await assert.rejects(lab.start('alice', 'https://test.example'), /already pending/)
  const callback = lab.callback(callbackOf(calls, 'account-one'))
  await assert.rejects(lab.start('alice', 'https://test.example'), /already pending/)
  hold.resolve()
  await callback
  await assert.rejects(lab.start('alice', 'https://test.example'), /already linked/)
  await lab.start('alice', 'https://test.example', true)
  await assert.rejects(lab.start('alice', 'https://test.example'), /already pending/)
})

test('clearing invalidates in-flight profile, page, and callback previews', async () => {
  const { provider, calls } = fixture()
  const profileHold = deferred()
  provider.targetProfile = async () => await profileHold.promise
  const lab = new UnipileLab(provider, 'demo')
  const lookup = lab.previewTarget('alice', 'https://linkedin.com/in/person')
  lab.reset('alice')
  profileHold.resolve({ id: 'person', name: 'Person' })
  await assert.rejects(lookup, /cleared/)
  assert.equal(lab.get('alice').preview, undefined)

  provider.targetProfile = async () => ({ id: 'person', name: 'Person' })
  await lab.previewTarget('alice', 'https://linkedin.com/in/person')
  const pageHold = deferred()
  provider.targetConnections = async () => await pageHold.promise
  const page = lab.targetConnections('alice')
  lab.reset('alice')
  pageHold.resolve({ people: [{ id: 'visible', name: 'Visible' }], partial: false })
  await assert.rejects(page, /cleared/)
  assert.equal(lab.get('alice').preview, undefined)

  await lab.start('alice', 'https://test.example')
  const verifyHold = deferred()
  provider.verifyAccount = async () => await verifyHold.promise
  const callback = lab.callback(callbackOf(calls))
  lab.reset('alice')
  verifyHold.resolve()
  await callback
  assert.equal(lab.get('alice').connected, true)
  assert.equal(lab.get('alice').preview, undefined)
})
