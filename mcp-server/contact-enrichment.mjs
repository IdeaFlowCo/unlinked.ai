import { createHash } from 'node:crypto'
import { parseLinkedinProfileUrl } from '../src/utils/linkedin-profile-url.mjs'
import { normalizeLookupProfile } from './signup-profile-lookup.mjs'
import { lockProfileOwner } from './profile-source-boundary.mjs'

const DAY = 86400000
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ownerKey = owner => {
  if (!owner?.ownerId || !owner.userId) throw Error('contact_enrichment_owner_required')
  return hash([owner.ownerId, owner.userId])
}
export const contactFingerprint = row => hash([row.id, row.fields, row.provenance])
export const contactName = row => [row.fields?.['first name'], row.fields?.['last name']].filter(Boolean).join(' ').trim().slice(0, 200)
export const recentContact = (row, now) => row.category === 'connections' && [row.connectedAt, row.importedAt].some(at => Number.isSafeInteger(at) && at > now - 14 * DAY && at <= now)
const sameName = (a, b) => a.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === b.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
export function normalizeContactCandidates(values, name) {
  if (!Array.isArray(values)) throw Error('contact_search_unavailable')
  const found = new Map()
  for (const value of values.slice(0, 50)) {
    const parsed = parseLinkedinProfileUrl(value?.linkedinUrl)
    if (!parsed || typeof value.name !== 'string' || !sameName(value.name, name)) continue
    found.set(parsed.slug, { name: value.name.slice(0, 400), linkedinUrl: parsed.url,
      ...(typeof value.headline === 'string' ? { headline: value.headline.slice(0, 1000) } : {}),
      ...(typeof value.location === 'string' ? { location: value.location.slice(0, 400) } : {}) })
    if (found.size >= 5) break
  }
  return [...found.values()]
}
const rich = profile => Boolean(profile?.about || profile?.positions?.length || profile?.education?.length || profile?.skills?.length)

