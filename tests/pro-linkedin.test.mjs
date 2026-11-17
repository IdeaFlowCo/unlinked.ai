import test from 'node:test'
import assert from 'node:assert/strict'
import { createProAccess, proAccessFromEnv, createMemoryProLinkedinStore, createNeo4jProLinkedinStore, createProLinkedin, proTokenHash, PRO_ATTEMPT_TTL_MS } from '../mcp-server/pro-linkedin.mjs'
import { createUnipileClient, UnipileError } from '../mcp-server/unipile-client.mjs'

// Owner-only Pro LinkedIn source (unlinked-flav). Every provider call is a
// local mock; no network, credential or real account is involved.
const jacob = { ownerId: 'owner-jacob', userId: 'user-jacob' }, friend = { ownerId: 'owner-friend', userId: 'user-friend' }, stranger = { ownerId: 'owner-x', userId: 'user-x' }
const SYSTEM = 'SystemInigoAcct01'
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

// A fake Unipile workspace behind fetch.
function provider({ clock }) {
  const accounts = new Map([[SYSTEM, { type: 'LINKEDIN', created_at: new Date(clock.at - 9e9).toISOString(), statuses: ['OK'], self: { provider_id: 'li-system', first_name: 'System', last_name: 'Source', public_identifier: 'system-source' } }]])
  const calls = [], state = { fail: null, search: null }
  const fetchImpl = async (url, init) => {
    const path = url.pathname, body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, path, query: Object.fromEntries(url.searchParams), body, key: init.headers['X-API-KEY'] })
    if (state.fail) return state.fail(path, init)
    if (init.method === 'POST' && path === '/api/v1/hosted/accounts/link') return json(201, { object: 'HostedAuthURL', url: 'https://account.unipile.com/hosted/' + body.name })
    const account = path.match(/^\/api\/v1\/accounts\/([^/]+)$/)
    if (account) {
      const found = accounts.get(account[1])
      if (!found) return json(404, { type: 'errors/resource_not_found' })
      if (init.method === 'DELETE') { accounts.delete(account[1]); return json(200, { object: 'AccountDeleted' }) }
      return json(200, { object: 'Account', id: account[1], type: found.type, created_at: found.created_at, sources: found.statuses.map((status, i) => ({ id: 's' + i, status })) })
    }
    if (path === '/api/v1/users/me') { const found = accounts.get(url.searchParams.get('account_id')); return found ? json(200, { object: 'AccountOwnerProfile', provider: 'LINKEDIN', ...found.self }) : json(404, { type: 'errors/resource_not_found' }) }
    if (path === '/api/v1/linkedin/search') return state.search ? state.search(url, body) : json(200, { object: 'LinkedinSearch', items: [], paging: { total_count: 0 } })
    return json(404, {})
  }
  const signIn = (id, self, overrides = {}) => accounts.set(id, { type: 'LINKEDIN', created_at: new Date(clock.at).toISOString(), statuses: ['OK'], self, ...overrides })
  return { fetchImpl, accounts, calls, state, signIn }
}
function setup({ owners = [[jacob.ownerId, jacob.userId]], enabled = true, searchEnabled = false, configured = true, searchPerDay = 3 } = {}) {
  const clock = { at: Date.UTC(2026, 10, 16, 12) }, unipile = provider({ clock }), store = createMemoryProLinkedinStore()
  const make = () => createProLinkedin({ store, access: createProAccess({ owners, enabled }), origin: 'https://www.unlinked.ai', systemAccountIds: [SYSTEM], searchEnabled, searchPerDay, now: () => clock.at,
    client: createUnipileClient(configured ? { dsn: 'api1.unipile.com:13111', apiKey: 'synthetic-key-0123456789', fetchImpl: unipile.fetchImpl } : {}) })
  return { clock, unipile, store, pro: make(), restart: make }
}
const tokenOf = unipile => new URL(unipile.calls.findLast(call => call.path === '/api/v1/hosted/accounts/link').body.notify_url).pathname.split('/').pop()
const attemptOf = unipile => unipile.calls.findLast(call => call.path === '/api/v1/hosted/accounts/link').body.name
const me = { provider_id: 'li-jacob', first_name: 'Jacob', last_name: 'Example', public_identifier: 'jacob-example' }
async function connect(ctx, owner = jacob, id = 'AcctJacob0001', self = me) {
  await ctx.pro.begin(owner); ctx.unipile.signIn(id, self)
  return ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: id, name: attemptOf(ctx.unipile) })
}

