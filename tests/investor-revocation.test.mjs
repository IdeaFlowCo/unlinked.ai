import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers/investor-fixture.mjs'
import { createAccountToolService, AccountToolError } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'

const scope = 'owner_network_and_private_notes'
const owner = { ownerId: 'alice', userId: 'alice', agent: 'revocation-test', scope,
  version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] }
const input = { csv: 'Name,Note\nAda,Private meeting\n', mapping: { name: 'Name', notes: ['Note'] }, listName: 'Investors' }

function revocableFixture() {
  const f = fixture(), lateWrites = []
  let armed, revoked = false, hit = false, sawLookup = false
  const returned = phase => { if (armed === phase) { revoked = true; hit = true } }
  const writing = phase => { if (revoked) lateWrites.push(phase) }
  const getBackend = async grant => {
    const base = await f.getBackend(grant)
    return { ...base,
      async readResource(type, id) {
        const result = await base.readResource(type, id)
        if (result?.payload?.kind === 'investor_csv_v1') returned('job_read')
        if (result?.payload?.kind === 'investor_csv_v1_catalog' || !result) returned('catalog_read')
        return result
      },
      async writeResource(value) {
        writing('resource')
        const result = await base.writeResource(value)
        const kind = value.payload?.kind
        if (kind === 'investor_csv_v1_catalog') returned('catalog_write')
        if (kind === 'investor_csv_v1_row') returned('receipt_write')
        if (kind === 'investor_csv_v1') {
          returned('job_write')
          if (sawLookup && value.payload.lease) returned('row_lease_write')
        }
        return result
      },
      adapter: { withImport: (ownerId, id, work) => base.adapter.withImport(ownerId, id, store => work({
        async putAsset(...args) { writing('asset'); const result = await store.putAsset(...args); returned('asset_write'); return result },
      })) },
    }
  }
  const service = createAccountToolService({ ...f.options, getBackend,
    async identityFor(grant) { const result = await f.options.identityFor(grant); returned('identity'); return result },
    overlay: { async request(identity, method, path, body) {
      if (method === 'POST' && path !== 'lookup') writing('graph')
      const result = await f.options.overlay.request(identity, method, path, body)
      if (path === 'lookup') sawLookup = true
      if (method === 'POST' && path === 'entities') returned(body.kind === 'list' ? 'list_write' : 'person_write')
      if (method === 'POST' && path.endsWith('/notes')) returned('note_write')
      if (method === 'POST' && path.endsWith('/links')) returned('link_write')
      return result
    } },
  })
  return { lateWrites, arm: phase => { armed = phase }, hit: () => hit,
    async call(name, input) {
      return (await service.call({ grant: owner, name, input, revalidate: async () => {
        if (revoked) throw new AccountToolError('grant_revoked', 'Synthetic revocation')
        return owner
      } })).result
    },
  }
}

for (const phase of ['identity', 'catalog_read', 'catalog_write', 'asset_write']) {
  test(`staging stops new writes when permission is revoked during ${phase}`, async () => {
    const f = revocableFixture(); f.arm(phase)
    await assert.rejects(f.call('unlinked_stage_investor_csv', input), error => error.code === 'grant_revoked')
    assert.equal(f.hit(), true)
    assert.deepEqual(f.lateWrites, [])
  })
}

for (const phase of ['job_read', 'identity', 'job_write', 'list_write', 'row_lease_write', 'person_write', 'note_write', 'link_write', 'receipt_write']) {
  test(`resume stops new writes when permission is revoked during ${phase}`, async () => {
    const f = revocableFixture()
    const staged = await f.call('unlinked_stage_investor_csv', input)
    f.arm(phase)
    await assert.rejects(f.call('unlinked_resume_investor_import', { importId: staged.importId }), error => error.code === 'grant_revoked')
    assert.equal(f.hit(), true)
    assert.deepEqual(f.lateWrites, [])
  })
}
