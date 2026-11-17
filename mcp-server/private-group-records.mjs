import { createHash, randomUUID } from 'node:crypto'
import { normalizeGroupChatUrl } from './collective-groups.mjs'

export const PRIVATE_GROUP_CONTRACT = 'unlinked-private-group-v1'
export const groupRecordId = (...parts) => createHash('sha256').update(JSON.stringify([PRIVATE_GROUP_CONTRACT, ...parts])).digest('hex')
const fail = () => { throw Object.assign(Error('not_found'), { code: 'not_found' }) }
const copy = value => structuredClone(value)
const same = (a, b) => a?.ownerId === b?.ownerId && a?.userId === b?.userId && Boolean(a?.ownerId && a?.userId)

// No new operational endpoint or graph bypass: these are owner-private Noos
// records, using the existing bounded, atomic import-record publication API.
// kind excludes every one of these records from ordinary archive/grant readers.
export function createNoosGroupRecords({ backend, owner }) {
  if (!owner?.ownerId || !owner.userId || !backend?.readResource) throw Error('group_backend_required')
  const id = (groupId, ...parts) => groupRecordId(owner.ownerId, groupId, ...parts)
  const envelope = (sourceId, payload, revision = 1, expectedRevision = null) => ({ namespace: 'unlinked', type: 'import', sourceId,
    sourceOwnerId: owner.ownerId, sourceRevision: revision, expectedRevision, audience: 'owner', deleted: false, payload })
  const read = async sourceId => {
    if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) fail()
    const r = await backend.readResource('import', sourceId)
    if (!r) return null
    if (r.deleted || r.sourceOwnerId !== owner.ownerId || r.audience !== 'owner' || r.sourceId !== sourceId ||
      r.payload?.contract !== PRIVATE_GROUP_CONTRACT || !same(r.payload.owner, owner) || r.payload.id !== sourceId ||
      r.payload.revision !== r.sourceRevision) fail()
    return r.payload
  }
  const catalogId = groupRecordId(owner.ownerId, 'catalog')
  const write = async items => {
    if (typeof backend.writeImportBatch !== 'function') throw Error('group_backend_required')
    const groupId = items[0]?.payload?.groupId
    if (!groupId || items.some(item => item.payload?.groupId !== groupId)) fail()
    const catalog = await read(catalogId)
    if (catalog?.deleting) fail()
    const groups = copy(catalog?.groups ?? []), entry = groups.find(g => g.groupId === groupId)
    if (!entry && groups.length >= 200) throw Error('group_support_limit')
    const ordinal = entry?.pages ?? 0
    if (ordinal >= 10000) throw Error('group_support_limit')
    if (entry) entry.pages++
    else groups.push({ groupId, pages: 1 })
    const journalId = id(groupId, 'journal', ordinal)
    const journal = record(journalId, groupId, 'group_record_journal', { ordinal, recordIds: items.map(item => item.sourceId) })
    const revision = (catalog?.revision ?? 0) + 1
    const nextCatalog = record(catalogId, null, 'group_record_catalog', { groups }, revision)
    const batch = [...items, envelope(journalId, journal), envelope(catalogId, nextCatalog, revision, catalog?.revision ?? null)]
    if (batch.length > 600 || batch.some(item => Buffer.byteLength(JSON.stringify(item)) > 60 * 1024) ||
      Buffer.byteLength(JSON.stringify(batch)) > 32 * 1024 * 1024) throw Error('group_support_limit')
    // Journal and owner catalog commit atomically with every write, including
    // interrupted staging. This permits complete owner export/erasure and
    // fences late writers once account deletion begins.
    await backend.writeImportBatch(batch)
  }
  const record = (sourceId, groupId, kind, payload, revision = 1) => ({ ...copy(payload), id: sourceId, groupId,
    owner: copy(owner), kind, contract: PRIVATE_GROUP_CONTRACT, revision })
  return {
    contract: PRIVATE_GROUP_CONTRACT,
    async exportOwner() {
      const catalog = await read(catalogId)
      if (!catalog || catalog.deleting) return []
      const result = []
      for (const entry of catalog.groups) {
        const node = await this.group(entry.groupId)
        if (!node) continue
        const manifest = await this.rosterManifest(entry.groupId)
        result.push({ group: node, memberships: await this.memberships(node), pendingRoster: await this.roster(entry.groupId, manifest) })
      }
      const latest = await read(catalogId)
      if (!latest || latest.deleting || latest.revision !== catalog.revision) fail()
      return result
    },
    async removeOwner() {
      if (typeof backend.writeBatch !== 'function') throw Error('group_delete_backend_required')
      const raw = await backend.readResource('import', catalogId)
      if (!raw || raw.deleted) return
      let catalog = await read(catalogId)
      if (!catalog.deleting) {
        catalog = { ...catalog, deleting: true, revision: catalog.revision + 1 }
        await backend.writeImportBatch([envelope(catalogId, catalog, catalog.revision, catalog.revision - 1)])
      }
      // Any concurrent stage/final publication uses the old catalog CAS and
      // fails. The catalog retains every journal page until erasure completes.
      const ids = new Set()
      for (const entry of catalog.groups) {
        for (let ordinal = 0; ordinal < entry.pages; ordinal++) {
          const journalId = id(entry.groupId, 'journal', ordinal)
          const journal = await backend.readResource('import', journalId)
          if (journal && !journal.deleted) {
            if (journal.sourceOwnerId !== owner.ownerId || journal.payload?.kind !== 'group_record_journal' ||
              journal.payload.groupId !== entry.groupId || journal.payload.ordinal !== ordinal) fail()
            journal.payload.recordIds.forEach(key => ids.add(key))
          }
          // Keep journals until all referenced resources have been erased so
          // an interrupted erasure can reconstruct exactly the same work.
        }
      }
      const erase = async sourceId => {
        const resource = await backend.readResource('import', sourceId)
        if (!resource || resource.deleted) return
        if (resource.sourceOwnerId !== owner.ownerId || resource.payload?.contract !== PRIVATE_GROUP_CONTRACT) fail()
        await backend.writeBatch([{ namespace: 'unlinked', type: 'import', sourceId, sourceOwnerId: owner.ownerId,
          sourceRevision: resource.sourceRevision + 1, expectedRevision: resource.sourceRevision, audience: 'owner', deleted: true, payload: null }])
      }
      for (const key of ids) await erase(key)
      for (const entry of catalog.groups) for (let ordinal = 0; ordinal < entry.pages; ordinal++) await erase(id(entry.groupId, 'journal', ordinal))
      await erase(catalogId)
    },
    async group(groupId) {
      const node = await read(id(groupId, 'node'))
      if (node && (node.kind !== 'group_node' || node.groupId !== groupId || node.visibility !== 'PRIVATE')) fail()
      return node
    },
    async publishGroup(groupId, metadata, members, expectedRevision) {
      if (!Array.isArray(members) || members.length > 500 || !members.some(m => same(m.actor, owner) && m.role === 'owner') ||
        members.some(m => !m.actor?.ownerId || !m.actor.userId || !['owner', 'admin', 'member'].includes(m.role)) ||
        new Set(members.map(m => JSON.stringify(m.actor))).size !== members.length) throw Error('group_members_invalid')
      const revision = (expectedRevision ?? 0) + 1, generation = randomUUID()
      const edges = members.map(m => {
        const sourceId = id(groupId, 'membership', generation, m.actor.ownerId, m.actor.userId)
        return envelope(sourceId, record(sourceId, groupId, 'group_membership_edge', { ...m, consent: 'existing_collective_join', nodeRevision: revision }))
      })
      const sourceId = id(groupId, 'node')
      const node = record(sourceId, groupId, 'group_node', { name: metadata.name, description: metadata.description ?? '',
        tags: ['investor', 'founders'], visibility: 'PRIVATE', externalLink: normalizeGroupChatUrl(metadata.chatUrl ?? ''), membershipRevision: revision, membershipEdges: edges.map(e => e.sourceId) }, revision)
      // Membership edges and current node become visible in one atomic CAS.
      await write([...edges, envelope(sourceId, node, revision, expectedRevision)])
      return node
    },
    async memberships(node) {
      if (!Array.isArray(node.membershipEdges) || node.membershipEdges.length > 500) fail()
      const result = []
      for (const key of node.membershipEdges) {
        const edge = await read(key)
        if (!edge || edge.kind !== 'group_membership_edge' || edge.groupId !== node.groupId || edge.nodeRevision !== node.membershipRevision) fail()
        result.push(edge)
      }
      return result
    },
    async rosterManifest(groupId) {
      const manifest = await read(id(groupId, 'roster'))
      if (manifest && (manifest.kind !== 'group_roster_manifest' || manifest.groupId !== groupId)) fail()
      return manifest
    },
    async publishRoster(groupId, rows, expectedRevision, nodeRevision) {
      if (!Array.isArray(rows) || rows.length > 2000) throw Error('group_support_limit')
      const revision = (expectedRevision ?? 0) + 1, generation = randomUUID(), chunks = []
      for (let start = 0; start < rows.length; start += 25) {
        const sourceId = id(groupId, 'pending', generation, start / 25)
        const chunk = record(sourceId, groupId, 'group_pending_roster_edges', { rosterRevision: revision, ordinal: chunks.length, rows: rows.slice(start, start + 25) })
        await write([envelope(sourceId, chunk)])
        chunks.push(sourceId)
      }
      const sourceId = id(groupId, 'roster'), manifest = record(sourceId, groupId, 'group_roster_manifest',
        { chunks, count: rows.length, nodeRevision, generation }, revision)
      // A no-op node CAS prevents publication after a concurrent membership,
      // metadata or owner fence transition. Staged chunks have no reader path.
      const node = await this.group(groupId)
      if (!node || node.revision !== nodeRevision) fail()
      const receiptId = id(groupId, 'receipt', generation)
      const receipt = record(receiptId, groupId, 'group_roster_receipt', { manifestId: sourceId, rosterRevision: revision, count: rows.length })
      await write([envelope(id(groupId, 'node'), { ...node, revision: nodeRevision + 1 }, nodeRevision + 1, nodeRevision),
        envelope(sourceId, manifest, revision, expectedRevision), envelope(receiptId, receipt)])
      return manifest
    },
    async resolutionJob(groupId, generation) {
      const job = await read(id(groupId, 'resolution', generation))
      if (job && (job.kind !== 'group_resolution_job' || job.groupId !== groupId || job.generation !== generation)) fail()
      return job
    },
    async saveResolution(groupId, manifest, results, cursor, expectedRevision, nodeRevision) {
      if (!Array.isArray(results) || results.length > 25 || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > manifest.count) fail()
      const node = await this.group(groupId), live = await this.rosterManifest(groupId)
      if (!node || node.revision !== nodeRevision || !live || live.generation !== manifest.generation) fail()
      const revision = (expectedRevision ?? 0) + 1, sourceId = id(groupId, 'resolution', manifest.generation)
      const chunkId = id(groupId, 'resolution-result', manifest.generation, cursor)
      const job = record(sourceId, groupId, 'group_resolution_job', { generation: manifest.generation,
        cursor, count: manifest.count, state: cursor === manifest.count ? 'complete' : 'pending', lastResult: chunkId }, revision)
      const chunk = record(chunkId, groupId, 'group_resolution_results', { generation: manifest.generation, results })
      await write([envelope(id(groupId, 'node'), { ...node, revision: nodeRevision + 1 }, nodeRevision + 1, nodeRevision),
        envelope(sourceId, job, revision, expectedRevision), envelope(chunkId, chunk)])
      return job
    },
    async roster(groupId, manifest) {
      if (!manifest) return []
      if (manifest.groupId !== groupId || !Array.isArray(manifest.chunks) || manifest.chunks.length > 80 ||
        !Number.isSafeInteger(manifest.count) || manifest.count < 0 || manifest.count > 2000) fail()
      const rows = []
      for (const [ordinal, key] of manifest.chunks.entries()) {
        const chunk = await read(key)
        if (!chunk || chunk.kind !== 'group_pending_roster_edges' || chunk.groupId !== groupId || chunk.ordinal !== ordinal ||
          chunk.rosterRevision !== manifest.revision || !Array.isArray(chunk.rows) || chunk.rows.length > 25) fail()
        rows.push(...chunk.rows)
      }
      if (rows.length !== manifest.count) fail()
      const latest = await this.rosterManifest(groupId)
      if (!latest || latest.revision !== manifest.revision || latest.generation !== manifest.generation) fail()
      return rows
    },
  }
}
