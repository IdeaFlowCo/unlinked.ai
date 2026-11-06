import { createHash } from 'node:crypto'
import { PUBLIC_INDEX_MAX_CONNECTIONS, PUBLIC_INDEX_MAX_PROFILES } from './limits.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../private-import/consent.mjs'
import { createScopedImportReader } from '../private-import/noos-adapter.mjs'
import { publicLinkedinUrl } from './profile-links.mjs'
import { applyProfileDecisions } from './profile-decisions.mjs'
import { linkedinIdentityMerges, linkedinRefHash } from './url-identity.mjs'
import { parseLinkedinProfileUrl } from '../linkedin-profile-url.mjs'
import { CONNECTION_AUDIENCES, connectionPrivacyValue, isDefaultConnectionPrivacy } from './connection-privacy.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const permitted = job => job?.consent?.version === PUBLIC_UPLOAD_CONSENT.version && job.consent.publicProfessionalSearch === true && job.consent.privateRetention === true && job.consent.boundedOpenAIProcessing === true
const profile = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
export function projectPublicMemberImport({ job, assertions, includeDetails = false }) {
  if (!permitted(job) || !['indexed','partial'].includes(job.status) || !/^[a-f0-9]{64}$/.test(job.id) || !/^[a-f0-9]{64}$/.test(job.archiveSha256) || !Array.isArray(assertions) || assertions.length !== job.counts?.indexed || job.counts.accepted !== job.counts.indexed) throw Error('public_member_publication_invalid')
  const own = profile('member-import-' + job.id, 'Unlinked member'), people = [], connections = []
  let ownPhoto = null
  for (const row of assertions) {
    if (row.importId !== job.id || row.ownerId !== job.ownerId || !/^[a-f0-9]{64}$/.test(row.id) || !row.fields) throw Error('public_member_publication_invalid')
    const fields = row.fields
    if (row.category === 'connections') {
      const name = [fields['first name'], fields['last name']].filter(Boolean).join(' ')
      if (!name) throw Error('public_member_name_required')
      const person = profile('public-' + row.id, name)
      if (fields.company) person.company = fields.company
      if (fields.position) person.headline = fields.position
      if (includeDetails) { const url = publicLinkedinUrl(row.subject) ?? publicLinkedinUrl(fields.url); if (url) person.linkedinUrl = url }
      people.push(person); connections.push({fromId:own.id,toId:person.id})
    } else if (row.category === 'profile') {
      own.name = [fields['first name'],fields['last name']].filter(Boolean).join(' ') || own.name
      if (fields.headline) own.headline = fields.headline
      if (fields.summary) own.about = fields.summary
      if (includeDetails) {
        for (const key of ['location', 'industry']) if (fields[key]) own[key] = fields[key]
        const url = publicLinkedinUrl(fields['public profile url']) ?? publicLinkedinUrl(fields.url)
        if (url) own.linkedinUrl = url
      }
    } else if (row.category === 'positions') own.positions.push({title:fields.title ?? '',company:fields['company name'] ?? '',...(fields.description ? {description:fields.description} : {}),...(includeDetails && fields['started on'] ? {startDate:fields['started on']} : {}),...(includeDetails && fields['finished on'] ? {endDate:fields['finished on']} : {})})
    else if (row.category === 'education') own.education.push({institution:fields['school name'] ?? '',...(fields['degree name'] ? {degree:fields['degree name']} : {}),...(includeDetails && fields['start date'] ? {startDate:fields['start date']} : {}),...(includeDetails && fields['end date'] ? {endDate:fields['end date']} : {})})
    else if (row.category === 'skills' && fields.name) own.skills.push(fields.name)
    // The owner's own photo (docs/profile-photos.md): hash, type and size only;
    // the bytes stay an owner-private asset. Details view only.
    else if (row.category === 'profile_photo' && includeDetails && /^[a-f0-9]{64}$/.test(fields['photo sha256'] ?? '') && ['image/jpeg', 'image/png', 'image/webp'].includes(fields['photo type']) && /^[1-9]\d{0,7}$/.test(fields['photo bytes'] ?? '')) {
      ownPhoto = { sha256: fields['photo sha256'], type: fields['photo type'], bytes: Number(fields['photo bytes']) }
    }
  }
  return { state:'published',complete:true,revision:'member-public-v1:'+job.id,profiles:[own,...people],connections, ...(ownPhoto ? { ownPhoto } : {}) }
}

