import { privateId } from './job.mjs'
import { digest } from './archive.mjs'

export const PRIVATE_PUBLICATION_ASSERTION_LIMIT = 100000
const CHUNK_ROWS = 200
const MAX_RESOURCES = 600
const MAX_RESOURCE_BYTES = 64 * 1024

// Explicit server-only staging configuration. No default URL, token or owner;
// issuer/subject mapping and Noos binding must already have been verified.
export function createNoosImportAdapter({ baseUrl, accessToken, ownerId, fetchImpl = fetch }) {
  const endpoint = new URL(baseUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'))) throw new Error('private_noos_endpoint_required')
  if (!accessToken || typeof ownerId !== 'string' || !ownerId) throw new Error('verified_owner_required')
  const root = baseUrl.replace(/\/$/, '')
  const queues = new Map()
  async function request(path, { method = 'GET', body, bytes } = {}) {
    const response = await fetchImpl(`${root}/unlinked/${path}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${accessToken}`, ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      ...(bytes ? { body: bytes } : body ? { body: JSON.stringify(body) } : {}) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`private_noos_${response.status}`)
    return response.json()
  }
  const mutation = (type, sourceId, revision, payload, expectedRevision = null) => ({
    namespace: 'unlinked', type, sourceId, sourceOwnerId: ownerId, sourceRevision: revision,
    expectedRevision, audience: 'owner', deleted: false, payload,
  })
  async function batch(items) {
    if (items.length > MAX_RESOURCES || items.some(item => Buffer.byteLength(JSON.stringify(item)) > MAX_RESOURCE_BYTES)) throw new Error('private_publication_support_limit')
    const result = await request('batch', { method: 'POST', body: items })
    if (!result) throw new Error('private_noos_binding_not_found')
  }
  const store = {
    publicationGate: null,
    publicationPhase: 'private_observation_index_ready',
    publicationStatus: 'indexed',
    compactSourceReceipts: true,
    async getJob(id) {
      const resource = await request(`import/${encodeURIComponent(id)}`)
      if (!resource) return null
      if (resource.deleted) throw new Error('private_import_deleted')
      return resource.payload
    },
    async putAsset(sha256, bytes) {
      if (!await request(`assets/${encodeURIComponent(ownerId)}/${sha256}`, { method: 'PUT', bytes })) throw new Error('private_noos_binding_not_found')
    },
    async saveJob(job) {
      await batch([mutation('import', job.id, job.revision, job, job.revision === 1 ? null : job.revision - 1),
        mutation('import', privateId(ownerId, 'receipt', job.id, job.revision), 1, { ...job, receiptOf: job.id })])
    },
    validatePublication(job, assertions) {
      const chunks = Math.ceil(assertions.length / CHUNK_ROWS)
      if (assertions.length > PRIVATE_PUBLICATION_ASSERTION_LIMIT || job.sources.length + 2 > MAX_RESOURCES ||
          Buffer.byteLength(JSON.stringify({ ...job, sources: job.sources.map(source => ({ id: source.id })), assertionChunks: Array.from({ length: chunks }, () => 'a'.repeat(64)) })) > 60 * 1024 ||
          job.sources.some(source => Buffer.byteLength(JSON.stringify(source)) > 60 * 1024)) return 'private_publication_support_limit';
      return null
    },
    async publish(job, assertions) {
      const chunkIds = []
      for (let start = 0; start < assertions.length; start += CHUNK_ROWS) {
        const rows = assertions.slice(start, start + CHUNK_ROWS), chunkId = privateId(ownerId, 'index-chunk', job.id, start / CHUNK_ROWS)
        const items = []
        for (const row of rows) {
          let indexed = { ...row, privateIndex: { version: 'observation-v1', category: row.category } }
          if (Buffer.byteLength(JSON.stringify(indexed)) > 60 * 1024) {
            const bytes = Buffer.from(JSON.stringify(row))
            // Oversized observations live as immutable private assets; graph
            // metadata retains exact content digest and row provenance.
            const contentSha256 = digest(bytes)
            await store.putAsset(contentSha256, bytes)
            indexed = { id: row.id, ownerId, sourceId: row.sourceId, importId: row.importId, rowId: row.rowId, category: row.category,
              subject: row.subject, visibility: 'owner', fullObservationAsset: contentSha256, privateIndex: { version: 'observation-v1', category: row.category } }
          }
          items.push(mutation('assertion', row.id, 1, indexed))
        }
        items.push(mutation('import', chunkId, 1, { kind: 'private_observation_chunk', ownerId, importId: job.id, ordinal: start / CHUNK_ROWS,
          assertionIds: rows.map(row => row.id), indexedCount: rows.length, indexVersion: 'observation-v1' }))
        // Immutable batches are invisible to tools until the final publication.
        // Exact retries reuse IDs/content; tombstones can never be resurrected.
        await batch(items)
        chunkIds.push(chunkId)
      }
      job.assertionChunks = chunkIds
      job.indexVersion = 'observation-v1'
      const sources = job.sources.map(source => source.acceptedCount ? { ...source, indexedCount: source.acceptedCount, status: 'indexed' } : source)
      job.sources = sources.map(source => ({ id: source.id }))
      const items = [mutation('import', job.id, job.revision, job, job.revision - 1),
        mutation('import', privateId(ownerId, 'receipt', job.id, job.revision), 1, { ...job, receiptOf: job.id }),
        ...sources.map(source => mutation('source', source.id, 1, { ...source, importId: job.id }))]
      await batch(items)
    },
  }
  return {
    async withImport(callerOwnerId, id, work) {
      if (callerOwnerId !== ownerId) throw new Error('private_owner_mismatch')
      const previous = queues.get(id) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(() => work(store))
      queues.set(id, current)
      try { return await current } finally { if (queues.get(id) === current) queues.delete(id) }
    },
  }
}

export function createNoosOwnerBackend({ baseUrl, accessToken, ownerId, fetchImpl = fetch }) {
  const adapter = createNoosImportAdapter({ baseUrl, accessToken, ownerId, fetchImpl })
  const endpoint = `${baseUrl.replace(/\/$/, '')}/unlinked`
  async function request(path, options = {}) {
    const response = await fetchImpl(`${endpoint}/${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`private_noos_${response.status}`)
    return response
  }
  return {
    adapter,
    async readResource(type, id) {
      if (!['import', 'assertion', 'source'].includes(type) || !/^[a-f0-9]{64}$/.test(id)) throw new Error('private_resource_key_invalid')
      const response = await request(`${type}/${id}`)
      return response ? response.json() : null
    },
    async writeResource(input) {
      if (input.namespace !== 'unlinked' || input.sourceOwnerId !== ownerId || !/^[a-f0-9]{64}$/.test(input.sourceId) || input.type !== 'import') throw new Error('private_resource_key_invalid')
      const { namespace: _namespace, type: _type, sourceId: _sourceId, ...payload } = input
      const response = await request(`${input.type}/${input.sourceId}`, { method: 'PUT', body: JSON.stringify(payload) })
      if (!response) throw new Error('private_noos_binding_not_found')
      return response.json()
    },
    async readAsset(sha256) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('private_asset_key_invalid')
      const response = await request(`assets/${encodeURIComponent(ownerId)}/${sha256}`)
      if (!response) throw new Error('private_observation_recovery_unavailable')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 20 * 1024 * 1024 || digest(bytes) !== sha256) throw new Error('private_asset_invalid')
      return bytes
    },
  }
}

// Agent grants never get the operational token or direct resource/asset access.
// Every call reads the live publication: retained rows cannot bypass tombstones.
export function createScopedImportReader({ readResource, readAsset, grant }) {
  if (!grant || !grant.ownerId || !Array.isArray(grant.importIds) || grant.importIds.length > 32) throw new Error('explicit_import_grant_required')
  const ownerId = grant.ownerId, allowed = new Set(grant.importIds)
  return async function readImport(id) {
    if (!allowed.has(id)) throw new Error('private_import_not_found')
    const resource = await readResource('import', id)
    if (!resource || resource.deleted || resource.sourceOwnerId !== ownerId || !resource.payload ||
        !['partial', 'indexed'].includes(resource.payload.status)) throw new Error('private_import_not_found')
    const rows = []
    let ids = resource.payload.assertionIds
    if (Array.isArray(resource.payload.assertionChunks)) {
      if (resource.payload.assertionChunks.length > Math.ceil(PRIVATE_PUBLICATION_ASSERTION_LIMIT / CHUNK_ROWS)) throw new Error('private_publication_support_limit')
      ids = []
      for (const [ordinal, chunkId] of resource.payload.assertionChunks.entries()) {
        const chunk = await readResource('import', chunkId)
        if (!chunk || chunk.deleted || chunk.sourceOwnerId !== ownerId || chunk.payload?.kind !== 'private_observation_chunk' || chunk.payload.importId !== id || chunk.payload.ordinal !== ordinal || !Array.isArray(chunk.payload.assertionIds) || chunk.payload.assertionIds.length > CHUNK_ROWS || chunk.payload.indexedCount !== chunk.payload.assertionIds.length) throw new Error('private_publication_incomplete')
        ids.push(...chunk.payload.assertionIds)
      }
    }
    if (!Array.isArray(ids) || ids.length > PRIVATE_PUBLICATION_ASSERTION_LIMIT || new Set(ids).size !== ids.length || (resource.payload.indexVersion && ids.length !== resource.payload.counts?.indexed)) throw new Error('private_publication_incomplete')
    for (const assertionId of ids) {
      const assertion = await readResource('assertion', assertionId)
      if (!assertion || assertion.deleted || assertion.sourceOwnerId !== ownerId || assertion.payload?.importId !== id) throw new Error('private_publication_incomplete')
      let row = assertion.payload
      if (row.fullObservationAsset) {
        if (typeof readAsset !== 'function') throw new Error('private_observation_recovery_unavailable')
        row = JSON.parse((await readAsset(row.fullObservationAsset)).toString('utf8'))
        if (row.id !== assertionId || row.ownerId !== ownerId || row.importId !== id || row.sourceId !== assertion.payload.sourceId) throw new Error('private_publication_incomplete')
      }
      rows.push(row)
    }
    // Recheck after row retrieval so a tombstone racing a delayed call wins.
    const latest = await readResource('import', id)
    if (!latest || latest.deleted || latest.sourceRevision !== resource.sourceRevision) throw new Error('private_import_not_found')
    return { importId: id, status: resource.payload.status, indexGate: resource.payload.indexGate, indexed: resource.payload.counts?.indexed ?? 0, indexVersion: resource.payload.indexVersion, assertions: rows }
  }
}
