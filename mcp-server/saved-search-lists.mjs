// Saved result membership is private. Sharing publishes only a revocable list
// of currently listed public profile IDs, never the owner's query or contacts.
import { randomUUID, randomBytes } from 'node:crypto'
const ownerValue = owner => {
  if (!owner?.ownerId || !owner?.userId) throw Error('saved_list_owner_required')
  return { ownerId: owner.ownerId, userId: owner.userId }
}
const make = (owner, { name, queryUrl, refs }, now) => {
  const identity = ownerValue(owner)
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || typeof queryUrl !== 'string' || !queryUrl.startsWith('/network') || queryUrl.length > 4096 || !Array.isArray(refs) || !refs.length || refs.length > 200 || refs.some(ref => !/^(public|contact):[^\s]{1,160}$/.test(ref))) throw Error('saved_list_input_invalid')
  return { ...identity, id: randomUUID(), name: name.trim(), queryUrl, refs: [...new Set(refs)], createdAt: now(), shareToken: null, sharedIds: [] }
}
export function createMemorySavedSearchLists({ now = Date.now } = {}) {
  const rows = new Map()
  const mine = (owner, id) => { const row = rows.get(id), identity = ownerValue(owner); return row?.ownerId === identity.ownerId && row.userId === identity.userId ? row : null }
  return {
    async initialize() {},
    async create(owner, input) { const row = make(owner, input, now); rows.set(row.id, row); return structuredClone(row) },
    async list(owner) { ownerValue(owner); return structuredClone([...rows.values()].filter(row => row.ownerId === owner.ownerId && row.userId === owner.userId).sort((a,b) => b.createdAt-a.createdAt)) },
    async get(owner, id) { return structuredClone(mine(owner,id)) },
    async share(owner, id, ids) { const row = mine(owner,id); if (!row) return null; row.shareToken = ids.length ? randomBytes(24).toString('base64url') : null; row.sharedIds = [...ids]; return structuredClone(row) },
    async shared(token) { return structuredClone([...rows.values()].find(row => row.shareToken && row.shareToken === token) ?? null) },
    async remove(owner,id) { if (mine(owner,id)) rows.delete(id) },
    async removeOwner(owner) { ownerValue(owner); for (const [id,row] of rows) if (row.ownerId === owner.ownerId && row.userId === owner.userId) rows.delete(id) },
  }
}
export function createNeo4jSavedSearchLists(driver, database = 'neo4j', { now = Date.now } = {}) {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx=>tx.run(query,params)) : session.executeWrite(tx=>tx.run(query,params))) } finally { await session.close() }
  }
  const read = result => result.records.map(record => JSON.parse(record.get('document')))
  const owned = 'MATCH (l:UnlinkedSavedSearchList {ownerId:$ownerId,userId:$userId,id:$id})'
  return {
    async initialize() { await run('CREATE CONSTRAINT unlinked_saved_search_id IF NOT EXISTS FOR (l:UnlinkedSavedSearchList) REQUIRE l.id IS UNIQUE', {}); await run('CREATE INDEX unlinked_saved_search_owner IF NOT EXISTS FOR (l:UnlinkedSavedSearchList) ON (l.ownerId)', {}); await run('CREATE INDEX unlinked_saved_search_share IF NOT EXISTS FOR (l:UnlinkedSavedSearchList) ON (l.shareToken)', {}) },
    async create(owner,input) { const row=make(owner,input,now); await run('CREATE (l:UnlinkedSavedSearchList {id:$id,ownerId:$ownerId,userId:$userId,document:$document})', {...ownerValue(owner),id:row.id,document:JSON.stringify(row)}); return row },
    async list(owner) { return read(await run('MATCH (l:UnlinkedSavedSearchList {ownerId:$ownerId,userId:$userId}) RETURN l.document AS document ORDER BY l.id',ownerValue(owner),'READ')).sort((a,b)=>b.createdAt-a.createdAt) },
    async get(owner,id) { return read(await run(owned+' RETURN l.document AS document',{...ownerValue(owner),id},'READ'))[0]??null },
    async share(owner,id,ids) {
      // Lock/read/update in one transaction so revocation cannot overwrite a concurrent deletion.
      const session=driver.session({database})
      try { return await session.executeWrite(async tx=>{
        const result=await tx.run(owned+' SET l.lock=coalesce(l.lock,0)+1 RETURN l.document AS document',{...ownerValue(owner),id})
        const row=read(result)[0]; if(!row)return null
        row.shareToken=ids.length?randomBytes(24).toString('base64url'):null; row.sharedIds=[...ids]
        await tx.run(owned+' SET l.shareToken=$shareToken,l.document=$document',{...ownerValue(owner),id,shareToken:row.shareToken,document:JSON.stringify(row)})
        return row
      }) } finally { await session.close() }
    },
    async shared(token) { return read(await run("MATCH (l:UnlinkedSavedSearchList {shareToken:$token}) MATCH (o:OperationalOwner {namespace:'unlinked',sourceOwnerId:l.ownerId,userId:l.userId}) WHERE coalesce(o.active,true)=true RETURN l.document AS document LIMIT 1",{token},'READ'))[0]??null },
    async remove(owner,id) { await run(owned+' DETACH DELETE l',{...ownerValue(owner),id}) },
    async removeOwner(owner) { await run('MATCH (l:UnlinkedSavedSearchList {ownerId:$ownerId,userId:$userId}) DETACH DELETE l',ownerValue(owner)) },
  }
}
