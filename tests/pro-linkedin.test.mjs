import test from 'node:test'
import assert from 'node:assert/strict'
import { createProAccess, proAccessFromEnv, createMemoryProLinkedinStore, createNeo4jProLinkedinStore, createProLinkedin, createProLinkedinCleanup, proTokenHash, PRO_ATTEMPT_TTL_MS, PRO_SEARCH_RECEIPT_TTL_MS } from '../mcp-server/pro-linkedin.mjs'
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
    if (state.fail) { const failed = state.fail(path, init); if (failed) return failed }
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
  const client = createUnipileClient(configured ? { dsn: 'api1.unipile.com:13111', apiKey: 'synthetic-key-0123456789', fetchImpl: unipile.fetchImpl } : {})
  const make = (access = createProAccess({ owners, enabled })) => createProLinkedin({ store, access, origin: 'https://www.unlinked.ai', systemAccountIds: [SYSTEM], searchEnabled, searchPerDay, now: () => clock.at, client })
  return { clock, unipile, store, client, pro: make(), restart: make }
}
const tokenOf = unipile => new URL(unipile.calls.findLast(call => call.path === '/api/v1/hosted/accounts/link').body.notify_url).pathname.split('/').pop()
const attemptOf = unipile => unipile.calls.findLast(call => call.path === '/api/v1/hosted/accounts/link').body.name
const me = { provider_id: 'li-jacob', first_name: 'Jacob', last_name: 'Example', public_identifier: 'jacob-example' }
async function connect(ctx, owner = jacob, id = 'AcctJacob0001', self = me) {
  await ctx.pro.begin(owner); ctx.unipile.signIn(id, self)
  return ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: id, name: attemptOf(ctx.unipile) })
}
// A search as the People page offers it: with the receipt of a finished local no-match.
const ask = (ctx, query, owner = jacob) => ctx.pro.search(owner, query, { receipt: ctx.pro.searchReceipt(owner, query) })

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
    ['protected_account', () => SYSTEM],
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
  const empty = await ask(ctx, 'nobody at all')
  assert.deepEqual(empty.people, []); assert.equal(empty.total, 0); assert.equal(empty.remainingToday, 2); assert.equal(empty.observedAt, ctx.clock.at); assert.deepEqual(empty.account, { name: 'Jacob Example' })
  const call = ctx.unipile.calls.findLast(entry => entry.path === '/api/v1/linkedin/search')
  assert.equal(call.query.account_id, 'AcctJacob0001'); assert.deepEqual(call.body, { api: 'classic', category: 'people', keywords: 'nobody at all' })
  ctx.unipile.state.search = () => json(200, { object: 'LinkedinSearch', paging: { total_count: 40 }, items: [
    { type: 'PEOPLE', name: 'Ada Example', public_identifier: 'ada-example', headline: 'Founder', location: 'Denver', network_distance: 'DISTANCE_2', id: 'internal', profile_picture_url: 'https://media.invalid/x' },
    { type: 'PEOPLE', name: 'No Address' }, { type: 'COMPANY', name: 'Ada Inc', public_identifier: 'ada-inc' }, { type: 'PEOPLE', name: 'Bad', public_identifier: 'a b/c' } ] })
  const found = await ask(ctx, 'ada')
  assert.deepEqual(found.people, [{ publicIdentifier: 'ada-example', name: 'Ada Example', headline: 'Founder', location: 'Denver', networkDistance: 2, linkedinUrl: 'https://www.linkedin.com/in/ada-example', source: 'linkedin_search' }]); assert.equal(found.skipped, 3); assert.equal(found.total, 40)
  ctx.unipile.state.search = () => json(429, { type: 'errors/too_many_requests', retry_after: 120 })
  await assert.rejects(ask(ctx, 'ada'), { code: 'rate_limited', retryAfter: 120 })
  await assert.rejects(ask(ctx, 'ada'), error => error.code === 'daily_limit' && error.retryAfter > 0, 'a failed call still counts: uncertain outcomes are not retried for free')
  assert.equal(ctx.unipile.calls.filter(entry => entry.path === '/api/v1/linkedin/search').length, 3)
  for (const query of ['', '   ', 'x'.repeat(201), 7]) await assert.rejects(ctx.pro.search(jacob, query), { code: 'invalid_query' })
})

