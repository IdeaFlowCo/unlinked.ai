// Member-published profile links (unlinked-8dm): the short list of public
// addresses a member chooses for their own public profile header. One record
// per account; the record carries the public profile id it was published for,
// so a page render looks links up by profile id and a profile that moves or
// merges simply stops matching until the member saves again (or /profile
// rebinds it). Contact-card fields never travel through this store, and the
// validation authority is normalizeSocialLinks — every read re-validates and
// fails closed per link.
import { randomUUID } from 'node:crypto'
import { normalizeSocialLinks, SOCIAL_LINK_LIMITS } from '../src/utils/public-people/profile-links.mjs'

const valid = owner => typeof owner?.ownerId === 'string' && owner.ownerId && typeof owner.userId === 'string' && owner.userId
const record = (owner, { profileId, links }, now) => {
  if (!valid(owner)) throw new Error('profile_links_owner_required')
  if (profileId !== null && (typeof profileId !== 'string' || !profileId || profileId.length > 480)) throw new Error('profile_links_profile_invalid')
  const normalized = normalizeSocialLinks(links)
  if (!Array.isArray(links) || normalized.problems.length || normalized.overLimit) throw new Error('profile_links_invalid')
  return { ownerId: owner.ownerId, userId: owner.userId, profileId, links: normalized.links, updatedAt: now, version: randomUUID() }
}
const view = value => value ? { profileId: value.profileId, links: value.links, updatedAt: value.updatedAt, version: value.version ?? null } : null
// Stored rows re-validate on the way out; anything that no longer classifies is dropped.
const revalidate = links => normalizeSocialLinks(Array.isArray(links) ? links.slice(0, SOCIAL_LINK_LIMITS.maxLinks) : []).links

export function createMemoryProfileLinkStore({ now = Date.now } = {}) {
  const records = new Map()
  return {
    async initialize() {},
    async get(owner) {
      if (!valid(owner)) return null
      const value = records.get(owner.ownerId)
      return value && value.userId === owner.userId ? view({ ...value, links: revalidate(value.links) }) : null
    },
    async set(owner, { profileId, links }) {
      const value = record(owner, { profileId, links }, now())
      if (!value.links.length) { records.delete(owner.ownerId); return view({ ...value, links: [] }) }
      records.set(owner.ownerId, value)
      return view(value)
    },
    async rebind(owner, { profileId, observed }) {
      record(owner, { profileId, links: [] }, now())
      const value = records.get(owner.ownerId)
      if (!value || value.userId !== owner.userId || !observed || value.version !== observed.version) return null
      const rebound = { ...value, profileId, version: randomUUID() }
      records.set(owner.ownerId, rebound)
      return view({ ...rebound, links: revalidate(rebound.links) })
    },
    // The public page's read: the newest record published for this profile id.
    async forProfile(profileId) {
      if (typeof profileId !== 'string' || !profileId) return null
      const matches = [...records.values()].filter(value => value.profileId === profileId).sort((a, b) => b.updatedAt - a.updatedAt)
      const links = matches.length ? revalidate(matches[0].links) : []
      return links.length ? links : null
    },
    async removeOwner(owner) { if (valid(owner)) records.delete(owner.ownerId) },
  }
}

const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const parse = value => { try { return revalidate(JSON.parse(value)) } catch { return [] } }

export function createNeo4jProfileLinkStore(driver, database = 'neo4j', { now = Date.now } = {}) {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      // One node per account; the profile-id index serves the public page read.
      await run('CREATE CONSTRAINT unlinked_profile_links_owner IF NOT EXISTS FOR (p:UnlinkedProfileLinks) REQUIRE p.ownerId IS UNIQUE', {})
      await run('CREATE INDEX unlinked_profile_links_profile IF NOT EXISTS FOR (p:UnlinkedProfileLinks) ON (p.profileId)', {})
    },
    async get(owner) {
      if (!valid(owner)) return null
      const result = await run('MATCH (p:UnlinkedProfileLinks {ownerId: $ownerId}) WHERE p.userId = $userId RETURN p.profileId AS profileId, p.links AS links, p.updatedAt AS updatedAt, p.version AS version LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ')
      if (!result.records.length) return null
      const row = result.records[0]
      return { profileId: row.get('profileId'), links: parse(row.get('links')), updatedAt: number(row.get('updatedAt')), version: row.get('version') ?? null }
    },
    async set(owner, { profileId, links }) {
      const value = record(owner, { profileId, links }, now())
      if (!value.links.length) { await run('MATCH (p:UnlinkedProfileLinks {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId }); return view({ ...value, links: [] }) }
      await run('MERGE (p:UnlinkedProfileLinks {ownerId: $ownerId}) SET p.userId = $userId, p.profileId = $profileId, p.links = $links, p.updatedAt = $updatedAt, p.version = $version', { ...value, links: JSON.stringify(value.links) })
      return view(value)
    },
    async rebind(owner, { profileId, observed }) {
      record(owner, { profileId, links: [] }, now())
      if (!observed) return null
      const result = await run('MATCH (p:UnlinkedProfileLinks {ownerId: $ownerId}) SET p.updatedAt = p.updatedAt WITH p WHERE p.userId = $userId AND coalesce(p.version, "") = $observedVersion AND p.updatedAt = $observedUpdatedAt SET p.profileId = $profileId, p.version = $version RETURN p.profileId AS profileId, p.links AS links, p.updatedAt AS updatedAt, p.version AS version', { ownerId: owner.ownerId, userId: owner.userId, profileId, observedVersion: observed.version ?? '', observedUpdatedAt: observed.updatedAt, version: randomUUID() })
      if (!result.records.length) return null
      const row = result.records[0]
      return { profileId: row.get('profileId'), links: parse(row.get('links')), updatedAt: number(row.get('updatedAt')), version: row.get('version') }
    },
    async forProfile(profileId) {
      if (typeof profileId !== 'string' || !profileId) return null
      const result = await run("MATCH (p:UnlinkedProfileLinks {profileId: $profileId}) MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:p.ownerId,userId:p.userId}) WHERE coalesce(b.active,true)=true RETURN p.links AS links ORDER BY p.updatedAt DESC LIMIT 1", { profileId }, 'READ')
      if (!result.records.length) return null
      const links = parse(result.records[0].get('links'))
      return links.length ? links : null
    },
    async removeOwner(owner) {
      if (!valid(owner)) return
      await run('MATCH (p:UnlinkedProfileLinks {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
    },
  }
}