test('Pro is an exact server-side owner allowlist, off by default and separate from tiers', async () => {
  assert.equal(createProAccess().allowed(jacob), false)
  assert.equal(createProAccess({ owners: [[jacob.ownerId, jacob.userId]] }).allowed(jacob), false, 'the feature switch is required')
  const access = createProAccess({ owners: [[jacob.ownerId, jacob.userId]], enabled: true })
  assert.equal(access.allowed(jacob), true)
  for (const other of [friend, { ownerId: jacob.ownerId, userId: 'someone-else' }, { ownerId: jacob.ownerId }, null, { ownerId: 'OWNER-JACOB', userId: jacob.userId }]) assert.equal(access.allowed(other), false)
  assert.equal(createProAccess({ owners: [[jacob.ownerId, jacob.userId], ['only-one']], enabled: true }).allowed(jacob), false, 'a malformed list disables everything')
  assert.equal(proAccessFromEnv({ UNLINKED_PRO_LINKEDIN: 'on', UNLINKED_PRO_OWNERS: '[["owner-jacob","user-jacob"]]' }).allowed(jacob), true)
  assert.equal(proAccessFromEnv({ UNLINKED_PRO_LINKEDIN: 'on', UNLINKED_PRO_OWNERS: 'owner-jacob' }).allowed(jacob), false)
  assert.equal(proAccessFromEnv({ UNLINKED_PRO_OWNERS: '[["owner-jacob","user-jacob"]]' }).allowed(jacob), false)
  const ctx = setup()
  assert.deepEqual(await ctx.pro.status(friend), { eligible: false })
  await assert.rejects(ctx.pro.begin(friend), { code: 'not_eligible' }); await assert.rejects(ctx.pro.search(friend, 'x'), { code: 'not_eligible' })
  assert.equal(ctx.unipile.calls.length, 0, 'an ineligible owner never reaches the provider')
})

test('absent provider credentials disable connecting without any outbound call', async () => {
  const ctx = setup({ configured: false })
  const status = await ctx.pro.status(jacob); assert.equal(status.eligible, true); assert.equal(status.configured, false)
  await assert.rejects(ctx.pro.begin(jacob), { code: 'not_configured' }); assert.equal(ctx.unipile.calls.length, 0)
  for (const bad of [{ dsn: 'evil.example.com', apiKey: 'synthetic-key-0123456789' }, { dsn: 'api1.unipile.com', apiKey: 'short' }, { dsn: 'api1.unipile.com/x', apiKey: 'synthetic-key-0123456789' }]) assert.equal(createUnipileClient(bad).configured, false)
})

