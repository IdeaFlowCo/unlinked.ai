import { createHash } from 'node:crypto'

export const groupActorKey = actor => createHash('sha256').update(JSON.stringify([actor.ownerId, actor.userId])).digest('hex')
const actorsOf = group => [...new Set([
  groupActorKey(group.organizer),
  ...group.members.map(row => groupActorKey(row.actor)),
  ...group.invites.map(row => groupActorKey(row.actor)),
  ...(group.flyer?.requests.map(row => groupActorKey(row.actor)) ?? []),
  ...(group.flyer?.accepted ?? []),
])]
const chatGroup = (group, deleted) => ({
  id: group.id, name: deleted ? 'Deleted community' : group.name,
  ...(group.chatConversationId ? { chatConversationId: group.chatConversationId } : {}),
  ...(!deleted ? { organizer: group.organizer, members: group.members.map(({ actor, name }) => ({ actor, name })) } : {}),
})
const nextJob = (old, group, deleted = false) => {
  const fence = { id: group.id, revision: (old?.revision ?? 0) + 1 }
  if (deleted && !old?.organizer) return { ...fence, done: true }
  return { ...fence, group: chatGroup(group, deleted), deleted, nextAttemptAt: 0, done: false,
    ...(old?.organizer ? { organizer: old.organizer } : {}) }
}
const completedJob = (job, fingerprint) => ({
  id: job.id, revision: job.revision, done: true, ...(!job.deleted ? { fingerprint } : {}),
  ...(!job.deleted ? { organizer: job.lastSnapshot.organizer } : {}),
})