// Private professional context on the viewer's contact. Never a member claim,
// public publication or a change to the other person's account/profile.
export function createContactEnrichment({ store, readNetwork, published = async () => null, localCandidates = async () => [], lookup, now = Date.now, intervalMs = 15000 }) {
  let timer, running = null, stopped = false
  const preferences = owner => store.read(owner, 'preferences')
  const saved = async (owner, row) => {
    const state = await store.read(owner, row.id)
    return state?.fingerprint === contactFingerprint(row) ? state : null
  }
  const write = async (owner, id, previous, value) => {
    const next = { ...value, version: (previous?.version ?? 0) + 1 }
    return await store.write(owner, id, previous?.version ?? 0, next) ? next : null
  }
  async function inspect(owner, row) {
    const state = await saved(owner, row)
    const profile = await published(row)
    return { ...(rich(profile) ? { status: 'enriched', source: 'unlinked' } : state ?? { status: 'not_started' }), ...(profile ? { publishedProfile: profile } : {}) }
  }
  async function processRow(owner, row, { force = false } = {}) {
    const prefs = await preferences(owner)
    if (!force && !prefs?.enabled) return null
    const old = await store.read(owner, row.id), current = old?.fingerprint === contactFingerprint(row) ? old : null
    if (current && (['enriched', 'needs_review', 'dismissed'].includes(current.status) || current.retryAt > now())) return current
    const profile = await published(row)
    if (rich(profile)) return write(owner, row.id, old, { fingerprint: contactFingerprint(row), status: 'enriched', observedAt: now(), source: 'unlinked' })
    const pending = await write(owner, row.id, old, { ...current, fingerprint: contactFingerprint(row), status: 'processing', retryAt: now() + 60000 })
    if (!pending) return null
    let next
    const address = parseLinkedinProfileUrl(current?.address ?? row.fields?.url ?? profile?.linkedinUrl)?.url
    try {
      if (address) {
        const result = await lookup.lookup({ owner, address })
        next = result.status === 'found' ? { status: 'enriched', address, profile: normalizeLookupProfile(result.profile), observedAt: result.observedAt ?? now(), source: 'linkedin' }
          : { status: result.code === 'not_found' ? 'not_found' : 'unavailable', code: result.code, retryAt: now() + (['daily_cap', 'owner_limit'].includes(result.code) ? DAY : result.code === 'paced' ? 60000 : 3600000) }
      } else {
        let candidates = normalizeContactCandidates(await localCandidates(contactName(row)), contactName(row))
        if (!candidates.length) {
          const result = await lookup.search({ owner, query: contactName(row) })
          if (result.status !== 'found') throw Object.assign(Error('unavailable'), { code: result.code })
          candidates = normalizeContactCandidates(result.candidates, contactName(row))
        }
        // Even one name-only match is a proposal, never identity evidence.
        next = { status: candidates.length ? 'needs_review' : 'not_found', candidates, searchedAt: now(), retryAt: now() + 7 * DAY }
      }
    } catch (error) { next = { status: 'unavailable', code: ['disabled', 'daily_cap', 'owner_limit', 'paced'].includes(error?.code) ? error.code : 'unavailable', retryAt: now() + (['daily_cap', 'owner_limit'].includes(error?.code) ? DAY : 3600000) } }
    // A removal, changed source, pause or concurrent review beats a late lookup.
    const live = (await readNetwork(owner)).assertions.find(value => value.id === row.id)
    if (!live || contactFingerprint(live) !== pending.fingerprint || (!force && !(await preferences(owner))?.enabled)) return null
    return write(owner, row.id, pending, { ...next, fingerprint: pending.fingerprint, ...(address ? { address } : {}) })
  }
  const service = {
    inspect,
    preferences,
    async configure(owner, enabled) {
      if (typeof enabled !== 'boolean') throw Error('contact_enrichment_input')
      const old = await preferences(owner)
      if (!await write(owner, 'preferences', old, { enabled })) throw Error('contact_enrichment_conflict')
    },
    async review(owner, row, { action, address }) {
      const old = await saved(owner, row)
      if (action === 'confirm') {
        const parsed = parseLinkedinProfileUrl(address)
        if (!old || old.status !== 'needs_review' || !parsed || !old.candidates.some(value => value.linkedinUrl === parsed.url)) throw Error('contact_enrichment_candidate_changed')
        if (!await write(owner, row.id, old, { fingerprint: contactFingerprint(row), status: 'queued', address: parsed.url, confirmedAt: now() })) throw Error('contact_enrichment_conflict')
        return processRow(owner, row, { force: true })
      }
      // The viewer knows this person's LinkedIn address: their word attaches it
      // to their own contact only (never to the other member's account), and
      // the existing bounded lookup fills the details.
      if (action === 'link') {
        const parsed = parseLinkedinProfileUrl(address)
        if (!parsed) throw Error('contact_enrichment_input')
        const stored = await store.read(owner, row.id)
        if (!await write(owner, row.id, stored, { fingerprint: contactFingerprint(row), status: 'queued', address: parsed.url, linkedBy: 'viewer', confirmedAt: now() })) throw Error('contact_enrichment_conflict')
        return processRow(owner, row, { force: true })
      }
      // Also how the viewer removes details attached earlier.
      if (action === 'dismiss') {
        if (!old || !await write(owner, row.id, old, { fingerprint: contactFingerprint(row), status: 'dismissed' })) throw Error('contact_enrichment_conflict')
        return
      }
      if (action !== 'retry') throw Error('contact_enrichment_input')
      if (old && !await write(owner, row.id, old, { fingerprint: contactFingerprint(row), status: 'queued', ...(old.address ? { address: old.address } : {}) })) throw Error('contact_enrichment_conflict')
      return processRow(owner, row, { force: true })
    },
    async processOwner(owner) {
      if (!(await preferences(owner))?.enabled) return
      const network = await readNetwork(owner)
      for (const row of network.assertions.filter(row => recentContact(row, now())).sort((a, b) => (b.connectedAt ?? b.importedAt) - (a.connectedAt ?? a.importedAt))) {
        if (stopped) return
        const current = await saved(owner, row)
        if (current && (['enriched', 'needs_review', 'dismissed'].includes(current.status) || current.retryAt > now())) continue
        await processRow(owner, row)
        return // one operation per owner/tick; the shared provider budget also applies
      }
    },
    async tick() {
      if (running || stopped) return running
      running = (async () => { for (const owner of await store.owners()) { if (stopped) break; try { await service.processOwner(owner) } catch { /* retry next tick; never log provider data */ } } })().finally(() => { running = null })
      return running
    },
    start() { if (!timer) { timer = setInterval(() => { void service.tick().catch(() => {}) }, intervalMs); timer.unref?.() } },
    async stop() { stopped = true; clearInterval(timer); await running },
    exportOwner: owner => store.exportOwner(owner),
    removeOwner: owner => store.removeOwner(owner),
  }
  return service
}

