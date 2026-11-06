// Per-account display choices for the signed-in home (unlinked-5e5). Today the
// only one is whether the "Bring your LinkedIn export" reminder is shown to a
// member who has not imported yet. This is a UI preference only: it never
// reads, writes or implies anything about imports, their status or the
// export reminder email.
export const IMPORT_REMINDER = Object.freeze(['shown', 'dismissed'])

const valid = owner => typeof owner?.ownerId === 'string' && owner.ownerId && typeof owner.userId === 'string' && owner.userId
const record = (owner, importReminder, now) => {
  if (!valid(owner)) throw new Error('home_preference_owner_required')
  if (!IMPORT_REMINDER.includes(importReminder)) throw new Error('home_preference_invalid')
  return { ownerId: owner.ownerId, userId: owner.userId, importReminder, updatedAt: now }
}
const view = value => value ? { importReminder: value.importReminder, updatedAt: value.updatedAt } : null

// Private labels describe an import only; they never alter imported observations.
const metaKey = id => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('import_metadata_invalid')
  return `import_${id}`
}
const metadata = (name, tags) => {
  if (typeof name !== 'string' || [...name].length > 120 || typeof tags !== 'string' || [...tags].length > 300 || /[\x00-\x1f\x7f]/.test(name + tags)) throw new Error('import_metadata_invalid')
  const values = [...new Set(tags.split(',').map(value => value.trim()).filter(Boolean))]
  if (values.length > 10 || values.some(value => [...value].length > 40)) throw new Error('import_metadata_invalid')
  return { name: name.trim(), tags: values }
}
const parseMetadata = value => { try { const item = JSON.parse(value); return metadata(item.name, item.tags.join(',')) } catch { return { name: '', tags: [] } } }

export function createMemoryHomePreferenceStore({ now = Date.now } = {}) {
  const records = new Map(), imports = new Map()
  return {
    async initialize() {},
    async get(owner) {
      if (!valid(owner)) return null
      const value = records.get(owner.ownerId)
      return value && value.userId === owner.userId ? view(value) : null
    },
    async set(owner, { importReminder }) { const value = record(owner, importReminder, now()); records.set(owner.ownerId, value); return view(value) },
    async getImportMetadata(owner, id) { if (!valid(owner)) return null; return imports.get(`${owner.ownerId}:${owner.userId}:${metaKey(id)}`) ?? null },
    async getImportMetadataBatch(owner, ids) { if (!valid(owner)) return {}; return Object.fromEntries(ids.map(id => [id, imports.get(`${owner.ownerId}:${owner.userId}:${metaKey(id)}`) ?? null])) },
    async setImportMetadata(owner, id, name, tags) { if (!valid(owner)) throw new Error('home_preference_owner_required'); const value = metadata(name, tags); imports.set(`${owner.ownerId}:${owner.userId}:${metaKey(id)}`, value); return value },
    async removeOwner(owner) { if (valid(owner)) { records.delete(owner.ownerId); for (const key of imports.keys()) if (key.startsWith(`${owner.ownerId}:${owner.userId}:`)) imports.delete(key) } },
  }
}

const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value

export function createNeo4jHomePreferenceStore(driver, database = 'neo4j', { now = Date.now } = {}) {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      // One node per account, found by its owner id (unique, so every read is an index seek).
      await run('CREATE CONSTRAINT unlinked_home_preference_owner IF NOT EXISTS FOR (p:UnlinkedHomePreference) REQUIRE p.ownerId IS UNIQUE', {})
    },
    async get(owner) {
      if (!valid(owner)) return null
      const result = await run('MATCH (p:UnlinkedHomePreference {ownerId: $ownerId}) WHERE p.userId = $userId RETURN p.importReminder AS importReminder, p.updatedAt AS updatedAt LIMIT 1', { ownerId: owner.ownerId, userId: owner.userId }, 'READ')
      if (!result.records.length) return null
      const importReminder = result.records[0].get('importReminder')
      return IMPORT_REMINDER.includes(importReminder) ? { importReminder, updatedAt: number(result.records[0].get('updatedAt')) } : null
    },
    async set(owner, { importReminder }) {
      const value = record(owner, importReminder, now())
      await run('MERGE (p:UnlinkedHomePreference {ownerId: $ownerId}) SET p.userId = $userId, p.importReminder = $importReminder, p.updatedAt = $updatedAt', value)
      return view(value)
    },
    async getImportMetadata(owner, id) {
      if (!valid(owner)) return null
      const key = metaKey(id)
      const result = await run('MATCH (p:UnlinkedHomePreference {ownerId: $ownerId}) WHERE p.userId = $userId RETURN p[$key] AS value', { ...owner, key }, 'READ')
      const value = result.records[0]?.get('value')
      return value ? parseMetadata(value) : null
    },
    async getImportMetadataBatch(owner, ids) {
      if (!valid(owner)) return {}
      const keys = ids.map(metaKey)
      const result = await run('MATCH (p:UnlinkedHomePreference {ownerId: $ownerId}) WHERE p.userId = $userId RETURN properties(p) AS props', { ownerId: owner.ownerId, userId: owner.userId }, 'READ')
      const props = result.records[0]?.get('props') ?? {}
      return Object.fromEntries(ids.map((id, i) => [id, props[keys[i]] ? parseMetadata(props[keys[i]]) : null]))
    },
    async setImportMetadata(owner, id, name, tags) {
      if (!valid(owner)) throw new Error('home_preference_owner_required')
      const key = metaKey(id), value = metadata(name, tags)
      const result = await run('MERGE (p:UnlinkedHomePreference {ownerId: $ownerId}) ON CREATE SET p.userId = $userId, p.importReminder = "shown" WITH p WHERE p.userId = $userId SET p += $properties RETURN p.ownerId AS ownerId', { ...owner, properties: { [key]: JSON.stringify(value) } })
      if (!result.records.length) throw new Error('home_preference_owner_mismatch')
      return value
    },
    async removeOwner(owner) {
      if (!valid(owner)) return
      await run('MATCH (p:UnlinkedHomePreference {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
    },
  }
}
