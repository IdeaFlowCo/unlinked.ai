import { createHash } from 'node:crypto'
import { PUBLIC_UPLOAD_CONSENT } from '../private-import/consent.mjs'
import { createScopedImportReader } from '../private-import/noos-adapter.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const permitted = job => job?.consent?.version === PUBLIC_UPLOAD_CONSENT.version && job.consent.publicProfessionalSearch === true && job.consent.privateRetention === true && job.consent.boundedOpenAIProcessing === true
const profile = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
export function projectPublicMemberImport({ job, assertions }) {
  if (!permitted(job) || !['indexed','partial'].includes(job.status) || !/^[a-f0-9]{64}$/.test(job.id) || !/^[a-f0-9]{64}$/.test(job.archiveSha256) || !Array.isArray(assertions) || assertions.length !== job.counts?.indexed || job.counts.accepted !== job.counts.indexed) throw Error('public_member_publication_invalid')
  const own = profile('member-import-' + job.id, 'Unlinked member'), people = [], connections = []
  for (const row of assertions) {
    if (row.importId !== job.id || row.ownerId !== job.ownerId || !/^[a-f0-9]{64}$/.test(row.id) || !row.fields) throw Error('public_member_publication_invalid')
    const fields = row.fields
    if (row.category === 'connections') {
      const name = [fields['first name'], fields['last name']].filter(Boolean).join(' ')
      if (!name) throw Error('public_member_name_required')
      const person = profile('public-' + row.id, name)
      if (fields.company) person.company = fields.company
      if (fields.position) person.headline = fields.position
      people.push(person); connections.push({fromId:own.id,toId:person.id})
    } else if (row.category === 'profile') {
      own.name = [fields['first name'],fields['last name']].filter(Boolean).join(' ') || own.name
      if (fields.headline) own.headline = fields.headline
      if (fields.summary) own.about = fields.summary
    } else if (row.category === 'positions') own.positions.push({title:fields.title ?? '',company:fields['company name'] ?? '',...(fields.description ? {description:fields.description} : {})})
    else if (row.category === 'education') own.education.push({institution:fields['school name'] ?? '',...(fields['degree name'] ? {degree:fields['degree name']} : {})})
    else if (row.category === 'skills' && fields.name) own.skills.push(fields.name)
  }
  return { state:'published',complete:true,revision:'member-public-v1:'+job.id,profiles:[own,...people],connections }
}

// Operator-published refresh of legacy rows (stale headlines, missing history).
// Keyed by existing legacy profile id; never adds people or edges, and a linked
// member's own upload still wins over it.
export const ENRICHMENT_DATASET = 'curated-enrichment-v1'

