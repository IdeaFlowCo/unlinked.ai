import test from 'node:test'
import assert from 'node:assert/strict'
import { ACCESS_TIER, TIER_LIMITS, limitsForTier, sharedExportAllowed, tierResolver } from '../mcp-server/access-tiers.mjs'
import { createAccessTier, createVerifiedAccess } from '../mcp-server/verified-access.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createBulkExports } from '../mcp-server/bulk-exports.mjs'
import { renderSettings, renderDownloads } from '../mcp-server/private-onboarding-views.mjs'
import { operateVerifiedAccess, resolveProfileAccount } from '../mcp-server/verified-access-operator.mjs'

const grant = ownerId => ({ ownerId, userId: 'user', tools: ['unlinked_search_network', 'unlinked_whoami'] })
const tiers = { vip: 'verified', friend: 'approved' }
const accessTier = async owner => tiers[owner?.ownerId] ?? 'standard'

test('approved limits are the documented multiples of standard; verified and standard never change shared ceilings', () => {
  assert.deepEqual(limitsForTier(ACCESS_TIER.approved), TIER_LIMITS.approved)
  assert.equal(limitsForTier(ACCESS_TIER.standard), TIER_LIMITS.standard)
  assert.equal(limitsForTier('unknown'), TIER_LIMITS.standard)
  assert.equal(TIER_LIMITS.standard.deterministicPerMinute, 120)
  assert.equal(TIER_LIMITS.standard.aiPerMinute, 20)
  assert.deepEqual([sharedExportAllowed('verified'), sharedExportAllowed('approved'), sharedExportAllowed('standard')], [true, true, false])
})

test('tier resolution: verified outranks approved, inactive or partial bindings are standard, legacy isVerified callers still work', async () => {
  let time = 0, active = true, row = { verified: false, approved: true }, reads = 0
  const driver = { session: () => ({ close: async () => {}, executeRead: async work => work({ run: async (_q, args) => { reads++; return { records: active && args.ownerId === 'owner' && args.userId === 'user' ? [{ get: key => row[key] }] : [] } } }) }) }
  const tier = createAccessTier({ driver, now: () => time }), verified = createVerifiedAccess({ driver, now: () => time })
  assert.equal(await tier({ ownerId: 'owner', userId: 'user' }), 'approved')
  assert.equal(await tier({ ownerId: 'owner', userId: 'user' }), 'approved'); assert.equal(reads, 1)
  assert.equal(await verified({ ownerId: 'owner', userId: 'user' }), false)
  assert.equal(await tier({ ownerId: 'owner', userId: 'other', approved: true }), 'standard')
  assert.equal(await tier({ ownerId: 'owner' }), 'standard')
  row = { verified: true, approved: true }; time += 1001
  assert.equal(await tier({ ownerId: 'owner', userId: 'user' }), 'verified')
  row = { verified: false, approved: false }; time += 1001
  assert.equal(await tier({ ownerId: 'owner', userId: 'user' }), 'standard', 'revocation applies after the one-second cache')
  row = { verified: false, approved: true }; active = false; time += 1001
  assert.equal(await tier({ ownerId: 'owner', userId: 'user' }), 'standard')
  assert.equal(await tierResolver({ isVerified: async () => true })({}), 'verified')
  assert.equal(await tierResolver({})({}), 'standard')
})

test('API/MCP deterministic budget: approved gets 5x, standard keeps the default, verified is unmetered', async () => {
  const service = createAccountToolService({ getBackend: async () => ({ listImportIds: async () => [] }), accessTier, limits: { deterministicPerMinute: 2 } })
  const calls = async (owner, n) => { const out = []; for (let i = 0; i < n; i++) out.push(await service.call({ grant: grant(owner), name: 'unlinked_whoami' }).then(() => 'ok', error => error.code)); return out }
  assert.deepEqual(await calls('regular', 3), ['ok', 'ok', 'rate_limited'])
  assert.deepEqual(await calls('friend', 11), [...Array(10).fill('ok'), 'rate_limited'])
  assert.deepEqual(await calls('vip', 30), Array(30).fill('ok'))
})

