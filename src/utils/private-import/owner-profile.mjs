import { createScopedImportReader } from './noos-adapter.mjs'
import { privateId } from './job.mjs'

const own = new Set(['profile', 'positions', 'education', 'skills'])
const live = (resource, ownerId, id) => resource && !resource.deleted && resource.sourceOwnerId === ownerId && resource.payload?.id === id && resource.payload.ownerId === ownerId && !resource.payload.kind && !resource.payload.receiptOf

// Browser-only early profile view. Pending observations are never passed to
// the search/MCP reader; every read checks the live owner/job fence again.
export async function readOwnerProfileRows({ ownerId, jobs, backend }) {
  const rows = []
  for (const resource of jobs) {
    const id = resource?.sourceId
    if (!live(resource, ownerId, id)) throw new Error('private_import_not_found')
    const job = resource.payload
    if (job.backgroundVersion !== 'profile-first-v1') {
      if (['indexed', 'partial'].includes(job.status)) {
        const read = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId, importIds: [id] } })
        rows.push(...(await read(id)).assertions.filter(row => own.has(row.category)))
      }
      continue
    }
    if (!job.progress?.profileReady) continue
    const chunkIds = job.assertionChunks ?? job.stagedChunks
    if (!Array.isArray(chunkIds) || chunkIds.length > 501 || new Set(chunkIds).size !== chunkIds.length) throw new Error('private_profile_incomplete')
    if (job.profileChunkCount !== undefined && (!Number.isSafeInteger(job.profileChunkCount) || job.profileChunkCount < 0 || job.profileChunkCount > chunkIds.length)) throw new Error('private_profile_incomplete')
    const profileChunkCount = job.profileChunkCount ?? null
    for (const [ordinal, chunkId] of chunkIds.entries()) {
      if (profileChunkCount !== null && ordinal >= profileChunkCount) break
      if (chunkId !== privateId(ownerId, 'index-chunk', id, ordinal)) throw new Error('private_profile_incomplete')
      const chunk = await backend.readResource('import', chunkId), payload = chunk?.payload
      if (!chunk || chunk.deleted || chunk.sourceOwnerId !== ownerId || payload?.ownerId !== ownerId || payload.importId !== id || payload.ordinal !== ordinal || payload.kind !== 'private_observation_chunk' || !Array.isArray(payload.profileAssertionIds) || !Array.isArray(payload.assertionIds) || payload.assertionIds.length > 200 || payload.indexedCount !== payload.assertionIds.length || payload.profileAssertionIds.length > payload.assertionIds.length || new Set(payload.profileAssertionIds).size !== payload.profileAssertionIds.length || payload.profileAssertionIds.some(key => !payload.assertionIds.includes(key))) throw new Error('private_profile_incomplete')
      if (profileChunkCount === null && payload.profileAssertionIds.length === 0) break
      for (const key of payload.profileAssertionIds) {
        const assertion = await backend.readResource('assertion', key)
        let row = assertion?.payload
        if (!assertion || assertion.deleted || assertion.sourceOwnerId !== ownerId || row?.ownerId !== ownerId || row.id !== key || row.importId !== id || !own.has(row.category)) throw new Error('private_profile_incomplete')
        if (row.fullObservationAsset) row = JSON.parse((await backend.readAsset(row.fullObservationAsset)).toString('utf8'))
        if (!row || row.ownerId !== ownerId || row.id !== key || row.importId !== id || !own.has(row.category) || !row.fields || key !== privateId(ownerId, 'assertion', row.sourceId, row.rowId)) throw new Error('private_profile_incomplete')
        rows.push(row)
      }
    }
    if (!live(await backend.readResource('import', id), ownerId, id)) throw new Error('private_import_not_found')
  }
  return rows
}

export function profileFromRows(rows) {
  const profile = rows.findLast(row => row.category === 'profile')?.fields ?? {}
  return { name: [profile['first name'], profile['last name']].filter(Boolean).join(' '), headline: profile.headline ?? '',
    positions: rows.filter(row => row.category === 'positions').map(({ fields }) => ({ title: fields.title, company: fields['company name'], description: fields.description, startDate: fields['started on'], endDate: fields['finished on'] })),
    education: rows.filter(row => row.category === 'education').map(({ fields }) => ({ institution: fields['school name'], degree: fields['degree name'], startDate: fields['start date'], endDate: fields['end date'] })),
    skills: [...new Set(rows.filter(row => row.category === 'skills').map(row => row.fields.name))] }
}