test('a hosted link carries an opaque attempt, a one-time notify path and a short expiry; the browser return alone connects nothing', async () => {
  const ctx = setup(), link = await ctx.pro.begin(jacob)
  assert.match(link.url, /^https:\/\/account\.unipile\.com\//)
  const call = ctx.unipile.calls[0]
  assert.equal(call.key, 'synthetic-key-0123456789'); assert.deepEqual(call.body.providers, ['LINKEDIN']); assert.equal(call.body.type, 'create'); assert.equal(call.body.api_url, 'https://api1.unipile.com:13111')
  assert.equal(Date.parse(call.body.expiresOn) - ctx.clock.at, PRO_ATTEMPT_TTL_MS); assert.equal(PRO_ATTEMPT_TTL_MS, 15 * 60 * 1000)
  assert.match(call.body.notify_url, /^https:\/\/www\.unlinked\.ai\/api\/pro\/linkedin\/notify\/[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(call.body).includes('jacob'), 'no internal owner or user id is sent to the provider')
  assert.equal(call.body.success_redirect_url, 'https://www.unlinked.ai/pro?linkedin=returned')
  const stored = await ctx.store.latestAttempt(jacob); assert.equal(stored.tokenHash, proTokenHash(tokenOf(ctx.unipile))); assert.ok(!JSON.stringify(stored).includes(tokenOf(ctx.unipile)), 'only the token hash is stored')
  const status = await ctx.pro.status(jacob); assert.equal(status.source, null); assert.equal(status.attempt.state, 'pending')
})

test('a verified callback binds the owner’s own account once; replays, forgeries and expiry bind nothing', async () => {
  const ctx = setup()
  assert.equal(await connect(ctx), 'accepted')
  const status = await ctx.pro.status(jacob)
  assert.equal(status.source.state, 'connected'); assert.equal(status.source.name, 'Jacob Example'); assert.equal(status.source.profileUrl, 'https://www.linkedin.com/in/jacob-example'); assert.equal(status.attempt.state, 'verified')
  assert.ok(!JSON.stringify(status).includes('AcctJacob0001'), 'the provider account id never reaches a browser view')
  const token = tokenOf(ctx.unipile), name = attemptOf(ctx.unipile)
  assert.equal(await ctx.pro.notify(token, { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name }), 'unknown', 'a replayed callback is not accepted twice')
  const generation = (await ctx.store.getSource(jacob)).generation
  // Forgeries against a fresh attempt.
  const next = setup(); await next.pro.begin(jacob); next.unipile.signIn('AcctJacob0001', me)
  const live = tokenOf(next.unipile), attempt = attemptOf(next.unipile)
  for (const [token, payload] of [
    ['A'.repeat(43), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attempt }],
    [live.slice(0, 42), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attempt }],
    [live, { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: 'another-attempt' }],
    [live, { status: 'RECONNECTED', account_id: 'AcctJacob0001', name: attempt }],
    [live, { status: 'CREATION_SUCCESS', account_id: '../accounts', name: attempt }],
    [live, { status: 'CREATION_SUCCESS', name: attempt }], [live, null], [live, []], [undefined, {}],
  ]) assert.equal(await next.pro.notify(token, payload), 'unknown')
  assert.equal(await next.store.getSource(jacob), null); assert.equal((await next.pro.status(jacob)).attempt.state, 'pending', 'a malformed delivery does not burn the live attempt')
  next.clock.at += PRO_ATTEMPT_TTL_MS
  assert.equal(await next.pro.notify(live, { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attempt }), 'unknown'); assert.equal((await next.pro.status(jacob)).attempt.state, 'expired'); assert.equal(await next.store.getSource(jacob), null)
  assert.equal((await ctx.store.getSource(jacob)).generation, generation)
})

test('the system account, pre-existing accounts, unready accounts and other providers can never be bound', async () => {
  const cases = [
    ['protected_account', ctx => SYSTEM],
    ['account_not_new', ctx => { ctx.unipile.signIn('OldAccount0001', me, { created_at: new Date(ctx.clock.at - 3600e3).toISOString() }); return 'OldAccount0001' }],
    ['account_not_ready', ctx => { ctx.unipile.signIn('Checkpoint0001', me, { statuses: ['CONNECTING'] }); return 'Checkpoint0001' }],
    ['account_not_ready', ctx => { ctx.unipile.signIn('WhatsApp000001', me, { type: 'WHATSAPP' }); return 'WhatsApp000001' }],
    ['verification_failed', () => 'NoSuchAccount01'],
  ]
  for (const [failure, prepare] of cases) {
    const ctx = setup(); await ctx.pro.begin(jacob); const id = prepare(ctx)
    assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: id, name: attemptOf(ctx.unipile) }), 'accepted')
    assert.equal(await ctx.store.getSource(jacob), null, failure); assert.equal((await ctx.pro.status(jacob)).attempt.failure, failure)
    if (failure === 'protected_account') assert.ok(!ctx.unipile.calls.some(call => call.path.includes(SYSTEM) || call.query.account_id === SYSTEM), 'the system account is not even read')
  }
  assert.throws(() => createProLinkedin({ store: createMemoryProLinkedinStore(), client: {}, access: createProAccess(), origin: 'https://www.unlinked.ai', systemAccountIds: ['bad id'] }))
  assert.throws(() => createProLinkedin({ store: createMemoryProLinkedinStore(), client: {}, access: createProAccess(), origin: 'http://www.unlinked.ai' }))
})

