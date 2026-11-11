import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicReadAdmission } from '../mcp-server/public-read-admission.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createVerifiedAccess } from '../mcp-server/verified-access.mjs'

const grant = ownerId => ({ ownerId, userId: 'user', tools: ['unlinked_search_network'] })
test('verified readers bypass exhausted quotas and full queues without consuming regular slots', async () => {
  const gate = createPublicReadAdmission({ inFlight: 1, anonymousInFlight: 1, viewerPerMinute: 1, maxQueue: 0 })
  const busy = await gate.acquire({})
  for (let i = 0; i < 300; i++) assert.equal((await gate.acquire({ ownerId: 'verified', verified: true })).reason, 'admitted')
  assert.equal((await gate.acquire({ ownerId: 'regular' })).reason, 'capacity')
  assert.equal((await gate.acquire({ ownerId: 'regular' })).reason, 'minute')
  assert.equal((await gate.acquire({ verified: true })).reason, 'capacity', 'a flag without an authenticated owner confers nothing')
  busy.release()
  const regular = await gate.acquire({ ownerId: 'another' }); assert.equal(regular.reason, 'admitted'); regular.release()
})
test('verified API/MCP searches bypass shared capacity and all account AI quotas; other grants keep limits', async () => {
  const service = createAccountToolService({ getBackend: async () => ({}), isVerified: async owner => owner.ownerId === 'vip', limits: { aiPerMinute: 1, aiPerDay: 1, aiInFlight: 1, aiInFlightTotal: 1 } })
  let release; const pending = service.withSearchBudget(grant('regular'), 'unlinked_search_network', () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(service.withSearchBudget(grant('other'), 'unlinked_search_network', async () => 'no'), { code: 'rate_limited' })
  const results = await Promise.all(Array.from({ length: 50 }, () => service.withSearchBudget(grant('vip'), 'unlinked_search_network', async () => 'yes')))
  assert.equal(results.length, 50)
  release(); await pending
  await assert.rejects(service.withSearchBudget(grant('regular'), 'unlinked_search_network', async () => 'no'), { code: 'rate_limited' })
  await assert.rejects(service.withSearchBudget({ ...grant('vip'), tools: [] }, 'unlinked_search_network', async () => 'no'), { code: 'scope_not_granted' })
})
test('tier comes from an active exact owner/user binding, with bounded cache and prompt revocation', async () => {
  let time = 0, active = true, vip = true, reads = 0
  const driver = { session: () => ({ close: async () => {}, executeRead: async work => work({ run: async (_query, args) => { reads++; return { records: active && args.ownerId === 'owner' && args.userId === 'user' ? [{ get: () => vip }] : [] } } }) }) }
  const verified = createVerifiedAccess({ driver, now: () => time })
  assert.equal(await verified({ ownerId: 'owner', userId: 'user' }), true)
  assert.equal(await verified({ ownerId: 'owner', userId: 'user' }), true); assert.equal(reads, 1)
  assert.equal(await verified({ ownerId: 'owner', userId: 'stranger', verified: true }), false)
  vip = false; time += 1001
  assert.equal(await verified({ ownerId: 'owner', userId: 'user' }), false)
  vip = true; active = false; time += 1001
  assert.equal(await verified({ ownerId: 'owner', userId: 'user' }), false)
})