test('AI budget: approved gets 3x per minute and 2x in flight but still respects the shared runtime ceiling', async () => {
  const service = createAccountToolService({ getBackend: async () => ({}), accessTier, limits: { aiPerMinute: 1, aiPerDay: 100, aiInFlight: 1, aiInFlightTotal: 3 } })
  const run = owner => service.withSearchBudget(grant(owner), 'unlinked_search_network', async () => 'ok').catch(error => error.code)
  assert.deepEqual([await run('regular'), await run('regular')], ['ok', 'rate_limited'])
  assert.deepEqual([await run('friend'), await run('friend'), await run('friend'), await run('friend')], ['ok', 'ok', 'ok', 'rate_limited'])
  const held = []
  const hold = owner => service.withSearchBudget(grant(owner), 'unlinked_search_network', () => new Promise(resolve => held.push(resolve)))
  tiers['friend-2'] = 'approved'
  const busy = [hold('friend-2'), hold('friend-2')]
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await run('friend-3'), 'ok')
  assert.equal(await hold('friend-2').catch(error => error.code), 'rate_limited', 'per-owner in-flight is 2 for approved')
  tiers['friend-4'] = 'approved'
  const third = hold('friend-4'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(await run('friend-5'), 'rate_limited', 'the shared ceiling of 3 is unchanged')
  held.forEach(resolve => resolve('done')); await Promise.all([...busy, third])
})

test('shared-network downloads are open to approved and verified accounts only', async () => {
  const exports = createBulkExports({ getBackend: async () => ({}), accessTier })
  for (const owner of ['friend', 'vip']) assert.equal((await exports.manifest(grant(owner), { scope: 'everyone' }, { publicAllowed: true })).scope, 'everyone')
  await assert.rejects(exports.manifest(grant('regular'), { scope: 'all' }, { publicAllowed: true }), { code: 'scope_not_granted' })
  await assert.rejects(exports.manifest(grant('friend'), { scope: 'everyone' }, { publicAllowed: false }), { code: 'scope_not_granted' }, 'tier never widens a grant scope')
  assert.equal((await exports.manifest(grant('regular'), { scope: 'mine' }, {})).scope, 'mine')
})

test('Settings shows one quiet Enhanced access line for approved accounts and nothing for others', () => {
  const props = { accountLabel: 'Synthetic', displayName: 'Synthetic', csrf: 'c' }
  const page = value => renderSettings(value).content, approved = page({ ...props, enhancedAccess: true }), standard = page(props), verified = page({ ...props, verified: true, enhancedAccess: false })
  assert.match(approved, /<p class="small" id="enhanced-access"><b>Enhanced access<\/b> · Higher limits for bulk downloads and agent requests\./)
  assert.match(approved, /href="\/downloads\?scope=all"/)
  assert.doesNotMatch(approved, /class="notice[^"]*"[^>]*>[^<]*Enhanced/, 'not a banner or notice')
  assert.doesNotMatch(standard, /Enhanced access/)
  assert.doesNotMatch(verified, /id="enhanced-access"/)
  assert.match(verified, /Verified access/)
  assert.match(renderDownloads({ ...props, input: { scope: 'all', query: '', format: 'csv', detail: 'summary', ids: [], fields: [], filters: {} }, verified: true }).content, /Everyone visible to me/)
})