test('one provider account and one LinkedIn identity belong to at most one owner', async () => {
  const ctx = setup({ owners: [[jacob.ownerId, jacob.userId], [friend.ownerId, friend.userId]] })
  await connect(ctx)
  assert.equal(await connect(ctx, friend, 'AcctFriend001', me), 'accepted')
  assert.equal(await ctx.store.getSource(friend), null); assert.equal((await ctx.pro.status(friend)).attempt.failure, 'account_in_use', 'the same LinkedIn person under a second owner is refused')
  assert.equal(await connect(ctx, friend, 'AcctFriend002', { provider_id: 'li-friend', first_name: 'Friend', last_name: 'Person' }), 'accepted')
  assert.equal((await ctx.pro.status(friend)).source.name, 'Friend Person'); assert.equal((await ctx.pro.status(jacob)).source.name, 'Jacob Example')
  await assert.rejects(ctx.pro.begin(jacob), { code: 'already_connected' })
})

test('a transient provider failure keeps the attempt alive for the provider’s retry; pending state survives a restart', async () => {
  const ctx = setup(); await ctx.pro.begin(jacob); ctx.unipile.signIn('AcctJacob0001', me)
  const token = tokenOf(ctx.unipile), payload = { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }
  ctx.unipile.state.fail = () => json(503, { type: 'errors/service_unavailable' })
  await assert.rejects(ctx.pro.notify(token, payload), { code: 'verification_unavailable' }); assert.equal((await ctx.pro.status(jacob)).attempt.state, 'pending')
  ctx.unipile.state.fail = null
  const restarted = ctx.restart()
  assert.equal(await restarted.notify(token, payload), 'accepted'); assert.equal((await restarted.status(jacob)).source.state, 'connected')
  assert.equal(await restarted.notify(token, payload), 'unknown')
})

test('disconnect wins over a late callback, removes only the owner’s provider session and never the system account', async () => {
  const ctx = setup(); await connect(ctx)
  // A reconnect link is outstanding when the owner disconnects.
  ctx.unipile.accounts.get('AcctJacob0001').statuses = ['CREDENTIALS']
  assert.equal((await ctx.pro.check(jacob)).state, 'reconnect_required')
  await ctx.pro.begin(jacob, { reconnect: true })
  const link = ctx.unipile.calls.findLast(call => call.path.endsWith('/link')); assert.equal(link.body.type, 'reconnect'); assert.equal(link.body.reconnect_account, 'AcctJacob0001')
  const late = tokenOf(ctx.unipile), name = attemptOf(ctx.unipile)
  assert.deepEqual(await ctx.pro.disconnect(jacob), { removedAtProvider: true, pending: false })
  assert.equal(ctx.unipile.accounts.has('AcctJacob0001'), false); assert.equal(ctx.unipile.accounts.has(SYSTEM), true)
  assert.equal(await ctx.pro.notify(late, { status: 'RECONNECTED', account_id: 'AcctJacob0001', name }), 'unknown')
  assert.equal((await ctx.pro.status(jacob)).source, null)
  assert.deepEqual(ctx.unipile.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/v1/accounts/AcctJacob0001'])
  // A provider outage during removal is kept visible and retried before a new link.
  await connect(ctx, jacob, 'AcctJacob0002')
  ctx.unipile.state.fail = (path, init) => init.method === 'DELETE' ? json(503, {}) : json(404, {})
  assert.deepEqual(await ctx.pro.disconnect(jacob), { removedAtProvider: false, pending: true })
  assert.equal((await ctx.pro.status(jacob)).source.providerRevocation, 'pending')
  await assert.rejects(ctx.pro.begin(jacob), { code: 'revocation_pending' })
  ctx.unipile.state.fail = null
  await ctx.pro.begin(jacob); assert.equal(ctx.unipile.accounts.has('AcctJacob0002'), false, 'the old session is removed before a new link is issued')
})

test('reconnect only refreshes the same account and the same LinkedIn identity', async () => {
  const ctx = setup(); await connect(ctx)
  await assert.rejects(ctx.pro.begin(jacob, { reconnect: false }), { code: 'already_connected' })
  await ctx.pro.begin(jacob, { reconnect: true })
  ctx.unipile.signIn('OtherAccount01', me)
  assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'RECONNECTED', account_id: 'OtherAccount01', name: attemptOf(ctx.unipile) }), 'accepted'); assert.equal((await ctx.pro.status(jacob)).attempt.failure, 'account_mismatch')
  await ctx.pro.begin(jacob, { reconnect: true })
  ctx.unipile.accounts.get('AcctJacob0001').self = { provider_id: 'li-someone-else', first_name: 'Someone', last_name: 'Else' }
  assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'RECONNECTED', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }), 'accepted'); assert.equal((await ctx.pro.status(jacob)).attempt.failure, 'identity_mismatch')
  assert.equal((await ctx.pro.status(jacob)).source.name, 'Jacob Example')
  ctx.unipile.accounts.get('AcctJacob0001').self = me; const before = (await ctx.store.getSource(jacob)).connectedAt; ctx.clock.at += 60000
  await ctx.pro.begin(jacob, { reconnect: true })
  assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'RECONNECTED', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }), 'accepted')
  const source = await ctx.store.getSource(jacob); assert.equal(source.state, 'connected'); assert.equal(source.connectedAt, before); assert.equal(source.verifiedAt, ctx.clock.at)
  await assert.rejects(setup().pro.begin(jacob, { reconnect: true }), { code: 'not_connected' })
})