test('search reports reconnect, timeout and outage distinctly, and a disconnect during the call discards the answer', async () => {
  const ctx = setup({ searchEnabled: true, searchPerDay: 20 }); await connect(ctx)
  ctx.unipile.state.search = () => json(503, { type: 'errors/network_down' }); await assert.rejects(ask(ctx, 'ada'), { code: 'provider_unavailable' })
  ctx.unipile.state.search = () => json(504, { type: 'errors/request_timeout' }); await assert.rejects(ask(ctx, 'ada'), { code: 'timeout' })
  ctx.unipile.state.search = () => json(403, { type: 'errors/feature_not_subscribed' }); await assert.rejects(ask(ctx, 'ada'), { code: 'not_entitled' })
  ctx.unipile.state.search = () => new Response('<html>', { status: 200 }); await assert.rejects(ask(ctx, 'ada'), { code: 'provider_unavailable' })
  ctx.unipile.state.search = async () => { await ctx.pro.disconnect(jacob); return json(200, { items: [{ type: 'PEOPLE', name: 'Ada Example', public_identifier: 'ada-example' }] }) }
  await assert.rejects(ask(ctx, 'ada'), { code: 'superseded' })
  const next = setup({ searchEnabled: true }); await connect(next)
  next.unipile.state.search = () => json(401, { type: 'errors/disconnected_account' }); await assert.rejects(ask(next, 'ada'), { code: 'reconnect_required' })
  assert.equal((await next.pro.status(jacob)).source.state, 'reconnect_required'); next.unipile.state.search = null
  await assert.rejects(ask(next, 'ada'), { code: 'reconnect_required' }, 'a source that needs reconnecting is not called again')
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
  await store.initialize(); assert.equal(seen.length, 6); assert.ok(seen.every(([query]) => /^CREATE CONSTRAINT unlinked_pro_/.test(query)))
  const hostile = `x'}) DETACH DELETE n //`
  assert.equal(await store.getSource({ ownerId: hostile, userId: 'u' }), null)
  assert.equal(await store.putSource({ ownerId: hostile, userId: 'u', generation: 4, state: 'connected' }, 3), false, 'no row written means the generation moved')
  assert.equal(await store.settleAttempt(hostile, { state: 'failed' }), false)
  await store.removeOwner({ ownerId: hostile, userId: 'u' })
  assert.ok(seen.every(([query]) => !query.includes(hostile)), 'values never enter statement text')
  assert.equal(seen.find(([, params]) => params?.props)[1].expected, 3)
})

const deleteFails = (path, init) => init.method === 'DELETE' ? json(503, {}) : null
const pair = owner => [owner.ownerId, owner.userId]

test('F1: a reconnect that signs in as a different LinkedIn identity blocks the source; Check connection never approves it and search is refused', async () => {
  const ctx = setup({ searchEnabled: true }); await connect(ctx)
  const before = (await ctx.store.getSource(jacob)).generation
  await ctx.pro.begin(jacob, { reconnect: true })
  ctx.unipile.accounts.get('AcctJacob0001').self = { provider_id: 'li-someone-else', first_name: 'Someone', last_name: 'Else' }
  assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'RECONNECTED', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }), 'accepted')
  const source = await ctx.store.getSource(jacob)
  assert.equal(source.state, 'reconnect_required'); assert.equal(source.generation, before + 1); assert.equal(source.selfName, 'Jacob Example')
  assert.equal((await ctx.pro.check(jacob)).state, 'reconnect_required', 'a healthy provider session signed in as someone else is not connected')
  assert.equal((await ctx.store.getSource(jacob)).state, 'reconnect_required')
  await assert.rejects(ask(ctx, 'ada'), { code: 'reconnect_required' })
  assert.ok(!ctx.unipile.calls.some(call => call.path === '/api/v1/linkedin/search')); assert.ok(!ctx.unipile.calls.some(call => call.method === 'DELETE'), 'a reconnect never deletes the account')
  // The session switched identity with no callback at all.
  const quiet = setup({ searchEnabled: true }); await connect(quiet)
  quiet.unipile.accounts.get('AcctJacob0001').self = { provider_id: 'li-someone-else', first_name: 'Someone', last_name: 'Else' }
  assert.equal((await quiet.pro.check(jacob)).state, 'reconnect_required'); await assert.rejects(ask(quiet, 'ada'), { code: 'reconnect_required' })
  // Reconnecting as the bound person restores it.
  quiet.unipile.accounts.get('AcctJacob0001').self = me; await quiet.pro.begin(jacob, { reconnect: true })
  assert.equal(await quiet.pro.notify(tokenOf(quiet.unipile), { status: 'RECONNECTED', account_id: 'AcctJacob0001', name: attemptOf(quiet.unipile) }), 'accepted')
  assert.equal((await quiet.pro.check(jacob)).state, 'connected'); assert.equal((await ask(quiet, 'ada')).remainingToday, 2)
})

