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

export function createMemoryHomePreferenceStore({ now = Date.now } = {}) {
  const records = new Map()
  return {
    async initialize() {},
    async get(owner) {
      if (!valid(owner)) return null
      const value = records.get(owner.ownerId)
      return value && value.userId === owner.userId ? view(value) : null
    },
    async set(owner, { importReminder }) { const value = record(owner, importReminder, now()); records.set(owner.ownerId, value); return view(value) },
    async removeOwner(owner) { if (valid(owner)) records.delete(owner.ownerId) },
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
    async removeOwner(owner) {
      if (!valid(owner)) return
      await run('MATCH (p:UnlinkedHomePreference {ownerId: $ownerId}) DETACH DELETE p', { ownerId: owner.ownerId })
    },
  }
}