test('account deletion removes only that owner’s personal source and attempts', async () => {
  const ctx = setup({ owners: [[jacob.ownerId, jacob.userId], [friend.ownerId, friend.userId]] })
  await connect(ctx); await connect(ctx, friend, 'AcctFriend002', { provider_id: 'li-friend', first_name: 'Friend', last_name: 'Person' })
  await ctx.pro.removeOwner(jacob)
  assert.equal(await ctx.store.getSource(jacob), null); assert.equal(await ctx.store.latestAttempt(jacob), null)
  assert.equal((await ctx.store.getSource(friend)).state, 'connected'); assert.deepEqual([...ctx.unipile.accounts.keys()].sort(), ['AcctFriend002', SYSTEM].sort())
  await ctx.pro.removeOwner(stranger); await ctx.pro.removeOwner(null)
})

test('LinkedIn search is explicit, off by default, uses only the owner’s own source and separates failure from zero results', async () => {
  const off = setup(); await connect(off)
  await assert.rejects(off.pro.search(jacob, 'ada'), { code: 'search_not_enabled' }); assert.ok(!off.unipile.calls.some(call => call.path.includes('search')))
  const ctx = setup({ searchEnabled: true })
  await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'not_connected' }); await connect(ctx)
  const empty = await ctx.pro.search(jacob, 'nobody at all')
  assert.deepEqual(empty.people, []); assert.equal(empty.total, 0); assert.equal(empty.remainingToday, 2); assert.equal(empty.observedAt, ctx.clock.at); assert.deepEqual(empty.account, { name: 'Jacob Example' })
  const call = ctx.unipile.calls.findLast(entry => entry.path === '/api/v1/linkedin/search')
  assert.equal(call.query.account_id, 'AcctJacob0001'); assert.deepEqual(call.body, { api: 'classic', category: 'people', keywords: 'nobody at all' })
  ctx.unipile.state.search = () => json(200, { object: 'LinkedinSearch', paging: { total_count: 40 }, items: [
    { type: 'PEOPLE', name: 'Ada Example', public_identifier: 'ada-example', headline: 'Founder', location: 'Denver', network_distance: 'DISTANCE_2', id: 'internal', profile_picture_url: 'https://media.invalid/x' },
    { type: 'PEOPLE', name: 'No Address' }, { type: 'COMPANY', name: 'Ada Inc', public_identifier: 'ada-inc' }, { type: 'PEOPLE', name: 'Bad', public_identifier: 'a b/c' } ] })
  const found = await ctx.pro.search(jacob, 'ada')
  assert.deepEqual(found.people, [{ publicIdentifier: 'ada-example', name: 'Ada Example', headline: 'Founder', location: 'Denver', networkDistance: 2, linkedinUrl: 'https://www.linkedin.com/in/ada-example', source: 'linkedin_search' }]); assert.equal(found.skipped, 3); assert.equal(found.total, 40)
  ctx.unipile.state.search = () => json(429, { type: 'errors/too_many_requests', retry_after: 120 })
  await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'rate_limited', retryAfter: 120 })
  await assert.rejects(ctx.pro.search(jacob, 'ada'), error => error.code === 'daily_limit' && error.retryAfter > 0, 'a failed call still counts: uncertain outcomes are not retried for free')
  assert.equal(ctx.unipile.calls.filter(entry => entry.path === '/api/v1/linkedin/search').length, 3)
  for (const query of ['', '   ', 'x'.repeat(201), 7]) await assert.rejects(ctx.pro.search(jacob, query), { code: 'invalid_query' })
})