// Operator-published refresh of legacy rows (stale headlines, missing history).
// Keyed by existing legacy profile id; never adds people or edges, and a linked
// member's own upload still wins over it.
export const ENRICHMENT_DATASET = 'curated-enrichment-v1'
// Bulk enrichment is split across shard datasets because the Noos public store
// caps each published snapshot at 8 MiB. Shards apply first and the primary
// dataset (fresher per-person reads) last, so on the same id the primary wins.
export const ENRICHMENT_SHARD_DATASETS = Object.freeze(['curated-enrichment-exa-1', 'curated-enrichment-exa-2', 'curated-enrichment-exa-3', 'curated-enrichment-exa-4'])
export const ENRICHMENT_DATASETS = Object.freeze([...ENRICHMENT_SHARD_DATASETS, ENRICHMENT_DATASET])
// Operator enrichment keyed by LinkedIn address instead of profile id
// (docs/imported-profile-enrichment.md). A row's id is `li-<sha256 of the
// canonical slug>`, the same reference suspensions use, so one row reaches
// every published profile with that address: legacy rows and the copies
// member imports mint (`public-<row>`), including imports made later. It only
// fills fields a profile leaves empty, never touches members or historical
// members, and never adds people or edges.
export const LINKEDIN_ENRICHMENT_DATASETS = Object.freeze(Array.from({ length: 8 }, (_, index) => `curated-enrichment-li-${index + 1}`))
export const LINKEDIN_ENRICHMENT_ID = /^li-[a-f0-9]{64}$/
// Bounded below the reader's 96 MiB whole-index cap, leaving room for the
// recovered and member-authored profiles. Each Noos shard remains <= 8 MiB.
export const LINKEDIN_ENRICHMENT_TEXT_BUDGET = 64 * 1024 * 1024
export const linkedinEnrichmentId = slug => { const ref = linkedinRefHash(slug); return ref ? 'li-' + ref : null }
const refCache = new Map()
// The LinkedIn reference of a published profile's address, or null.
export function profileLinkedinRef(profile) {
  const url = profile?.linkedinUrl
  if (typeof url !== 'string') return null
  if (refCache.has(url)) return refCache.get(url)
  const slug = parseLinkedinProfileUrl(url)?.slug, ref = slug ? linkedinRefHash(slug) : null
  if (refCache.size >= 200000) refCache.clear()
  refCache.set(url, ref)
  return ref
}
const filled = value => typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) && value.length > 0
// Gaps only: a field the profile already shows (from its own source, an
// operator read or a member) always wins over the enrichment row.
export function fillFromLinkedinEnrichment(profile, row) {
  let result = null
  for (const key of ['headline', 'location', 'about', 'company', 'positions', 'education', 'skills']) {
    if (!filled(profile[key]) && filled(row?.[key])) (result ??= { ...profile })[key] = row[key]
  }
  return result ?? profile
}
const validEnrichmentDatasets = datasets => Array.isArray(datasets) && datasets.length > 0 && datasets.every((value, index) => ENRICHMENT_DATASETS.includes(value) && datasets.indexOf(value) === index) && datasets.at(-1) === ENRICHMENT_DATASET

