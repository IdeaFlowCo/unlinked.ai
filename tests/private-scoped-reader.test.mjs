import test from 'node:test'
import assert from 'node:assert/strict'
import { createScopedImportReader, createNoosImportAdapter } from '../src/utils/private-import/noos-adapter.mjs'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'

const ownerId = 'retained-owner', importId = 'a'.repeat(64), assertionId = 'b'.repeat(64)
const publication = { sourceOwnerId: ownerId, sourceRevision: 3, deleted: false, payload: { id: importId, status: 'partial', assertionIds: [assertionId], counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, indexGate: 'ai_search_not_connected' } }
const assertion = { sourceOwnerId: ownerId, deleted: false, payload: { id: assertionId, ownerId, importId, sourceId: 'original-source', subject: 'connection_observation' } }
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

test('scoped reads bound parallel work, preserve manifest order and enforce the final deletion fence', async () => {
  const ids = Array.from({ length: 25 }, (_, ordinal) => ordinal.toString(16).padStart(64, '0'))
  const live = { ...publication, payload: { ...publication.payload, assertionIds: ids,
    counts: { ...publication.payload.counts, accepted: ids.length, indexed: ids.length } } }
  let active = 0, maximum = 0, completed = 0, deleted = false
  const reader = createScopedImportReader({ grant, readResource: async (type, id) => {
    if (type === 'import') return deleted ? { ...live, deleted: true } : live
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 1 + (7 - ids.indexOf(id) % 8)))
    active--; completed++
    return { ...assertion, payload: { ...assertion.payload, id } }
  } })
  assert.deepEqual((await reader(importId)).assertions.map(row => row.id), ids)
  assert.ok(maximum > 1); assert.ok(maximum <= 8); assert.equal(completed, 25)
  completed = 0
  const racing = createScopedImportReader({ grant, readResource: async (type, id) => {
    if (type === 'import') return deleted ? { ...live, deleted: true } : live
    completed++; if (completed === ids.length) deleted = true
    return { ...assertion, payload: { ...assertion.payload, id } }
  } })
  await assert.rejects(racing(importId), /private_import_not_found/)
})

test('aborting a parallel read prevents later batches and an invalid owner row fails the whole read', async () => {
  const ids = Array.from({ length: 17 }, (_, ordinal) => ordinal.toString(16).padStart(64, '0'))
  const live = { ...publication, payload: { ...publication.payload, assertionIds: ids,
    counts: { ...publication.payload.counts, accepted: ids.length, indexed: ids.length } } }
  const controller = new AbortController(); let calls = 0
  const reader = createScopedImportReader({ grant, readResource: async (type, id) => {
    if (type === 'import') return live
    calls++; if (calls === 8) controller.abort()
    return { ...assertion, payload: { ...assertion.payload, id } }
  } })
  await assert.rejects(reader(importId, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 8)
  const bad = createScopedImportReader({ grant, readResource: async (type, id) => type === 'import' ? live :
    { ...assertion, payload: { ...assertion.payload, id, ownerId: id === ids[3] ? 'another-owner' : ownerId } } })
  await assert.rejects(bad(importId), /private_publication_incomplete/)
})