export function createMemoryCollectiveGroupsStore() {
  const rows = new Map(), jobs = new Map()
  const queue = (group, deleted = false) => {
    if (group.chatManaged === true) jobs.set(group.id, nextJob(jobs.get(group.id), group, deleted))
  }
  return {
    async initialize() {},
    async create(group) {
      if ([...rows.values()].some(g => g.slug && g.slug === group.slug)) throw Error('group_slug_conflict')
      rows.set(group.id, structuredClone(group)); queue(group)
    },
    async get(id) { return structuredClone(rows.get(id) ?? null) },
    async bySlug(slug) { return structuredClone([...rows.values()].find(g => g.slug === slug && g.urlMode !== 'opaque') ?? null) },
    async chatCandidates(after, limit) {
      return [...rows.values()].filter(g => g.chatManaged === true && g.id > after).sort((a,b) => a.id.localeCompare(b.id)).slice(0,limit).map(g => g.id)
    },
    async chatDue(now, limit) { return [...jobs.values()].filter(j => !j.done && j.nextAttemptAt <= now).slice(0,limit).map(j => j.id) },
    async chatJob(id) { return structuredClone(jobs.get(id) ?? null) },
    async chatPrepare(id, revision, snapshot, fingerprint) {
      const job = jobs.get(id)
      if (!job || job.done || job.revision !== revision) return null
      if (!job.lastSnapshot) Object.assign(job, { lastSnapshot: structuredClone(snapshot), fingerprint, organizer: structuredClone(snapshot.organizer) })
      return structuredClone(job.lastSnapshot)
    },
    async chatFinish(id, revision, patch) {
      const job = jobs.get(id)
      if (job?.revision !== revision || job.done) return
      if (patch.done && job.lastSnapshot) jobs.set(id, completedJob(job, job.fingerprint))
      else Object.assign(job, { attempts: patch.attempts, nextAttemptAt: patch.nextAttemptAt })
    },
    async chatRequeue(id, revision) {
      const group = rows.get(id), job = jobs.get(id)
      if (group?.chatManaged === true && job?.revision === revision) queue(group)
    },
    async forActor(actor) {
      const key = groupActorKey(actor)
      return structuredClone([...rows.values()].filter(group => actorsOf(group).includes(key)))
    },
    async change(id, update) {
      if (!rows.has(id)) return null
      const current = structuredClone(rows.get(id)), next = update(structuredClone(current))
      if (next) rows.set(id, structuredClone(next))
      else rows.delete(id)
      queue(next ?? current, !next)
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
  const fields = group => ({ id: group.id, actors: actorsOf(group), document: JSON.stringify(group), slug: group.slug ?? null, chatManaged: group.chatManaged === true })
  const readJob = r => r ? { ...r, ...(r.document ? { group: JSON.parse(r.document) } : {}), revision: Number(r.revision), attempts: Number(r.attempts ?? 0), ...(r.organizer ? { organizer: JSON.parse(r.organizer) } : {}), ...(r.lastSnapshot ? { lastSnapshot: JSON.parse(r.lastSnapshot) } : {}) } : null
  const queue = async (tx, group, deleted = false) => {
    if (group.chatManaged !== true) return
    await tx.run(`MERGE (j:UnlinkedGroupChatJob {id:$id})
      SET j.revision=coalesce(j.revision,0)+1
      WITH j SET j=CASE WHEN $deleted AND j.organizer IS NULL THEN {id:j.id,revision:j.revision,done:true}
        ELSE {id:j.id,revision:j.revision,document:$document,deleted:$deleted,done:false,nextAttemptAt:0,organizer:j.organizer} END`,
      { id: group.id, document: JSON.stringify(chatGroup(group, deleted)), deleted })
  }
  const lockedGroup = async (tx, id) => documents(await tx.run(match + ' SET g.transitionLock=coalesce(g.transitionLock,0)+1 RETURN g.document AS document', { id }))[0]
  return {
    async initialize() {
      await transaction('WRITE', tx => tx.run('CREATE CONSTRAINT unlinked_group_slug IF NOT EXISTS FOR (g:UnlinkedCollectiveGroup) REQUIRE g.slug IS UNIQUE'))
      await transaction('WRITE', tx => tx.run('CREATE CONSTRAINT unlinked_group_chat_job IF NOT EXISTS FOR (g:UnlinkedGroupChatJob) REQUIRE g.id IS UNIQUE'))
      await transaction('WRITE', tx => tx.run('CREATE CONSTRAINT unlinked_collective_group_id IF NOT EXISTS FOR (g:UnlinkedCollectiveGroup) REQUIRE g.id IS UNIQUE'))
    },
    async create(group) {
      await transaction('WRITE', async tx => {
        await tx.run('CREATE (:UnlinkedCollectiveGroup {id:$id, slug:$slug, actors:$actors, document:$document, chatManaged:$chatManaged})', fields(group))
        await queue(tx, group)
      })
    },
    async get(id) { return documents(await transaction('READ', tx => tx.run(match + ' RETURN g.document AS document', { id })))[0] ?? null },
    async bySlug(slug) {
      const group = documents(await transaction('READ', tx => tx.run('MATCH (g:UnlinkedCollectiveGroup {slug:$slug}) RETURN g.document AS document', { slug })))[0]
      return group?.urlMode !== 'opaque' ? group ?? null : null
    },
    async chatCandidates(after, limit) {
      return (await transaction('READ', tx => tx.run('MATCH (g:UnlinkedCollectiveGroup {chatManaged:true}) WHERE g.id>$after RETURN g.id AS id ORDER BY g.id LIMIT toInteger($limit)', { after, limit }))).records.map(r => r.get('id'))
    },
    async chatDue(now, limit) {
      return (await transaction('READ', tx => tx.run('MATCH (j:UnlinkedGroupChatJob) WHERE j.done=false AND j.nextAttemptAt<=$now RETURN j.id AS id ORDER BY j.nextAttemptAt LIMIT toInteger($limit)', { now, limit }))).records.map(r => r.get('id'))
    },
    async chatJob(id) {
      return readJob((await transaction('READ', tx => tx.run('MATCH (j:UnlinkedGroupChatJob {id:$id}) RETURN properties(j) AS job', { id }))).records[0]?.get('job'))
    },
    async chatPrepare(id, revision, snapshot, fingerprint) {
      const result = await transaction('WRITE', tx => tx.run(`MATCH (j:UnlinkedGroupChatJob {id:$id})
        SET j._lock=true REMOVE j._lock WITH j WHERE j.revision=$revision AND j.done=false
        SET j.lastSnapshot=coalesce(j.lastSnapshot,$snapshot),j.fingerprint=coalesce(j.fingerprint,$fingerprint),
          j.organizer=coalesce(j.organizer,$organizer)
        RETURN j.lastSnapshot AS snapshot`, { id, revision, snapshot: JSON.stringify(snapshot), fingerprint, organizer: JSON.stringify(snapshot.organizer) }))
      const value = result.records[0]?.get('snapshot')
      return value ? JSON.parse(value) : null
    },
    async chatFinish(id, revision, patch) {
      await transaction('WRITE', tx => tx.run(patch.done ? `MATCH (j:UnlinkedGroupChatJob {id:$id})
        SET j._lock=true REMOVE j._lock WITH j WHERE j.revision=$revision AND j.done=false AND j.lastSnapshot IS NOT NULL
        SET j={id:j.id,revision:j.revision,done:true,fingerprint:CASE WHEN j.deleted THEN null ELSE j.fingerprint END,organizer:CASE WHEN j.deleted THEN null ELSE j.organizer END}` : `MATCH (j:UnlinkedGroupChatJob {id:$id})
        SET j._lock=true REMOVE j._lock WITH j WHERE j.revision=$revision AND j.done=false
        SET j.attempts=$attempts,j.nextAttemptAt=$nextAttemptAt`, { id, revision, attempts: patch.attempts ?? 0, nextAttemptAt: patch.nextAttemptAt ?? 0 }))
    },
    async chatRequeue(id, revision) {
      await transaction('WRITE', async tx => {
        const group = await lockedGroup(tx, id)
        const result = await tx.run('MATCH (j:UnlinkedGroupChatJob {id:$id}) SET j._lock=true REMOVE j._lock RETURN j.revision AS revision', { id })
        if (group?.chatManaged === true && Number(result.records[0]?.get('revision')) === revision) await queue(tx, group)
      })
    },
    async forActor(actor) {
      return documents(await transaction('READ', tx => tx.run('MATCH (g:UnlinkedCollectiveGroup) WHERE $key IN g.actors RETURN g.document AS document', { key: groupActorKey(actor) })))
    },
    async change(id, update) {
      return transaction('WRITE', async tx => {
        const current = await lockedGroup(tx, id)
        if (!current) return null
        const next = update(current)
        if (next) await tx.run(match + ' SET g.document=$document,g.actors=$actors,g.slug=$slug,g.chatManaged=$chatManaged', fields(next))
        else await tx.run(match + ' DETACH DELETE g', { id })
        await queue(tx, next ?? current, !next)
        return next
      })
    },
  }
}