function fakeGraph() {
  const owners = new Map([['11111111-1111-4111-8111-111111111111', { userId: '22222222-2222-4222-8222-222222222222', props: {} }]])
  const signup = new Map([['member-signup-' + 'a'.repeat(64), ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']]])
  const events = []
  const record = obj => ({ get: key => obj[key], toObject: () => obj })
  const run = async (query, args) => {
    if (query.includes('UnlinkedSignupProfile')) { const hit = signup.get(args.id); return { records: hit && owners.get(hit[0])?.userId === hit[1] ? [record({ ownerId: hit[0], userId: hit[1] })] : [] } }
    if (query.includes('UnlinkedLegacyAccount') || query.includes('OperationalResource')) return { records: [] }
    const owner = owners.get(args.ownerId)
    if (!owner || owner.userId !== args.userId) return { records: [] }
    if (query.includes('CREATE (e:UnlinkedVerificationEvent')) {
      if (query.includes('unlinkedApproved=$value')) Object.assign(owner.props, { approved: args.value, approvedBy: args.actor }); else owner.props.verified = args.value
      events.push({ ...args, query }); return { records: [record({ ownerId: args.ownerId })] }
    }
    return { records: [record({ ownerId: args.ownerId, userId: args.userId, verified: owner.props.verified ?? false, approved: owner.props.approved ?? false, approvedChangedBy: owner.props.approvedBy ?? null })] }
  }
  return { events, session: { executeRead: work => work({ run }), executeWrite: work => work({ run }) } }
}

test('operator approves and unapproves with an attributed tier event; seeds resolve every profile before writing', async () => {
  const { session, events } = fakeGraph(), owner = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222'
  const approved = await operateVerifiedAccess({ session, args: ['approve', owner, user, 'operator', 'reviewed seed'] })
  assert.equal(approved.approved, true); assert.equal(approved.verified, false); assert.equal(approved.approvedChangedBy, 'operator')
  assert.match(events[0].query, /tier:\$tier,approved:\$value/); assert.equal(events[0].tier, 'approved')
  assert.equal((await operateVerifiedAccess({ session, args: ['unapprove', owner, user, 'operator', 'revoked'] })).approved, false)
  await assert.rejects(operateVerifiedAccess({ session, args: ['approve', owner, user] }), /verified_access_arguments_invalid/)
  await assert.rejects(operateVerifiedAccess({ session, args: ['approve', owner, '33333333-3333-4333-8333-333333333333', 'operator', 'x'] }), /verified_access_active_owner_required/)
  assert.deepEqual(await resolveProfileAccount(session, 'member-signup-' + 'a'.repeat(64)), { ownerId: owner, userId: user })
  assert.equal(await resolveProfileAccount(session, 'not-a-member'), null)
  const before = events.length
  const partial = await operateVerifiedAccess({ session, args: ['approve-profiles', 'seed.json', 'operator', 'seed'], readFile: () => JSON.stringify({ approve: [{ name: 'A', profileId: 'member-signup-' + 'a'.repeat(64) }, { name: 'B', profileId: 'unknown-profile' }] }) })
  assert.deepEqual(partial, { applied: false, unresolved: ['unknown-profile'] }); assert.equal(events.length, before, 'no writes when any seed row is unresolved')
  const applied = await operateVerifiedAccess({ session, args: ['approve-profiles', 'seed.json', 'operator', 'seed'], readFile: () => JSON.stringify({ approve: [{ name: 'A', profileId: 'member-signup-' + 'a'.repeat(64) }] }) })
  assert.deepEqual(applied, { applied: true, results: [{ profileId: 'member-signup-' + 'a'.repeat(64), approved: true, verified: false }] })
})

test('the reviewed seed file carries names and public profile ids only', async () => {
  const { readFile } = await import('node:fs/promises')
  const seed = JSON.parse(await readFile(new URL('../deploy/private-pilot/approved-access-seed.json', import.meta.url), 'utf8'))
  assert.ok(seed.selectionRule.length > 50)
  assert.ok(seed.approve.some(row => row.name === 'Jacob Cole') && seed.approve.some(row => row.name === 'Shan Zhong'))
  assert.equal(new Set(seed.approve.map(row => row.profileId)).size, seed.approve.length)
  assert.doesNotMatch(JSON.stringify(seed), /@[a-z0-9-]+\.[a-z]/i, 'no email addresses')
  for (const row of seed.approve) assert.deepEqual(Object.keys(row).sort(), ['evidence', 'name', 'profileId'])
})
