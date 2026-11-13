// Each group is one bounded document. The store serializes a transition with
// the membership/invite/share check it depends on, including across processes.
import { createHash } from 'node:crypto'

export const groupActorKey = actor => createHash('sha256').update(JSON.stringify([actor.ownerId, actor.userId])).digest('hex')
const actorsOf = group => [...new Set([
  groupActorKey(group.organizer),
  ...group.members.map(row => groupActorKey(row.actor)),
  ...group.invites.map(row => groupActorKey(row.actor)),
  ...(group.flyer?.requests.map(row => groupActorKey(row.actor)) ?? []),
  ...(group.flyer?.accepted ?? []),
])]

export function createMemoryCollectiveGroupsStore() {
  const rows = new Map(), jobs = new Map()
  const queue = (group, deleted=false) => {const old=jobs.get(group.id);jobs.set(group.id,{...old,id:group.id,group:structuredClone(group),deleted,revision:(old?.revision??0)+1,nextAttemptAt:0,done:false})}
  return {
    async initialize() {},
    async create(group) { if([...rows.values()].some(g=>g.slug && g.slug===group.slug))throw Error("group_slug_conflict"); rows.set(group.id, structuredClone(group));queue(group) },
    async get(id) { return structuredClone(rows.get(id) ?? null) },
    async bySlug(slug) { return structuredClone([...rows.values()].find(g=>g.slug===slug && g.urlMode!=="opaque")??null) },
    async chatDue(now,limit) {return [...jobs.values()].filter(j=>!j.done && j.nextAttemptAt<=now).slice(0,limit).map(j=>j.id)},
    async chatJob(id) {return structuredClone(jobs.get(id)??null)},
    async chatFinish(id,revision,patch) {const j=jobs.get(id);if(j?.revision===revision)Object.assign(j,structuredClone(patch))},
    async forActor(actor) {
      const key = groupActorKey(actor)
      return structuredClone([...rows.values()].filter(group => actorsOf(group).includes(key)))
    },
    async change(id, update) {
      if (!rows.has(id)) return null
      const current=structuredClone(rows.get(id))
      const next = update(structuredClone(current))
      if (next) rows.set(id, structuredClone(next))
      else rows.delete(id)
      queue(next??current,!next)
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
  const fields = group => ({ id: group.id, actors: actorsOf(group), document: JSON.stringify(group), slug:group.slug??null })
  const queue = (tx,group,deleted=false) => tx.run(`MERGE(j:UnlinkedGroupChatJob {id:$id})
    SET j.revision=coalesce(j.revision,0)+1,j.document=$document,j.deleted=$deleted,j.done=false,j.nextAttemptAt=0`,{id:group.id,document:JSON.stringify(group),deleted})
  return {
    async initialize() {
      await transaction('WRITE',tx=>tx.run('CREATE CONSTRAINT unlinked_group_slug IF NOT EXISTS FOR (g:UnlinkedCollectiveGroup) REQUIRE g.slug IS UNIQUE'))
      await transaction('WRITE',tx=>tx.run('CREATE CONSTRAINT unlinked_group_chat_job IF NOT EXISTS FOR (g:UnlinkedGroupChatJob) REQUIRE g.id IS UNIQUE'))
      await transaction('WRITE',tx=>tx.run(`MATCH(g:UnlinkedCollectiveGroup) WHERE NOT EXISTS {MATCH(:UnlinkedGroupChatJob {id:g.id})}
        CREATE(:UnlinkedGroupChatJob {id:g.id,document:g.document,revision:1,deleted:false,done:false,nextAttemptAt:0})`))
      await transaction('WRITE', tx => tx.run('CREATE CONSTRAINT unlinked_collective_group_id IF NOT EXISTS FOR (g:UnlinkedCollectiveGroup) REQUIRE g.id IS UNIQUE'))
    },
    async create(group) {
      await transaction('WRITE', async tx => {await tx.run('CREATE (:UnlinkedCollectiveGroup {id:$id, slug:$slug, actors:$actors, document:$document})', fields(group));await queue(tx,group)})
    },
    async get(id) {
      return documents(await transaction('READ', tx => tx.run(match + ' RETURN g.document AS document', { id })))[0] ?? null
    },
    async bySlug(slug) {
      const group=documents(await transaction('READ',tx=>tx.run('MATCH(g:UnlinkedCollectiveGroup {slug:$slug}) RETURN g.document AS document',{slug})))[0]
      return group?.urlMode!=='opaque'?group??null:null
    },
    async chatDue(now,limit) {
      return (await transaction('READ',tx=>tx.run('MATCH(j:UnlinkedGroupChatJob) WHERE j.done=false AND j.nextAttemptAt<=$now RETURN j.id AS id ORDER BY j.nextAttemptAt LIMIT toInteger($limit)',{now,limit}))).records.map(r=>r.get('id'))
    },
    async chatJob(id) {
      const r=(await transaction('READ',tx=>tx.run('MATCH(j:UnlinkedGroupChatJob {id:$id}) RETURN properties(j) AS job',{id}))).records[0]?.get('job')
      return r?{...r,group:JSON.parse(r.document),revision:Number(r.revision),attempts:Number(r.attempts??0),lastSnapshot:r.lastSnapshot?JSON.parse(r.lastSnapshot):null}:null
    },
    async chatFinish(id,revision,patch) {
      const safe={...patch,...(patch.lastSnapshot?{lastSnapshot:JSON.stringify(patch.lastSnapshot)}:{})}
      await transaction('WRITE',tx=>tx.run(`MATCH(j:UnlinkedGroupChatJob {id:$id}) SET j.lockVersion=coalesce(j.lockVersion,0)+1 WITH j WHERE j.revision=$revision SET j+=$patch`,{id,revision,patch:safe}))
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
        if (next) await tx.run(match + ' SET g.document=$document, g.actors=$actors, g.slug=$slug', fields(next))
        else await tx.run(match + ' DELETE g', { id })
        await queue(tx,next??current,!next)
        return next
      })
    },
  }
}