// Private-process-only bridge. Discovery returns bound IDs, then each source
// is read again through the existing owner-authorized immutable publication.
// Old/private/synthetic consent is excluded; tombstones/owner revocation remove
// a source from every live snapshot even if its public chunks are retained.
// `freshMs` bounds how stale a served index may be: a build younger than it is
// returned without touching any source, so a new publication, revocation or
// decision becomes visible to everyone within `freshMs` plus one build, not on
// the very next request. 0 (the default) keeps next-request visibility. A
// failed or empty build is never kept, and an empty build drops what was kept.
// `staleMs` extends `freshMs` with serve-stale-while-revalidate: past the fresh
// window but inside `staleMs`, the kept build answers immediately while one
// refresh runs behind it, so no page view pays the rebuild in-band. A failed
// refresh drops the kept build (fail closed, like the suggest reader). 0
// disables it; past `staleMs` a read waits for the rebuild.
// `mergeSameLinkedin` folds published profiles that share one LinkedIn address
// into one (linkedinIdentityMerges); `preferSurvivor(ids)` names the copy that
// already holds the person's address so the survivor stays stable.
// Imports whose details are fetched at once on a cold build (see build()).
const IMPORT_PREFETCH = 4
const detailKey = item => JSON.stringify([item.id, item.owner.ownerId, item.owner.userId, item.revision])
const sourceValid = (resource, item) => Boolean(resource) && !resource.deleted && resource.sourceOwnerId === item.owner.ownerId && resource.sourceRevision === item.revision && resource.payload?.ownerId === item.owner.ownerId && resource.payload.id === item.id && permitted(resource.payload)
export function createMemberPublicIndex({ discover, getBackend, publicPeople, readLegacy, readMembers, readLegacyMembers, readDecisions, readInviteEdges, readSignupProfiles, readConnectionPrivacy, onMemberPhotos, includeDetails = false, enrichmentDatasets = [ENRICHMENT_DATASET], linkedinEnrichmentDatasets = [], linkedinEnrichmentTextBudget = LINKEDIN_ENRICHMENT_TEXT_BUDGET, mergeSameLinkedin = false, preferSurvivor = () => null, freshMs = 0, staleMs = 0, now = Date.now }) {
  if (!validEnrichmentDatasets(enrichmentDatasets)) throw Error('public_enrichment_datasets_invalid')
  if (!Array.isArray(linkedinEnrichmentDatasets) || !linkedinEnrichmentDatasets.every((value, index) => LINKEDIN_ENRICHMENT_DATASETS.includes(value) && linkedinEnrichmentDatasets.indexOf(value) === index) || typeof mergeSameLinkedin !== 'boolean' || typeof preferSurvivor !== 'function') throw Error('public_enrichment_datasets_invalid')
  if (!Number.isSafeInteger(linkedinEnrichmentTextBudget) || linkedinEnrichmentTextBudget < 0 || linkedinEnrichmentTextBudget > LINKEDIN_ENRICHMENT_TEXT_BUDGET) throw Error('public_enrichment_text_budget_invalid')
  if (!Number.isSafeInteger(freshMs) || freshMs < 0 || freshMs > 300000 || typeof now !== 'function') throw new TypeError('public_member_index_freshness_invalid')
  if (!Number.isSafeInteger(staleMs) || staleMs < 0 || staleMs > 600000 || (staleMs > 0 && staleMs < freshMs)) throw new TypeError('public_member_index_freshness_invalid')
  let work = null, kept = null, generation = 0
  // Account -> recovered legacy profile id (or null), for connection privacy.
  const legacyLinkCache = new Map()
  const detailCache = new Map()
  // Operator merges and renames apply last, over the complete union.
  // Operator and automatic decisions; the index's own merges come first.
  // Same-address merges come last: explicit and earlier automatic decisions win.
  const decide = async (snapshot, own = [], members = new Set(), verified = new Set()) => {
    const stored = [...own, ...(typeof readDecisions === 'function' ? await readDecisions() : [])]
    if (!mergeSameLinkedin) return applyProfileDecisions(snapshot, stored)
    const identity = linkedinIdentityMerges({ profiles: snapshot.profiles, members: [...members], absorbers: [...verified], decisions: stored, refFor: profileLinkedinRef, prefer: preferSurvivor })
    return applyProfileDecisions(snapshot, [...identity.decisions, ...identity.merges], { limit: PUBLIC_INDEX_MAX_PROFILES })
  }
  const build = async () => {
    const legacy = await readLegacy()
    if (!legacy) return null
    const items = await discover()
    const identity = value => JSON.stringify(value.map(item => [item.id,item.owner.ownerId,item.owner.userId,item.revision]))
    if (!Array.isArray(items) || items.length > 1000) throw Error('public_member_import_limit')
    const profiles = [...legacy.profiles], connections = [...legacy.connections], revisions = [legacy.revision, 'enrichment-status-v1', ...(includeDetails ? ['profile-details-v1', hash(JSON.stringify(legacy.profiles))] : [])], linkedChecks = [], overlays = new Map(), members = new Set(), ownerImports = new Map()
    // Members whose LinkedIn address comes from their own uploaded archive or a
    // confirmed recovered account, never from a URL typed at signup.
    const verified = new Set()
    const evidence = new Set()
    const positions = new Map(profiles.map((value, index) => [value.id, index]))
    for (const dataset of enrichmentDatasets) {
      const enrichment = await publicPeople.read(dataset)
      if (!enrichment) continue
      if (enrichment.state !== 'published' || enrichment.complete !== true || !String(enrichment.revision).startsWith(dataset + ':') || !Array.isArray(enrichment.profiles) || enrichment.connections?.length) throw Error('public_enrichment_invalid')
      for (const row of enrichment.profiles) {
        const index = positions.get(row.id)
        if (index !== undefined) {
          evidence.add(row.id)
          const supplemental = {}
          for (const key of ['linkedinUrl', 'website', 'industry']) if (!row[key] && profiles[index][key]) supplemental[key] = profiles[index][key]
          profiles[index] = { ...row, ...supplemental, enrichmentStatus: 'enriched' }
        }
      }
      revisions.push(enrichment.revision)
    }
    const byLinkedin = new Map()
    for (const dataset of linkedinEnrichmentDatasets) {
      const enrichment = await publicPeople.read(dataset)
      if (!enrichment) continue
      if (enrichment.state !== 'published' || enrichment.complete !== true || !String(enrichment.revision).startsWith(dataset + ':') || !Array.isArray(enrichment.profiles) || enrichment.connections?.length || !enrichment.profiles.every(row => LINKEDIN_ENRICHMENT_ID.test(row?.id))) throw Error('public_enrichment_invalid')
      for (const row of enrichment.profiles) if (!byLinkedin.has(row.id.slice(3))) byLinkedin.set(row.id.slice(3), row)
      revisions.push(enrichment.revision)
    }
    const signupSources = typeof readSignupProfiles === 'function' ? await readSignupProfiles() : []
    const signupIdentity = rows => JSON.stringify(rows.map(row => [row.profile.id, row.receiptId, row.owner.ownerId, row.owner.userId]))
    if (!Array.isArray(signupSources) || signupSources.length > 1000) throw Error('public_signup_profile_limit')
    const signupByOwner = new Map()
    for (const source of signupSources) {
      const key = `${source.owner.ownerId}\u0000${source.owner.userId}`
      signupByOwner.set(key, source.profile.id)
      profiles.push(source.profile); members.add(source.profile.id)
      revisions.push('signup:' + source.receiptId)
    }
    const signupMerges = []
    // Which published profile stands for each account, for connection privacy.
    const profileFor = new Map(signupByOwner)
    const photoCandidates = new Map()
    // After a restart the detail cache is empty and every import's assertions
    // must be read again. Fetch them a few imports at a time first, instead of
    // strictly one after another (the cold-start warm-up took ~7 minutes on
    // 2026-11-06). Only a validated entry under the same key is stored; the
    // loop below still re-checks every source and owns every failure.
    if (includeDetails) {
      const pending = items.filter(item => !detailCache.has(detailKey(item)))
      let next = 0
      await Promise.all(Array.from({ length: Math.min(IMPORT_PREFETCH, pending.length) }, async () => {
        while (next < pending.length) {
          const item = pending[next++]
          try {
            const backend = await getBackend(item.owner), resource = await backend.readResource('import', item.id)
            if (!sourceValid(resource, item)) continue
            const read = createScopedImportReader({readResource:backend.readResource,readAsset:backend.readAsset,grant:{ownerId:item.owner.ownerId,importIds:[item.id]}})
            const imported = await read(item.id)
            detailCache.set(detailKey(item), projectPublicMemberImport({job:resource.payload,assertions:imported.assertions,includeDetails:true}))
          } catch { /* the loop below reads it again and reports the failure */ }
        }
      }))
    }
    for (const item of items) {
      const backend = await getBackend(item.owner), resource = await backend.readResource('import',item.id)
      if (!sourceValid(resource, item)) throw Error('public_member_source_changed')
      const dataset = 'public-import-' + item.id
      let snapshot = await publicPeople.read(dataset)
      if (!snapshot) {
        const read = createScopedImportReader({readResource:backend.readResource,readAsset:backend.readAsset,grant:{ownerId:item.owner.ownerId,importIds:[item.id]}})
        const imported = await read(item.id)
        snapshot = projectPublicMemberImport({job:resource.payload,assertions:imported.assertions})
        await publicPeople.publish(dataset,snapshot,resource.payload.archiveSha256)
      }
      if (snapshot.revision !== 'member-public-v1:' + item.id) throw Error('public_member_source_changed')
      // Enrich immutable historical projections in memory through the same
      // owner-scoped reader. Cache only the professional DTO, not raw assertions.
      // Every reuse remains behind the live owner/revision checks above/below.
      if (includeDetails) {
        const key = detailKey(item)
        if (!detailCache.has(key)) {
          const read = createScopedImportReader({readResource:backend.readResource,readAsset:backend.readAsset,grant:{ownerId:item.owner.ownerId,importIds:[item.id]}})
          const imported = await read(item.id)
          detailCache.set(key, projectPublicMemberImport({job:resource.payload,assertions:imported.assertions,includeDetails:true}))
        }
        snapshot = detailCache.get(key)
      }
      const linked = typeof backend.readLegacyProfile === 'function' ? await backend.readLegacyProfile() : null
      if (linked) {
        if (linked.sourceSha256 !== legacy.revision.slice('legacy-public-v1:'.length) || !profiles.some(value => value.id === linked.profileId)) throw Error('public_member_legacy_link_invalid')
        const ownId = 'member-import-' + item.id, own = snapshot.profiles.find(value => value.id === ownId)
        if (!own) throw Error('public_member_source_changed')
        profiles.push(...snapshot.profiles.filter(value => value.id !== ownId))
        connections.push(...snapshot.connections.map(edge => ({ fromId: edge.fromId === ownId ? linked.profileId : edge.fromId, toId: edge.toId })))
        const winner = overlays.get(linked.profileId), key = [resource.payload.createdAt ?? 0, item.id]
        if (own.name !== 'Unlinked member' && (!winner || key[0] > winner.key[0] || (key[0] === winner.key[0] && key[1] > winner.key[1]))) overlays.set(linked.profileId, { key, profile: { ...own, id: linked.profileId } })
        members.add(linked.profileId); profileFor.set(`${item.owner.ownerId}\u0000${item.owner.userId}`, linked.profileId)
        revisions.push('legacy-link:' + linked.receiptId)
        linkedChecks.push(async () => { const current = await backend.readLegacyProfile(); if (!current || current.receiptId !== linked.receiptId || current.revision !== linked.revision) throw Error('public_member_source_changed') })
      } else {
        const signupId = signupByOwner.get(`${item.owner.ownerId}\u0000${item.owner.userId}`)
        const ownId = 'member-import-' + item.id
        if (signupId) {
          profiles.push(...snapshot.profiles)
          connections.push(...snapshot.connections.map(edge => ({ ...edge, fromId: edge.fromId === ownId ? signupId : edge.fromId })))
          const own = snapshot.profiles.find(row => row.id === ownId), winner = overlays.get(signupId), key = [resource.payload.createdAt ?? 0, item.id]
          if (!own) throw Error('public_member_source_changed')
          if (own.name !== 'Unlinked member' && (!winner || key[0] > winner.key[0] || (key[0] === winner.key[0] && key[1] > winner.key[1]))) overlays.set(signupId, { key, profile: { ...own, id: signupId } })
          signupMerges.push({ id: `signup:${ownId}`, kind: 'merge', profileId: ownId, survivorId: signupId })
        } else {
          profiles.push(...snapshot.profiles); connections.push(...snapshot.connections); members.add(ownId)
          // Any of an owner's imports resolves to the one profile they fold into.
          profileFor.set(`${item.owner.ownerId}\u0000${item.owner.userId}`, ownId)
          if (snapshot.profiles.find(row => row.id === ownId)?.linkedinUrl) verified.add(ownId)
        }
        const owner = `${item.owner.ownerId}\u0000${item.owner.userId}`
        if (!signupId) ownerImports.set(owner, [...(ownerImports.get(owner) ?? []), { id: 'member-import-' + item.id, key: [resource.payload.createdAt ?? 0, item.id] }])
      }
      revisions.push(snapshot.revision)
      // Newest import's photo wins for the profile this account stands for.
      if (snapshot.ownPhoto) {
        const ownerKey = `${item.owner.ownerId}\u0000${item.owner.userId}`, target = profileFor.get(ownerKey) ?? 'member-import-' + item.id
        const key = [resource.payload.createdAt ?? 0, item.id], prior = photoCandidates.get(target)
        if (!prior || key[0] > prior.key[0] || (key[0] === prior.key[0] && key[1] > prior.key[1])) photoCandidates.set(target, { key, owner: item.owner, ...snapshot.ownPhoto })
      }
      if (profiles.length > PUBLIC_INDEX_MAX_PROFILES || connections.length > PUBLIC_INDEX_MAX_CONNECTIONS) throw Error('shared_public_capacity_limit')
    }
    if (identity(await discover()) !== identity(items)) throw Error('public_member_source_changed')
    // Members' choices of who can see their connections (docs/connection-privacy.md).
    // Read once per build and hashed into the revision, so a change rebuilds the index.
    const privacy = typeof readConnectionPrivacy === 'function' ? await readConnectionPrivacy() : []
    if (!Array.isArray(privacy) || privacy.length > 10000) throw Error('public_connection_privacy_invalid')
    const privacyByProfile = new Map()
    // A member linked to a recovered legacy profile may have no import yet;
    // their legacy connections are theirs too. Looked up through their own
    // backend, a few at a time, remembered between builds. A failed lookup
    // with nothing remembered fails the build: a choice must never be dropped
    // into a public snapshot.
    const unresolved = privacy.filter(entry => entry?.owner && !profileFor.has(`${entry.owner.ownerId}\u0000${entry.owner.userId}`))
    const published = new Set(profiles.map(value => value.id))
    for (let start = 0; start < unresolved.length; start += 8) await Promise.all(unresolved.slice(start, start + 8).map(async entry => {
      const key = `${entry.owner.ownerId}\u0000${entry.owner.userId}`
      let linkedId
      try {
        const backend = await getBackend(entry.owner)
        const linked = typeof backend?.readLegacyProfile === 'function' ? await backend.readLegacyProfile() : null
        linkedId = linked?.profileId ?? null
        legacyLinkCache.set(key, linkedId)
      } catch (error) {
        if (!legacyLinkCache.has(key)) throw error
        linkedId = legacyLinkCache.get(key)
      }
      if (linkedId && published.has(linkedId)) profileFor.set(key, linkedId)
    }))
    for (const entry of privacy) {
      const key = `${entry?.owner?.ownerId}\u0000${entry?.owner?.userId}`
      const choice = connectionPrivacyValue(entry), id = profileFor.get(key)
      if (!choice) throw Error('public_connection_privacy_invalid')
      if (id && !isDefaultConnectionPrivacy(choice)) privacyByProfile.set(id, choice)
    }
    if (privacyByProfile.size) revisions.push('connection-privacy:' + hash(JSON.stringify([...privacyByProfile].sort())))
    const activeKeys = new Set(items.map(item => JSON.stringify([item.id, item.owner.ownerId, item.owner.userId, item.revision])))
    for (const key of detailCache.keys()) if (!activeKeys.has(key)) detailCache.delete(key)
    // Without a legacy or signup identity, the newest import stands for the
    // account and the others fold in, preserving one public profile per account.
    const ownerMerges = [...signupMerges]
    for (const list of ownerImports.values()) {
      if (list.length < 2) continue
      const ordered = [...list].sort((a, b) => b.key[0] - a.key[0] || (a.key[1] < b.key[1] ? 1 : -1))
      for (const older of ordered.slice(1)) { members.delete(older.id); ownerMerges.push({ id: `owner:${older.id}`, kind: 'merge', profileId: older.id, survivorId: ordered[0].id }) }
    }
    for (const check of linkedChecks) await check()
    for (const profile of profiles) if (byLinkedin.has(profileLinkedinRef(profile))) evidence.add(profile.id)
    // First index per id, exactly as findIndex returned.
    const positionOf = new Map()
    if (overlays.size) profiles.forEach((profile, index) => { if (!positionOf.has(profile.id)) positionOf.set(profile.id, index) })
    for (const [id, value] of overlays) { const index = positionOf.get(id) ?? -1; const previous = profiles[index]; profiles[index] = { ...value.profile, ...(!value.profile.linkedinUrl && previous.linkedinUrl ? {linkedinUrl:previous.linkedinUrl} : {}) }; if (value.profile.linkedinUrl) verified.add(id) }
    if (typeof readInviteEdges === 'function') {
      const known = new Set(profiles.map(value => value.id)), edges = (await readInviteEdges()).filter(edge => known.has(edge.fromId) && known.has(edge.toId))
      // An accepted invitation is a connection both people chose, so it counts
      // as listed by each of them (docs/connection-privacy.md). The graph is
      // symmetric already; only who "listed" it changes.
      connections.push(...edges, ...edges.map(edge => ({ fromId: edge.toId, toId: edge.fromId })))
      revisions.push('invites:' + hash(JSON.stringify(edges.map(edge => [edge.fromId, edge.toId]).sort())))
    }
    // Replayed source edges are canonicalized without changing their receipts.
    const uniqueConnections = [...new Map(connections.map(edge => [`${edge.fromId}\u0000${edge.toId}`, edge])).values()]
    if (uniqueConnections.length > PUBLIC_INDEX_MAX_CONNECTIONS) throw Error('shared_public_capacity_limit')
    const finalize = async snapshot => {
      for (const id of snapshot.legacyMembers ?? []) if (members.has(id)) verified.add(id)
      for (const profile of snapshot.profiles) if (byLinkedin.has(profileLinkedinRef(profile))) evidence.add(profile.id)
      const decided = await decide(snapshot, ownerMerges, members, verified)
      const enriched = new Set([...evidence].map(id => decided.aliases?.[id] ?? id))
      // Enrichment fills the profiles shown, after every merge and removal, and
      // never members' or historical members' own words. Bounded, so a large
      // publication cannot push the reader past its text budget.
      const own = new Set([...(decided.members ?? members), ...(decided.legacyMembers ?? [])])
      let budget = linkedinEnrichmentTextBudget
      let result = byLinkedin.size ? { ...decided, profiles: decided.profiles.map(profile => {
        if (own.has(profile.id) || budget <= 0) return profile
        const ref = profileLinkedinRef(profile), row = ref ? byLinkedin.get(ref) : undefined
        if (!row) return profile
        const value = fillFromLinkedinEnrichment(profile, row)
        if (value !== profile) {
          const added = Buffer.byteLength(JSON.stringify(value)) - Buffer.byteLength(JSON.stringify(profile))
          if (added > budget) return profile
          budget -= Math.max(0, added)
        }
        return value
      }) } : decided
      if (typeof readSignupProfiles === 'function' && signupIdentity(await readSignupProfiles()) !== signupIdentity(signupSources)) throw Error('public_member_source_changed')
      result = { ...result, profiles: result.profiles.map(profile => ({ ...profile, enrichmentStatus: enriched.has(profile.id) ? 'enriched' : 'not_recorded' })) }
      // Member photos for the photo route: resolved profile id -> owner + blob.
      // Kept on the server side only; never part of the public snapshot.
      if (typeof onMemberPhotos === 'function') {
        const shown = new Set(result.profiles.map(profile => profile.id)), photos = new Map()
        for (const [id, value] of photoCandidates) {
          const target = result.aliases?.[id] ?? id, prior = photos.get(target)
          if (shown.has(target) && (!prior || value.key[0] > prior.key[0] || (value.key[0] === prior.key[0] && value.key[1] > prior.key[1]))) photos.set(target, value)
        }
        onMemberPhotos(new Map([...photos].map(([id, { owner, sha256, type, bytes }]) => [id, Object.freeze({ owner: Object.freeze({ ...owner }), sha256, type, bytes })])))
      }
      if (!privacyByProfile.size) return result
      // Keyed by the profile each account resolves to after merges. When two
      // accounts fold into one profile, the more private choice wins.
      const shown = new Set(result.profiles.map(profile => profile.id)), connectionPrivacy = {}
      // Stricter on each dimension: the narrower audience and, if either chose it, "in common".
      for (const [id, choice] of privacyByProfile) {
        const target = result.aliases?.[id] ?? id, prior = connectionPrivacy[target]
        if (!shown.has(target)) continue
        const audience = prior && CONNECTION_AUDIENCES.indexOf(prior.audience) > CONNECTION_AUDIENCES.indexOf(choice.audience) ? prior.audience : choice.audience
        connectionPrivacy[target] = { ...connectionPrivacyValue({ audience, scope: choice.scope === 'shared' || prior?.scope === 'shared' ? 'shared' : 'all' }) }
      }
      return { ...result, connectionPrivacy }
    }
    if (typeof readMembers !== 'function') return finalize({state:'published',complete:true,revision:'shared-public-v1:'+hash(JSON.stringify(revisions)),profiles,connections:uniqueConnections})
    // Historical membership is separate display evidence, never a current owner binding.
    const claimed = await readMembers()
    if (!Array.isArray(claimed) || claimed.length > PUBLIC_INDEX_MAX_PROFILES) throw Error('public_member_presence_invalid')
    const known = new Set(profiles.map(value => value.id))
    for (const id of claimed) if (known.has(id)) members.add(id)
    const recovered = typeof readLegacyMembers === 'function' ? await readLegacyMembers() : []
    if (!Array.isArray(recovered) || recovered.length > 81 || recovered.some(id => !known.has(id))) throw Error('public_legacy_presence_invalid')
    const legacyMembers = [...new Set(recovered)].sort()
    revisions.push('legacy-members:' + hash(JSON.stringify(legacyMembers)))
    const memberIds = [...members].sort()
    revisions.push('members:' + hash(JSON.stringify(memberIds)))
    return finalize({state:'published',complete:true,revision:'shared-public-v1:'+hash(JSON.stringify(revisions)),profiles,connections:uniqueConnections,members:memberIds,legacyMembers})
  }
  const read = async ({signal} = {}) => {
    signal?.throwIfAborted()
    const age = kept ? now() - kept.at : Infinity
    if (age < freshMs) return kept.value
    if (!work) { const started = generation; const current = build().then(value=>{if(started===generation)kept=value?{value,at:now()}:null;return value},error=>{if(started===generation){kept=null;if(typeof onMemberPhotos==='function')onMemberPhotos(new Map())}throw error}).finally(()=>{if(work===current)work=null}); work = current }
    if (age < staleMs) { work.catch(() => {}); return kept.value }
    const value=await work;signal?.throwIfAborted();return value
  }
  // The revision hashes every input above (legacy, enrichment, each import,
  // links, invites, members, decisions), so readers may reuse a compiled index.
  read.revisionIdentifiesContent = true
  // Drop the kept build now (a member made their connections more private);
  // a build already running cannot store its older result, and the next read
  // waits for a fresh one instead of serving the stale window.
  read.invalidate = () => { generation++; kept = null; work = null }
  return read
}

// Keeps a freshness-window index warm: one read per interval triggers the
// background refresh the stale window already allows, so an after-idle
// visitor is answered from a young kept build instead of paying the rebuild
// in-band. The worst-served staleness bound stays the stale window; a failed
// refresh still fails closed through the read itself. `start` is idempotent.
export function createIndexWarmKeeper({ read, intervalMs, schedule = (fn, ms) => setInterval(fn, ms), cancel = timer => clearInterval(timer) }) {
  if (typeof read !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 600000 || typeof schedule !== 'function' || typeof cancel !== 'function') throw new TypeError('public_member_index_warm_keeper_invalid')
  let timer = null
  return {
    start() {
      if (timer) return
      timer = schedule(() => { Promise.resolve().then(read).catch(() => {}) }, intervalMs)
      timer?.unref?.()
    },
    stop() { if (timer) { cancel(timer); timer = null } },
  }
}
