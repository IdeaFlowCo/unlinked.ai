import test from 'node:test'
import assert from 'node:assert/strict'
import { createScopedImportReader, createNoosImportAdapter } from '../src/utils/private-import/noos-adapter.mjs'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'

const ownerId = 'retained-owner', importId = 'a'.repeat(64), assertionId = 'b'.repeat(64)
const publication = { sourceOwnerId: ownerId, sourceRevision: 3, deleted: false, payload: { id: importId, status: 'partial', assertionIds: [assertionId], indexGate: 'ai_search_not_connected' } }
const assertion = { sourceOwnerId: ownerId, deleted: false, payload: { importId, sourceId: 'original-source', subject: 'connection_observation' } }
const grant = { ownerId, importIds: [importId] }
test('scope rejects ungranted imports without querying resource IDs', async () => {
  let calls = 0
  const reader = createScopedImportReader({ grant, readResource: async () => { calls++; return publication } })
  await assert.rejects(reader('ungranted'), /private_import_not_found/)
  assert.equal(calls, 0)
})
test('live publication fences retained assertions, owner mismatch and deletion racing row retrieval', async () => {
  let calls = 0
  const reader = createScopedImportReader({ grant, readResource: async type => {
    calls++
    return type === 'assertion' ? assertion : calls > 1 ? { ...publication, deleted: true, payload: null } : publication
  } })
  await assert.rejects(reader(importId), /private_import_not_found/)
  for (const dead of [{ ...publication, deleted: true }, { ...publication, sourceOwnerId: 'other-owner' }, { ...publication, payload: { status: 'parsing' } },
    { ...publication, payload: { ...publication.payload, receiptOf: importId } }, { ...publication, payload: { ...publication.payload, id: 'another-import' } }]) {
    let rows = 0
    const read = createScopedImportReader({ grant, readResource: async type => { rows += Number(type === 'assertion'); return dead } })
    await assert.rejects(read(importId), /private_import_not_found/); assert.equal(rows, 0)
  }
  const wrongRow = createScopedImportReader({ grant, readResource: async type => type === 'assertion' ? { ...assertion, sourceOwnerId: 'other-owner' } : publication })
  await assert.rejects(wrongRow(importId), /private_publication_incomplete/)
})
test('server configuration requires explicit owner/token and setup keeps credential out of URL', () => {
  assert.throws(() => createNoosImportAdapter({ baseUrl: 'https://noos.invalid' }), /verified_owner_required/)
  assert.throws(() => scopedSetupConfiguration({ endpoint: 'http://public.invalid/mcp', accessToken: 'synthetic' }), /scoped_https_setup_required/)
  assert.throws(() => scopedSetupConfiguration({ endpoint: 'https://private.invalid/mcp?token=synthetic', accessToken: 'synthetic' }), /scoped_https_setup_required/)
  const config = scopedSetupConfiguration({ endpoint: 'https://private.invalid/mcp', accessToken: 'synthetic' })
  assert.equal(config.mcpServers['unlinked-private'].url, 'https://private.invalid/mcp')
  assert.equal(config.mcpServers['unlinked-private'].headers.Authorization, 'Bearer synthetic')
})
