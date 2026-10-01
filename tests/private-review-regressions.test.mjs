import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createNoosImportAdapter, createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'

const ownerId = 'synthetic-review-owner', importId = 'a'.repeat(64), rowId = 'b'.repeat(64), otherId = 'c'.repeat(64), chunkId = 'd'.repeat(64)
const counts = { accepted: 1, indexed: 1, rejected: 2, skippedFiles: 0, failedFiles: 1 }
const manifest = { sourceOwnerId: ownerId, sourceRevision: 3, payload: { id: importId, ownerId, status: 'partial', counts, assertionIds: [rowId] } }
const row = { id: rowId, ownerId, importId, sourceId: 'e'.repeat(64), category: 'connections', fields: { position: 'Engineer' } }
const resource = payload => ({ sourceOwnerId: ownerId, payload })
const read = (publication, rows = new Map([[rowId, resource(row)]]), extra = {}) => createScopedImportReader({ grant: { ownerId, importIds: [importId] }, readResource: async (type, id) => type === 'assertion' ? rows.get(id) : publication, ...extra })

test('terminal readers reject incomplete counts and mismatched ordinary/asset row identities before output', async () => {
  assert.equal((await read(manifest)(importId)).assertions.length, 1)
  for (const changed of [{ accepted: 1001 }, { indexed: 0 }, { accepted: 1.5 }, { rejected: -1 }, { failedFiles: Number.MAX_SAFE_INTEGER + 1 }, { indexed: '1' }]) {
    const publication = { ...manifest, payload: { ...manifest.payload, counts: { ...counts, ...changed } } }
    await assert.rejects(read(publication)(importId), /private_publication_incomplete/)
  }
  for (const bad of [{ ...row, id: otherId }, { ...row, ownerId: 'other-owner' }, { ...row, importId: otherId }]) {
    await assert.rejects(read(manifest, new Map([[rowId, resource(bad)]]))(importId), /private_publication_incomplete/)
    await assert.rejects(read(manifest, new Map([[rowId, resource({ ...row, fullObservationAsset: 'f'.repeat(64) })]]), { readAsset: async () => Buffer.from(JSON.stringify(bad)) })(importId), /private_publication_incomplete/)
  }
  const duplicate = { ...manifest, payload: { ...manifest.payload, assertionIds: [rowId, otherId], counts: { ...counts, accepted: 2, indexed: 2 } } }
  await assert.rejects(read(duplicate, new Map([[rowId, resource(row)], [otherId, resource(row)]]))(importId), /private_publication_incomplete/)
  const duplicatedIds = { ...duplicate, payload: { ...duplicate.payload, assertionIds: [rowId, rowId] } }
  await assert.rejects(read(duplicatedIds)(importId), /private_publication_incomplete/)
})

test('chunk manifests validate owner, ordinal and cardinality', async () => {
  const publication = { ...manifest, payload: { ...manifest.payload, assertionIds: undefined, assertionChunks: [chunkId], indexVersion: 'observation-v1' } }
  const chunk = { kind: 'private_observation_chunk', ownerId, importId, ordinal: 0, indexedCount: 1, assertionIds: [rowId] }
  for (const changed of [{}, { ownerId: 'other-owner' }, { ordinal: 1 }, { indexedCount: 2 }, { assertionIds: [rowId, rowId] }]) {
    const reader = createScopedImportReader({ grant: { ownerId, importIds: [importId] }, readResource: async (type, id) => type === 'assertion' ? resource(row) : id === importId ? publication : resource({ ...chunk, ...changed }) })
    if (Object.keys(changed).length) await assert.rejects(reader(importId), /private_publication_incomplete/)
    else assert.equal((await reader(importId)).indexed, 1)
  }
})

test('search without the combined upload receipt never calls the provider', async () => {
  let calls = 0
  const search = createPrivateSearch({ readImport: read(manifest), complete: async () => { calls++; return { matches: [] } } })
  await assert.rejects(search({ importId, query: 'engineer' }), /private_upload_consent_required/)
  assert.equal(calls, 0)
})

for (const stalledPhase of ['asset', 'final-body']) test(`bounded ${stalledPhase} request releases import queue and preserves immutable replay`, async () => {
  const resources = new Map(), assets = new Map()
  let stalled = false, stalledSignal
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    if (path.includes('/assets/')) {
      assets.set(path, Buffer.from(init.body))
      if (stalledPhase === 'asset' && !stalled) { stalled = true; stalledSignal = init.signal; return new Promise(() => {}) }
      return Response.json({ stored: true })
    }
    if (path.endsWith('/batch')) {
      const mutations = JSON.parse(init.body)
      for (const mutation of mutations) {
        const key = `${mutation.type}/${mutation.sourceId}`, existing = resources.get(key)
        if (existing && mutation.sourceRevision === existing.sourceRevision) assert.deepEqual(mutation, existing)
        resources.set(key, structuredClone(mutation))
      }
      if (stalledPhase === 'final-body' && !stalled && mutations.some(item => item.payload?.assertionChunks)) {
        stalled = true; stalledSignal = init.signal
        return { status: 200, ok: true, json: () => new Promise(() => {}) }
      }
      return Response.json({ stored: true })
    }
    const key = path.split('/unlinked/')[1]
    return resources.has(key) ? Response.json(resources.get(key)) : new Response(null, { status: 404 })
  }
  const adapter = createNoosImportAdapter({ baseUrl: 'https://synthetic.invalid', accessToken: 'synthetic', ownerId, fetchImpl, requestTimeoutMs: 25 })
  const input = { ownerId, filename: 'Connections.csv', bytes: Buffer.from('First Name,Last Name,URL,Company,Position\nAda,Example,https://www.linkedin.com/in/synthetic-review,Synthetic,Engineer\n'), adapter, consent: COMBINED_UPLOAD_CONSENT }
  const failed = ingestArchive(input)
  const queuedReplay = ingestArchive(input)
  await assert.rejects(failed, /private_noos_timeout/)
  const result = await queuedReplay
  assert.equal(stalledSignal.aborted, true)
  assert.equal(result.counts.accepted, 1); assert.equal(result.counts.indexed, 1)
  assert.deepEqual(result.consent, COMBINED_UPLOAD_CONSENT)
  assert.deepEqual(await ingestArchive({ ...input, consent: undefined }), result)
  const source = resources.get(`source/${result.sources[0].id}`)
  assert.deepEqual(source.payload.consent, COMBINED_UPLOAD_CONSENT)
  const receiptCount = [...resources.values()].filter(item => item.payload.receiptOf === result.id).length
  assert.equal(receiptCount, 3)
  const reader = createScopedImportReader({ grant: { ownerId, importIds: [result.id] }, readResource: async (type, id) => resources.get(`${type}/${id}`) })
  assert.equal((await reader(result.id)).assertions.length, 1)
  assert.ok(assets.size > 0)
})
