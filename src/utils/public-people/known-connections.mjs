import { createHash } from 'node:crypto'
import { PUBLIC_INDEX_MAX_CONNECTIONS, PUBLIC_INDEX_MAX_PROFILES } from './limits.mjs'
import { CONNECTION_SORTS, orderNetwork } from '../network-order.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const summary = profile => ({ id:profile.id,name:profile.name,...Object.fromEntries(['headline','company','location'].filter(key=>typeof profile[key]==='string').map(key=>[key,profile[key]])) })

// The caller is captured by an already authenticated server/grant factory.
// Email/URL and request parameters never choose a graph anchor or another owner.
export function createKnownConnectionsReader({ owner, getBackend, readPublishedSnapshot }) {
  if (!owner?.ownerId || !owner.userId || typeof getBackend !== 'function' || typeof readPublishedSnapshot !== 'function') throw Error('known_connections_configuration_required')
  const principal = Object.freeze({ownerId:owner.ownerId,userId:owner.userId})
  return async ({ degree=1,query='',cursor,signal,pageSize=100,sort }={}) => {
    if (![1,2].includes(degree) || (sort!==undefined && !CONNECTION_SORTS.includes(sort)) || typeof query!=='string' || query.length>256 || cursor!==undefined && (typeof cursor!=='string' || cursor.length>2048) || !Number.isSafeInteger(pageSize) || pageSize<1 || pageSize>100) throw Error('known_connections_input_invalid')
    signal?.throwIfAborted()
    const backend=await getBackend(principal), anchor=await backend.readLegacyProfile?.()
    if (!anchor) throw Error('known_connections_anchor_unavailable')
    const snapshot=await readPublishedSnapshot({signal})
    if (!snapshot || snapshot.state!=='published' || snapshot.complete!==true || typeof snapshot.revision!=='string' || !Array.isArray(snapshot.profiles) || snapshot.profiles.length>PUBLIC_INDEX_MAX_PROFILES || !Array.isArray(snapshot.connections) || snapshot.connections.length>PUBLIC_INDEX_MAX_CONNECTIONS) throw Error('known_connections_unavailable')
    const people=new Map(snapshot.profiles.map(profile=>[profile.id,profile]))
    if (people.size!==snapshot.profiles.length || !people.has(anchor.profileId)) throw Error('known_connections_anchor_unavailable')
    const outgoing=new Map()
    for (const edge of snapshot.connections) {
      // Both endpoints must be in the same currently authorized public snapshot.
      if (!edge || !people.has(edge.fromId) || !people.has(edge.toId)) throw Error('known_connections_unavailable')
      if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId,new Set())
      outgoing.get(edge.fromId).add(edge.toId)
    }
    const direct=outgoing.get(anchor.profileId) ?? new Set(), paths=new Map()
    if (degree===1) for (const id of direct) { if(id!==anchor.profileId) paths.set(id,{fromId:anchor.profileId,toId:id}) }
    else for (const via of [...direct].sort()) for (const id of outgoing.get(via) ?? []) {
      if(id!==anchor.profileId && !direct.has(id) && !paths.has(id)) paths.set(id,{fromId:anchor.profileId,viaId:via,toId:id})
    }
    const normalized=query.normalize('NFKC').trim().toLowerCase()
    const matches=[...paths.keys()].map(id=>people.get(id)).filter(p=>!normalized || [p.name,p.headline,p.company,...(p.positions??[]).map(position=>position.company)].some(value=>typeof value==='string'&&value.normalize('NFKC').toLowerCase().includes(normalized)))
    // Without an explicit sort (unlinked_search_network) the historical order and cursor binding stay unchanged.
    let ordered=matches.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))
    if (sort!==undefined) ordered=orderNetwork(matches,sort,p=>p.name,p=>p.company??p.positions?.[0]?.company??'')
    const binding=hash(JSON.stringify([principal.ownerId,anchor.profileId,anchor.receiptId,snapshot.revision,degree,normalized,...(sort!==undefined?[sort]:[])]))
    let offset=0
    if(cursor!==undefined) {
      try {const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); if(value.binding!==binding||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>matches.length||Object.keys(value).length!==2) throw Error();offset=value.offset}
      catch {throw Error('known_connections_cursor_invalid')}
    }
    const selected=ordered.slice(offset,offset+pageSize), current=await backend.readLegacyProfile(), finalSnapshot=await readPublishedSnapshot({signal})
    if(!current || current.receiptId!==anchor.receiptId || current.profileId!==anchor.profileId || current.revision!==anchor.revision || finalSnapshot?.revision!==snapshot.revision || finalSnapshot?.state!=='published' || finalSnapshot?.complete!==true) throw Error('known_connections_changed')
    signal?.throwIfAborted()
    return {scope:'owner_connections',degree,revision:snapshot.revision,sourceRevision:anchor.revision,anchorId:anchor.profileId,total:matches.length,profiles:selected.map(summary),paths:selected.map(profile=>paths.get(profile.id)),...(offset+selected.length<matches.length?{nextCursor:Buffer.from(JSON.stringify({binding,offset:offset+selected.length})).toString('base64url')}:{})}
  }
}

export function knownConnectionQuery(query, degree) {
  if (typeof query !== 'string' || query.length > 1024) throw Error('known_connections_input_invalid')
  const second = /\b(?:second[- ]degree|2nd[- ]degree|two[- ]hop)\b/i.test(query)
  if (degree === undefined && !second) return { query }
  if (degree !== undefined && ![1,2].includes(degree)) throw Error('known_connections_input_invalid')
  return { degree: degree ?? 2, query: query.replace(/\b(?:second[- ]degree|2nd[- ]degree|two[- ]hop|first[- ]degree|my|connections?|show|find|me|people|who|are)\b/gi, '').trim().replace(/\s+/g,' ') }
}