// Private-process-only bridge. Discovery returns bound IDs, then each source
// is read again through the existing owner-authorized immutable publication.
// Old/private/synthetic consent is excluded; tombstones/owner revocation remove
// a source from every live snapshot even if its public chunks are retained.
export function createMemberPublicIndex({ discover, getBackend, publicPeople, readLegacy, readMembers }) {
  let work = null
  const build = async () => {
    const legacy = await readLegacy()
    if (!legacy) return null
    const items = await discover()
    const identity = value => JSON.stringify(value.map(item => [item.id,item.owner.ownerId,item.owner.userId,item.revision]))
    if (!Array.isArray(items) || items.length > 1000) throw Error('public_member_import_limit')
    const profiles = [...legacy.profiles], connections = [...legacy.connections], revisions = [legacy.revision], linkedChecks = [], overlays = new Map(), members = new Set()
    const enrichment = await publicPeople.read(ENRICHMENT_DATASET)
    if (enrichment) {
      if (enrichment.state !== 'published' || enrichment.complete !== true || !String(enrichment.revision).startsWith(ENRICHMENT_DATASET + ':') || !Array.isArray(enrichment.profiles) || enrichment.connections?.length) throw Error('public_enrichment_invalid')
      const positions = new Map(profiles.map((value, index) => [value.id, index]))
      for (const row of enrichment.profiles) { const index = positions.get(row.id); if (index !== undefined) profiles[index] = row }
      revisions.push(enrichment.revision)
    }
    for (const item of items) {
      const backend = await getBackend(item.owner), resource = await backend.readResource('import',item.id)
      if (!resource || resource.deleted || resource.sourceOwnerId !== item.owner.ownerId || resource.sourceRevision !== item.revision || resource.payload?.ownerId !== item.owner.ownerId || resource.payload.id !== item.id || !permitted(resource.payload)) throw Error('public_member_source_changed')
      const dataset = 'public-import-' + item.id
      let snapshot = await publicPeople.read(dataset)
      if (!snapshot) {
        const read = createScopedImportReader({readResource:backend.readResource,readAsset:backend.readAsset,grant:{ownerId:item.owner.ownerId,importIds:[item.id]}})
        const imported = await read(item.id)
        snapshot = projectPublicMemberImport({job:resource.payload,assertions:imported.assertions})
        await publicPeople.publish(dataset,snapshot,resource.payload.archiveSha256)
      }
      if (snapshot.revision !== 'member-public-v1:' + item.id) throw Error('public_member_source_changed')
      const linked = typeof backend.readLegacyProfile === 'function' ? await backend.readLegacyProfile() : null
      if (linked) {
        if (linked.sourceSha256 !== legacy.revision.slice('legacy-public-v1:'.length) || !profiles.some(value => value.id === linked.profileId)) throw Error('public_member_legacy_link_invalid')
        const ownId = 'member-import-' + item.id, own = snapshot.profiles.find(value => value.id === ownId)
        if (!own) throw Error('public_member_source_changed')
        profiles.push(...snapshot.profiles.filter(value => value.id !== ownId))
        connections.push(...snapshot.connections.map(edge => ({ fromId: edge.fromId === ownId ? linked.profileId : edge.fromId, toId: edge.toId })))
        const winner = overlays.get(linked.profileId), key = [resource.payload.createdAt ?? 0, item.id]
        if (own.name !== 'Unlinked member' && (!winner || key[0] > winner.key[0] || (key[0] === winner.key[0] && key[1] > winner.key[1]))) overlays.set(linked.profileId, { key, profile: { ...own, id: linked.profileId } })
        members.add(linked.profileId)
        revisions.push('legacy-link:' + linked.receiptId)
        linkedChecks.push(async () => { const current = await backend.readLegacyProfile(); if (!current || current.receiptId !== linked.receiptId || current.revision !== linked.revision) throw Error('public_member_source_changed') })
      } else { profiles.push(...snapshot.profiles); connections.push(...snapshot.connections); members.add('member-import-' + item.id) }
      revisions.push(snapshot.revision)
      if (profiles.length > 20000 || connections.length > 100000) throw Error('shared_public_capacity_limit')
    }
    if (identity(await discover()) !== identity(items)) throw Error('public_member_source_changed')
    for (const check of linkedChecks) await check()
    for (const [id, value] of overlays) profiles[profiles.findIndex(profile => profile.id === id)] = value.profile
    // Replayed source edges are canonicalized without changing their receipts.
    const uniqueConnections = [...new Map(connections.map(edge => [JSON.stringify([edge.fromId, edge.toId]), edge])).values()]
    if (typeof readMembers !== 'function') return {state:'published',complete:true,revision:'shared-public-v1:'+hash(JSON.stringify(revisions)),profiles,connections:uniqueConnections}
    // Claimed profiles are members; everyone else in the index is a shadow.
    const claimed = await readMembers()
    if (!Array.isArray(claimed) || claimed.length > 20000) throw Error('public_member_presence_invalid')
    const known = new Set(profiles.map(value => value.id))
    for (const id of claimed) if (known.has(id)) members.add(id)
    const memberIds = [...members].sort()
    revisions.push('members:' + hash(JSON.stringify(memberIds)))
    return {state:'published',complete:true,revision:'shared-public-v1:'+hash(JSON.stringify(revisions)),profiles,connections:uniqueConnections,members:memberIds}
  }
  return async ({signal} = {}) => {
    signal?.throwIfAborted()
    if (!work) work=build().finally(()=>{work=null})
    const value=await work;signal?.throwIfAborted();return value
  }
}
