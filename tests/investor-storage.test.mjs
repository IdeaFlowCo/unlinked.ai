import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoosOwnerBackend } from '../src/utils/private-import/noos-adapter.mjs'

test('atomic import publication uses the owner batch endpoint without broadening deletion batches', async () => {
  const requests = [], ownerId = 'synthetic-owner'
  const backend = createNoosOwnerBackend({ baseUrl: 'https://synthetic.invalid/v1', ownerId, accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ committed: true }) },
  })
  const item = { namespace: 'unlinked', type: 'import', sourceId: 'a'.repeat(64), sourceOwnerId: ownerId,
    audience: 'owner', deleted: false, sourceRevision: 1, expectedRevision: null, payload: { kind: 'investor_csv_v1' } }
  assert.deepEqual(await backend.writeImportBatch([item]), { committed: true })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://synthetic.invalid/v1/unlinked/batch')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), [item])
  for (const change of [{ sourceOwnerId: 'foreign' }, { audience: 'public' }, { type: 'assertion' }, { deleted: true }, { payload: null }]) {
    await assert.rejects(backend.writeImportBatch([{ ...item, ...change }]), /private_resource_key_invalid/)
  }
  await assert.rejects(backend.writeBatch([item]), /private_resource_key_invalid/)
  assert.equal(requests.length, 1)
})