test('search reports reconnect, timeout and outage distinctly, and a disconnect during the call discards the answer', async () => {
  const ctx = setup({ searchEnabled: true, searchPerDay: 20 }); await connect(ctx)
  ctx.unipile.state.search = () => json(503, { type: 'errors/network_down' }); await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'provider_unavailable' })
  ctx.unipile.state.search = () => json(504, { type: 'errors/request_timeout' }); await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'timeout' })
  ctx.unipile.state.search = () => json(403, { type: 'errors/feature_not_subscribed' }); await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'not_entitled' })
  ctx.unipile.state.search = () => new Response('<html>', { status: 200 }); await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'provider_unavailable' })
  ctx.unipile.state.search = async () => { await ctx.pro.disconnect(jacob); return json(200, { items: [{ type: 'PEOPLE', name: 'Ada Example', public_identifier: 'ada-example' }] }) }
  await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'superseded' })
  const next = setup({ searchEnabled: true }); await connect(next)
  next.unipile.state.search = () => json(401, { type: 'errors/disconnected_account' }); await assert.rejects(next.pro.search(jacob, 'ada'), { code: 'reconnect_required' })
  assert.equal((await next.pro.status(jacob)).source.state, 'reconnect_required'); next.unipile.state.search = null
  await assert.rejects(next.pro.search(jacob, 'ada'), { code: 'reconnect_required' }, 'a source that needs reconnecting is not called again')
  assert.equal(next.unipile.calls.filter(entry => entry.path === '/api/v1/linkedin/search').length, 1)
})

test('provider errors never carry the key, a response body or an account id', async () => {
  const client = createUnipileClient({ dsn: 'api1.unipile.com', apiKey: 'synthetic-key-0123456789', fetchImpl: async () => json(401, { type: 'errors/missing_credentials', detail: 'secret-detail synthetic-key-0123456789' }) })
  const error = await client.getAccount('AcctJacob0001').catch(value => value)
  assert.ok(error instanceof UnipileError); assert.equal(error.code, 'provider_unauthorized'); assert.ok(!/synthetic-key|secret-detail|AcctJacob/.test(error.message + JSON.stringify(error)))
  await assert.rejects(client.getAccount('../etc'), { code: 'invalid_account' })
  const evil = createUnipileClient({ dsn: 'api1.unipile.com', apiKey: 'synthetic-key-0123456789', fetchImpl: async () => json(201, { object: 'HostedAuthURL', url: 'https://phish.example/hosted' }) })
  await assert.rejects(evil.createHostedAuthLink({ kind: 'create', name: 'a', notifyUrl: 'https://www.unlinked.ai/n', successUrl: 'https://www.unlinked.ai/pro', failureUrl: 'https://www.unlinked.ai/pro', expiresOn: new Date().toISOString() }), { code: 'invalid_response' })
})

test('the graph store sends only parameterized statements and fences writes by generation', async () => {
  const seen = []
  const driver = { session: () => ({ executeRead: fn => fn({ run: async (query, params) => { seen.push([query, params]); return { records: [] } } }), executeWrite: fn => fn({ run: async (query, params) => { seen.push([query, params]); return { records: [{ get: () => 0 }] } } }), close: async () => {} }) }
  const store = createNeo4jProLinkedinStore(driver)
  await store.initialize(); assert.equal(seen.length, 5); assert.ok(seen.every(([query]) => /^CREATE CONSTRAINT unlinked_pro_/.test(query)))
  const hostile = `x'}) DETACH DELETE n //`
  assert.equal(await store.getSource({ ownerId: hostile, userId: 'u' }), null)
  assert.equal(await store.putSource({ ownerId: hostile, userId: 'u', generation: 4, state: 'connected' }, 3), false, 'no row written means the generation moved')
  assert.equal(await store.settleAttempt(hostile, { state: 'failed' }), false)
  await store.removeOwner({ ownerId: hostile, userId: 'u' })
  assert.ok(seen.every(([query]) => !query.includes(hostile)), 'values never enter statement text')
  assert.equal(seen.at(-3)[1].expected, 3)
})
