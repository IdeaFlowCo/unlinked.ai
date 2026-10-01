import { privateId } from './job.mjs'

export const PRIVATE_PUBLICATION_ASSERTION_LIMIT = 500
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
    publicationGate: 'ai_search_not_connected',
    publicationPhase: 'awaiting_ai_search',
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
      if (assertions.length > PRIVATE_PUBLICATION_ASSERTION_LIMIT || assertions.length + job.sources.length + 2 > MAX_RESOURCES ||
          Buffer.byteLength(JSON.stringify({ ...job, assertionIds: assertions.map(a => a.id) })) > 60 * 1024 ||
          assertions.some(a => Buffer.byteLength(JSON.stringify(a)) > 60 * 1024)) return 'private_publication_support_limit';
      return null
    },
    async publish(job, assertions) {
      job.assertionIds = assertions.map(a => a.id)
      const items = [mutation('import', job.id, job.revision, { ...job, assertionIds: assertions.map(a => a.id) }, job.revision - 1),
        mutation('import', privateId(ownerId, 'receipt', job.id, job.revision), 1, { ...job, receiptOf: job.id }),
        ...job.sources.map(source => mutation('source', source.id, 1, { ...source, importId: job.id })),
        ...assertions.map(assertion => mutation('assertion', assertion.id, 1, assertion))]
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

// Agent grants never get the operational token or direct resource/asset access.
// Every call reads the live publication: retained rows cannot bypass tombstones.
export function createScopedImportReader({ readResource, grant }) {
  if (!grant || !grant.ownerId || !Array.isArray(grant.importIds) || grant.importIds.length > 32) throw new Error('explicit_import_grant_required')
  const ownerId = grant.ownerId, allowed = new Set(grant.importIds)
  return async function readImport(id) {
    if (!allowed.has(id)) throw new Error('private_import_not_found')
    const resource = await readResource('import', id)
    if (!resource || resource.deleted || resource.sourceOwnerId !== ownerId || !resource.payload ||
        !['partial', 'indexed'].includes(resource.payload.status) || !Array.isArray(resource.payload.assertionIds)) throw new Error('private_import_not_found')
    const rows = []
    if (resource.payload.assertionIds.length > PRIVATE_PUBLICATION_ASSERTION_LIMIT) throw new Error('private_publication_support_limit')
    for (const assertionId of resource.payload.assertionIds) {
      const assertion = await readResource('assertion', assertionId)
      if (!assertion || assertion.deleted || assertion.sourceOwnerId !== ownerId || assertion.payload?.importId !== id) throw new Error('private_publication_incomplete')
      rows.push(assertion.payload)
    }
    // Recheck after row retrieval so a tombstone racing a delayed call wins.
    const latest = await readResource('import', id)
    if (!latest || latest.deleted || latest.sourceRevision !== resource.sourceRevision) throw new Error('private_import_not_found')
    return { importId: id, status: resource.payload.status, indexGate: resource.payload.indexGate, assertions: rows }
  }
}
