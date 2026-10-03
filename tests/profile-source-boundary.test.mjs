import test from 'node:test'
import assert from 'node:assert/strict'
import { createLegacyProfileBoundary } from '../mcp-server/profile-source-boundary.mjs'

// Execute the managed transaction interface: changes commit together, and the
// callback's failure rolls back both its legacy claim and source retirement.
test('legacy boundary extends one managed transaction, preserves result, scopes parallel owners and rolls back failures', async () => {
  const transactions = [], sessions = []
  const driver = { session(options) {
    const session = { options, async executeRead(work) { return work({ read: true }) }, async close() { this.closed = true }, async executeWrite(work) {
      const state = { legacy: false, retired: false }, calls = []
      const tx = { async run(query, params) {
        calls.push({ query, params })
        if (query.includes('RETURN b.sourceOwnerId')) return { records: [{ get: () => params.ownerId }] }
        if (query.includes("s.retiredReason='legacy-profile-upgrade-v1'")) { state.retired = state.legacy; return {} }
        state.legacy = true; return 'legacy-write-result'
      } }
      try { const result = await work(tx); transactions.push({ state, calls, result }); return result }
      catch (error) { transactions.push({ state: { legacy: false, retired: false }, calls, rolledBack: true }); throw error }
    } }
    sessions.push(session); return session
  } }
  const boundary = createLegacyProfileBoundary(driver, { now: () => 1000 })
  const commit = async (owner, profileId, fail = false) => boundary.confirm(owner, profileId, async () => {
    const session = boundary.driver.session({ database: 'neo4j' })
    try { return await session.executeWrite(async tx => { await tx.run('CREATE legacy', { ownerId: owner.ownerId }); if (fail) throw Error('failed confirmation'); return { profileId, receiptId: profileId + '-receipt' } }) }
    finally { await session.close() }
  })
  const a = { ownerId: 'a', userId: 'u-a' }, b = { ownerId: 'b', userId: 'u-b' }
  const results = await Promise.all([commit(a, 'legacy-a'), commit(b, 'legacy-b')])
  assert.equal(results[0].profileId, 'legacy-a'); assert.equal(results[1].profileId, 'legacy-b')
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(transactions[i].state, { legacy: true, retired: true })
    assert.equal(transactions[i].calls.length, 3)
    const ownerId = transactions[i].calls[0].params.ownerId
    assert.equal(transactions[i].calls[2].params.ownerId, ownerId)
    assert.equal(transactions[i].calls[2].params.now, 1000)
  }
  await assert.rejects(commit(a, 'legacy-a', true), /failed confirmation/)
  assert.deepEqual(transactions[2].state, { legacy: false, retired: false }); assert.equal(transactions[2].rolledBack, true)
  assert.ok(sessions.every(session => session.closed))
  // Calls outside confirmation context retain the native driver behavior.
  const session = boundary.driver.session({ database: 'neo4j' })
  assert.deepEqual(await session.executeRead(tx => tx), { read: true })
  assert.equal(await session.executeWrite(tx => tx.run('CREATE unrelated', {})), 'legacy-write-result')
  assert.equal(transactions[3].calls.length, 1)
})
