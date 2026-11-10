// Each group is one bounded document. The store serializes a transition with
// the membership/invite/share check it depends on, including across processes.
import { createHash } from 'node:crypto'

export const groupActorKey = actor => createHash('sha256').update(JSON.stringify([actor.ownerId, actor.userId])).digest('hex')
const actorsOf = group => [group.organizer, ...group.members.map(row => row.actor), ...group.invites.map(row => row.actor)].map(groupActorKey)

export function createMemoryCollectiveGroupsStore() {
  const rows = new Map()
  return {
    async initialize() {},
    async create(group) { rows.set(group.id, structuredClone(group)) },
    async get(id) { return structuredClone(rows.get(id) ?? null) },
    async forActor(actor) {
      const key = groupActorKey(actor)
      return structuredClone([...rows.values()].filter(group => actorsOf(group).includes(key)))
    },
    async change(id, update) {
      if (!rows.has(id)) return null
      const next = update(structuredClone(rows.get(id)))
      if (next) rows.set(id, structuredClone(next))
      else rows.delete(id)
      return next
    },
  }
}

export function createNeo4jCollectiveGroupsStore(driver, database = 'neo4j') {
  const transaction = async (mode, work) => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await session[mode === 'READ' ? 'executeRead' : 'executeWrite'](work) } finally { await session.close() }
  }
  const documents = result => result.records.map(row => JSON.parse(row.get('document')))
  const match = 'MATCH (g:UnlinkedCollectiveGroup {id:$id})'
  const fields = group => ({ id: group.id, actors: actorsOf(group), document: JSON.stringify(group) })
  return {
    async initialize() {
      await transaction('WRITE', tx => tx.run('CREATE CONSTRAINT unlinked_collective_group_id IF NOT EXISTS FOR (g:UnlinkedCollectiveGroup) REQUIRE g.id IS UNIQUE'))
    },
    async create(group) {
      await transaction('WRITE', tx => tx.run('CREATE (:UnlinkedCollectiveGroup {id:$id, actors:$actors, document:$document})', fields(group)))
    },
    async get(id) {
      return documents(await transaction('READ', tx => tx.run(match + ' RETURN g.document AS document', { id })))[0] ?? null
    },
    async forActor(actor) {
      return documents(await transaction('READ', tx => tx.run('MATCH (g:UnlinkedCollectiveGroup) WHERE $key IN g.actors RETURN g.document AS document', { key: groupActorKey(actor) })))
    },
    async change(id, update) {
      return transaction('WRITE', async tx => {
        // Read the document after acquiring the write lock. The callback is
        // synchronous and has no side effects, so driver retries are safe.
        const current = documents(await tx.run(match + ' SET g.transitionLock = coalesce(g.transitionLock,0)+1 RETURN g.document AS document', { id }))[0]
        if (!current) return null
        const next = update(current)
        if (next) await tx.run(match + ' SET g.document=$document, g.actors=$actors', fields(next))
        else await tx.run(match + ' DELETE g', { id })
        return next
      })
    },
  }
}