// Durable per-viewer records, bounded professional fields only. Every operation
// includes both owner and user, and reads join the live active binding.
export function createNeo4jContactEnrichmentStore(driver, database = 'neo4j') {
  const tx = async (mode, work) => { const s = driver.session({ database, defaultAccessMode: mode }); try { return await s[mode === 'READ' ? 'executeRead' : 'executeWrite'](work) } finally { await s.close() } }
  const key = (owner, id) => hash([ownerKey(owner), id])
  const active = `MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId}) WHERE coalesce(b.active,true)=true`
  return {
    initialize: () => tx('WRITE', t => t.run('CREATE CONSTRAINT unlinked_contact_enrichment_key IF NOT EXISTS FOR (n:UnlinkedContactEnrichment) REQUIRE n.key IS UNIQUE')),
    read: (owner, id) => tx('READ', async t => {
      const r = await t.run(`${active} MATCH (n:UnlinkedContactEnrichment {key:$key,ownerId:$ownerId,userId:$userId}) RETURN n.json AS json`, { ...owner, key: key(owner, id) })
      return r.records.length ? JSON.parse(r.records[0].get('json')) : null
    }),
    write: (owner, id, version, value) => tx('WRITE', async t => {
      if (JSON.stringify(value).length > 48000) throw Error('contact_enrichment_size_limit')
      await lockProfileOwner(t, owner)
      const r = await t.run(`MERGE (n:UnlinkedContactEnrichment {key:$key}) ON CREATE SET n.ownerId=$ownerId,n.userId=$userId,n.id=$id,n.version=0
        WITH n WHERE n.ownerId=$ownerId AND n.userId=$userId AND n.version=$version
        SET n.json=$json,n.version=$next,n.enabled=$enabled RETURN n.key AS key`, { ...owner, key: key(owner, id), id, version, next: value.version, json: JSON.stringify(value), enabled: id === 'preferences' && value.enabled === true })
      return r.records.length === 1
    }),
    owners: () => tx('READ', async t => {
      const r = await t.run(`MATCH (n:UnlinkedContactEnrichment {id:'preferences',enabled:true}) MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:n.ownerId,userId:n.userId}) WHERE coalesce(b.active,true)=true RETURN n.ownerId AS ownerId,n.userId AS userId ORDER BY ownerId LIMIT 1001`)
      if (r.records.length > 1000) throw Error('contact_enrichment_owner_limit')
      return r.records.map(r => r.toObject())
    }),
    exportOwner: owner => tx('READ', async t => {
      const r = await t.run(`${active} MATCH (n:UnlinkedContactEnrichment {ownerId:$ownerId,userId:$userId}) RETURN n.id AS id,n.json AS json LIMIT 10001`, owner)
      if (r.records.length > 10000) throw Error('contact_enrichment_export_limit')
      return r.records.map(r => ({ id: r.get('id'), ...JSON.parse(r.get('json')) }))
    }),
    removeOwner: owner => tx('WRITE', async t => {
      await lockProfileOwner(t, owner, { requireActive: false })
      await t.run('MATCH (n:UnlinkedContactEnrichment {ownerId:$ownerId,userId:$userId}) DETACH DELETE n', owner)
    }),
  }
}