test('F2: disconnect and account deletion win over a first connect that is already binding', async () => {
  // Each action runs exactly between the binding step and the source write.
  const during = (ctx, action) => { const put = ctx.store.putSource; ctx.store.putSource = async (...args) => { ctx.store.putSource = put; await action(); return put(...args) } }
  for (const action of ['disconnect', 'removeOwner']) {
    const ctx = setup(); await ctx.pro.begin(jacob); ctx.unipile.signIn('AcctJacob0001', me)
    during(ctx, () => ctx.pro[action](jacob))
    assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }), 'accepted')
    assert.equal(ctx.unipile.accounts.has('AcctJacob0001'), false, `${action}: the provider session is removed`); assert.equal(ctx.unipile.accounts.has(SYSTEM), true)
    const source = await ctx.store.getSource(jacob)
    if (action === 'disconnect') { assert.equal(source.state, 'disconnected'); assert.equal(source.accountId, null); assert.equal((await ctx.pro.status(jacob)).source, null); assert.equal((await ctx.pro.status(jacob)).attempt.state, 'superseded') }
    else { assert.equal(source, null, 'a deleted owner keeps no source'); assert.equal(await ctx.store.latestAttempt(jacob), null) }
  }
  // The provider is down during the undo: a deleted owner keeps only a pending-removal record, which the operator sweep finishes.
  const ctx = setup(); await ctx.pro.begin(jacob); ctx.unipile.signIn('AcctJacob0001', me)
  during(ctx, async () => { await ctx.pro.removeOwner(jacob); ctx.unipile.state.fail = deleteFails })
  assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(ctx.unipile) }), 'accepted')
  const left = await ctx.store.getSource(jacob)
  assert.equal(left.state, 'disconnected'); assert.equal(left.providerRevocation, 'pending'); assert.equal(left.ownerDeleted, true); assert.equal(ctx.unipile.accounts.has('AcctJacob0001'), true)
  ctx.unipile.state.fail = null
  assert.deepEqual(await ctx.pro.sweepPendingRemovals(), { revoked: 1, cleaned: 0, skipped: 0, pending: 0 })
  assert.equal(ctx.unipile.accounts.has('AcctJacob0001'), false); assert.equal(await ctx.store.getSource(jacob), null)
})

test('F2/F6: the graph store supersedes binding attempts, never leaves a stub on a missed write and keeps only pending removals on deletion', async () => {
  const seen = []
  let failWith = null
  const tx = { run: async (query, params) => { seen.push([query, params]); if (failWith) throw failWith; return { records: [{ get: () => 0 }] } } }
  const store = createNeo4jProLinkedinStore({ session: () => ({ executeRead: fn => fn(tx), executeWrite: fn => fn(tx), close: async () => {} }) })
  const last = () => seen.at(-1)[0]
  await store.supersedeAttempts(jacob, 1); assert.match(last(), /a\.state IN \['pending', 'binding'\]/)
  assert.equal(await store.putSource({ ownerId: 'o', userId: 'u', generation: 1, state: 'connected' }, 0), false)
  assert.doesNotMatch(last(), /MERGE/); assert.match(last(), /s IS NULL OR \(s\.state IS NULL AND s\.userId = \$userId\)/); assert.match(last(), /WHERE free = 1 CREATE/)
  assert.equal(await store.putSource({ ownerId: 'o', userId: 'u', generation: 5, state: 'connected' }, 4), false)
  assert.match(last(), /^MATCH \(s:UnlinkedProSource \{ownerId: \$ownerId\}\) WHERE s\.generation = \$expected/); assert.doesNotMatch(last(), /MERGE|CREATE/, 'a compare-and-set miss creates nothing')
  failWith = Object.assign(new Error('Node(1) already exists with label `UnlinkedProSource` and property `ownerId` = \'o\''), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' })
  assert.equal(await store.putSource({ ownerId: 'o', userId: 'u', generation: 1, state: 'connected' }, 0), false, 'a concurrent first write is a miss, not a conflict')
  failWith = Object.assign(new Error('Node(1) already exists with label `UnlinkedProSource` and property `accountKey` = \'k\''), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' })
  await assert.rejects(store.putSource({ ownerId: 'o', userId: 'u', generation: 1, state: 'connected' }, 0), { code: 'account_in_use' })
  failWith = null
  await store.removeOwner(jacob)
  assert.match(seen.at(-2)[0], /UnlinkedProSearchCount/); assert.match(seen.at(-2)[0], /NOT \(n:UnlinkedProSource AND coalesce\(n\.providerRevocation, ''\) = 'pending'\)/); assert.match(seen.at(-2)[0], /NOT \(n:UnlinkedProAuthAttempt AND coalesce\(n\.cleanup, ''\) = 'pending'\)/)
  assert.match(last(), /SET s\.ownerDeleted = true/)
  await store.pruneAttempts(1); assert.match(last(), /coalesce\(a\.cleanup, ''\) <> 'pending'/)
  await store.countSearch('o', 20000, 20); assert.match(last(), /SET c\.locked = true WITH c/); assert.deepEqual(seen.at(-1)[1], { ownerId: 'o', day: 20000, limit: 20 })
  await store.pendingRevocations(10); await store.pendingCleanups(10); assert.match(last(), /LIMIT toInteger\(\$limit\)/)
  assert.ok(seen.every(([query]) => !/'o'|owner-jacob/.test(query)), 'values stay parameters')
})

test('F3: a create attempt that fails after the provider made the account removes that account; never a reconnect, system or bound account; a failed removal waits for the operator sweep', async () => {
  for (const [failure, removed, prepare] of [
    ['account_not_ready', true, ctx => { ctx.unipile.signIn('Checkpoint0001', me, { statuses: ['CONNECTING'] }); return 'Checkpoint0001' }],
    ['account_not_new', false, ctx => { ctx.unipile.signIn('OldAccount0001', me, { created_at: new Date(ctx.clock.at - 3600e3).toISOString() }); return 'OldAccount0001' }],
    ['account_not_ready', false, ctx => { ctx.unipile.signIn('WhatsApp000001', me, { type: 'WHATSAPP' }); return 'WhatsApp000001' }],
    ['protected_account', false, () => SYSTEM],
  ]) {
    const ctx = setup(); await ctx.pro.begin(jacob); const id = prepare(ctx)
    assert.equal(await ctx.pro.notify(tokenOf(ctx.unipile), { status: 'CREATION_SUCCESS', account_id: id, name: attemptOf(ctx.unipile) }), 'accepted')
    assert.equal((await ctx.pro.status(jacob)).attempt.failure, failure); assert.equal(ctx.unipile.accounts.has(id), !removed, `${failure} ${id}`); assert.equal(ctx.unipile.accounts.has(SYSTEM), true)
  }
  // The same LinkedIn person under a second owner: that duplicate session goes; the first owner's bound account stays.
  const two = setup({ owners: [pair(jacob), pair(friend)] }); await connect(two)
  await connect(two, friend, 'AcctFriend001', me); assert.equal((await two.pro.status(friend)).attempt.failure, 'account_in_use')
  assert.equal(two.unipile.accounts.has('AcctFriend001'), false); assert.equal(two.unipile.accounts.has('AcctJacob0001'), true)
  await two.pro.begin(friend)
  assert.equal(await two.pro.notify(tokenOf(two.unipile), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(two.unipile) }), 'accepted')
  assert.equal(two.unipile.accounts.has('AcctJacob0001'), true, 'an account bound to any owner is never removed'); assert.equal((await two.store.getSource(jacob)).state, 'connected')
  // A sign-in completed on a link that was replaced by a newer one.
  const late = setup(); await late.pro.begin(jacob); const first = tokenOf(late.unipile), firstName = attemptOf(late.unipile)
  await late.pro.begin(jacob); late.unipile.signIn('AcctFirst00001', me)
  assert.equal(await late.pro.notify(first, { status: 'CREATION_SUCCESS', account_id: 'AcctFirst00001', name: firstName }), 'unknown'); assert.equal(late.unipile.accounts.has('AcctFirst00001'), false)
  // Pro access removed before the callback arrived.
  const gone = setup(); await gone.pro.begin(jacob); gone.unipile.signIn('AcctJacob0001', me)
  assert.equal(await gone.restart(createProAccess()).notify(tokenOf(gone.unipile), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(gone.unipile) }), 'accepted')
  assert.equal((await gone.store.latestAttempt(jacob)).failure, 'not_eligible'); assert.equal(gone.unipile.accounts.has('AcctJacob0001'), false)
  // A reconnect never removes anything, even an account that is not the bound one.
  const re = setup(); await connect(re); await re.pro.begin(jacob, { reconnect: true }); re.unipile.signIn('OtherAccount01', me)
  await re.pro.notify(tokenOf(re.unipile), { status: 'RECONNECTED', account_id: 'OtherAccount01', name: attemptOf(re.unipile) })
  assert.equal(re.unipile.accounts.has('OtherAccount01'), true); assert.ok(!re.unipile.calls.some(call => call.method === 'DELETE'))
  // Removal fails: a durable server-side marker, never shown, finished only by the operator sweep.
  const down = setup(); await down.pro.begin(jacob); down.unipile.signIn('Checkpoint0001', me, { statuses: ['CONNECTING'] }); down.unipile.state.fail = deleteFails
  await down.pro.notify(tokenOf(down.unipile), { status: 'CREATION_SUCCESS', account_id: 'Checkpoint0001', name: attemptOf(down.unipile) })
  const marked = await down.store.latestAttempt(jacob); assert.equal(marked.cleanup, 'pending'); assert.equal(marked.cleanupAccountId, 'Checkpoint0001')
  assert.ok(!JSON.stringify(await down.pro.status(jacob)).includes('Checkpoint0001'), 'the account id stays server-side')
  assert.deepEqual(await down.pro.sweepPendingRemovals(), { revoked: 0, cleaned: 0, skipped: 0, pending: 1 })
  down.unipile.state.fail = null
  assert.deepEqual(await down.pro.sweepPendingRemovals(), { revoked: 0, cleaned: 1, skipped: 0, pending: 0 })
  assert.equal(down.unipile.accounts.has('Checkpoint0001'), false); assert.equal((await down.store.latestAttempt(jacob)).cleanup, 'done')
  assert.deepEqual(await down.pro.sweepPendingRemovals(), { revoked: 0, cleaned: 0, skipped: 0, pending: 0 })
  // The sweep re-checks: an account that became bound meanwhile is left alone.
  const bound = setup(); await bound.pro.begin(jacob); bound.unipile.signIn('AcctJacob0001', me, { statuses: ['CONNECTING'] }); bound.unipile.state.fail = deleteFails
  await bound.pro.notify(tokenOf(bound.unipile), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: attemptOf(bound.unipile) })
  bound.unipile.state.fail = null; bound.unipile.accounts.get('AcctJacob0001').statuses = ['OK']; await connect(bound)
  assert.deepEqual(await bound.pro.sweepPendingRemovals(), { revoked: 0, cleaned: 0, skipped: 1, pending: 0 }); assert.equal(bound.unipile.accounts.has('AcctJacob0001'), true)
})

test('F4: LinkedIn search needs a fresh, single-use receipt for the same owner and words; the daily bound is durable across restarts', async () => {
  const ctx = setup({ searchEnabled: true, owners: [pair(jacob), pair(friend)] }); await connect(ctx)
  const searches = () => ctx.unipile.calls.filter(call => call.path === '/api/v1/linkedin/search').length
  await assert.rejects(ctx.pro.search(jacob, 'ada'), { code: 'local_search_required' })
  await assert.rejects(ctx.pro.search(jacob, 'ada', { receipt: 'forged-receipt' }), { code: 'local_search_required' })
  await assert.rejects(ctx.pro.search(jacob, 'ada', { receipt: ctx.pro.searchReceipt(jacob, 'grace') }), { code: 'local_search_required' }, 'bound to the words')
  await assert.rejects(ctx.pro.search(jacob, 'ada', { receipt: ctx.pro.searchReceipt(friend, 'ada') }), { code: 'local_search_required' }, 'bound to the owner')
  assert.equal(searches(), 0, 'nothing reaches the provider and nothing is counted')
  const receipt = ctx.pro.searchReceipt(jacob, '  Ada   Lovelace ')
  assert.equal((await ctx.pro.search(jacob, 'ada lovelace', { receipt })).remainingToday, 2)
  await assert.rejects(ctx.pro.search(jacob, 'ada lovelace', { receipt }), { code: 'local_search_required' }, 'single use')
  const stale = ctx.pro.searchReceipt(jacob, 'ada'); ctx.clock.at += PRO_SEARCH_RECEIPT_TTL_MS
  await assert.rejects(ctx.pro.search(jacob, 'ada', { receipt: stale }), { code: 'local_search_required' }, 'expires after 10 minutes')
  assert.equal(PRO_SEARCH_RECEIPT_TTL_MS, 10 * 60 * 1000)
  for (const [who, query] of [[jacob, '  '], [stranger, 'ada'], [null, 'ada']]) assert.equal(ctx.pro.searchReceipt(who, query), null)
  assert.equal(setup().pro.searchReceipt(jacob, 'ada'), null, 'search switched off issues nothing')
  await ask(ctx, 'b'); await ask(ctx, 'c')
  const restarted = ctx.restart()
  await assert.rejects(restarted.search(jacob, 'd', { receipt: restarted.searchReceipt(jacob, 'd') }), { code: 'daily_limit' }, 'a restart does not reset the count')
  assert.equal(searches(), 3)
})

test('F6: account deletion removes Pro records even with the feature off, keeps going past provider and guard failures, and leaves only pending removals for the sweep', async () => {
  const ctx = setup(); await connect(ctx)
  // A failed attempt from earlier whose account removal is still pending.
  await ctx.store.createAttempt({ attemptId: 'old-attempt', tokenHash: 'old-hash', ownerId: jacob.ownerId, userId: jacob.userId, kind: 'create', generation: 0, state: 'failed', failure: 'account_not_ready', createdAt: ctx.clock.at, expiresAt: ctx.clock.at + PRO_ATTEMPT_TTL_MS, cleanup: 'pending', cleanupAccountId: 'Leftover00001' })
  ctx.unipile.signIn('Leftover00001', me, { statuses: ['CONNECTING'] })
  const cleanup = createProLinkedinCleanup({ store: ctx.store, client: ctx.client, systemAccountIds: [SYSTEM], now: () => ctx.clock.at })
  assert.equal(typeof cleanup.begin, 'undefined', 'cleanup can never start a link')
  ctx.unipile.state.fail = deleteFails
  assert.deepEqual(await cleanup.removeOwner(jacob), { removedAtProvider: false, pending: true })
  const left = await ctx.store.getSource(jacob)
  assert.equal(left.state, 'disconnected'); assert.equal(left.providerRevocation, 'pending'); assert.equal(left.ownerDeleted, true)
  assert.equal((await ctx.store.latestAttempt(jacob)).attemptId, 'old-attempt', 'only the attempt with a pending removal is kept')
  ctx.unipile.state.fail = null
  assert.deepEqual(await cleanup.sweepPendingRemovals(), { revoked: 1, cleaned: 1, skipped: 0, pending: 0 })
  assert.equal(ctx.unipile.accounts.has('AcctJacob0001'), false); assert.equal(ctx.unipile.accounts.has('Leftover00001'), false); assert.equal(ctx.unipile.accounts.has(SYSTEM), true)
  assert.equal(await ctx.store.getSource(jacob), null)
  // A guard failure is rethrown for the caller to record, after everything else of the owner is removed.
  const guarded = setup(); await connect(guarded)
  await guarded.store.putSource({ ...(await guarded.store.getSource(jacob)), accountId: SYSTEM, generation: 2 }, 1)
  await assert.rejects(guarded.pro.removeOwner(jacob), { code: 'protected_account' })
  assert.equal(await guarded.store.getSource(jacob), null); assert.equal(await guarded.store.latestAttempt(jacob), null); assert.equal(guarded.unipile.accounts.has(SYSTEM), true)
  const busy = setup(); await connect(busy); busy.store.putSource = async () => false
  await assert.rejects(busy.pro.removeOwner(jacob), { code: 'superseded' }); assert.equal(await busy.store.latestAttempt(jacob), null)
})

test('a binding stuck past the attempt lifetime shows as failed; a stateless record is not a linked source', async () => {
  const ctx = setup(); await ctx.pro.begin(jacob)
  await ctx.store.settleAttempt((await ctx.store.latestAttempt(jacob)).attemptId, { state: 'binding', settledAt: ctx.clock.at })
  assert.equal((await ctx.pro.status(jacob)).attempt.state, 'pending')
  ctx.clock.at += PRO_ATTEMPT_TTL_MS + 1
  assert.equal((await ctx.pro.status(jacob)).attempt.state, 'failed')
  const stub = setup(); await stub.store.putSource({ ownerId: jacob.ownerId, userId: jacob.userId, generation: 0 }, 0)
  assert.equal((await stub.pro.status(jacob)).source, null); await assert.rejects(stub.pro.check(jacob), { code: 'not_connected' })
  assert.match((await stub.pro.begin(jacob)).url, /^https:\/\/account\.unipile\.com\//)
})
