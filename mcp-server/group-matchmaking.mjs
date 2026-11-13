// Request-local suggestions over the existing authorized community projection.
// No private imports, model calls, persisted scores, or copied group membership.
const stop = new Set(('a an and are as at be been being build building can could demo developer developers do for from get give group help helping i if in into is it looking me my need needs of on or our people please project projects s some someone something that the their them there these they this to use want we what who with working would you your offer offers offering ask asks advice advise review reviews reviewing experience experienced expert expertise interested interest happy available seeking support guidance').split(' '))
const concepts = [
 ['javascript', /\b(?:javascript|java\s*script|js)\b/g],
 ['typescript', /\b(?:typescript|type\s*script)\b/g],
 ['react', /\breact(?:\.js|js)?\b/g],
 ['node.js', /\bnode(?:\.js|js)\b/g],
 ['postgres', /\b(?:postgresql|postgres)\b/g],
 ['user research', /\b(?:user research|customer research|customer interviews?|user interviews?|customer discovery)\b/g],
 ['accessibility', /\b(?:accessibility|accessible|a11y|wcag)\b/g],
 ['user experience', /\b(?:user experience|ux)\b/g],
 ['user interface', /\b(?:user interface|ui)\b/g],
 ['machine learning', /\b(?:machine learning|ml)\b/g],
 ['artificial intelligence', /\b(?:artificial intelligence|ai)\b/g],
 ['language models', /\b(?:large language models?|language models?|llms?)\b/g],
 ['fundraising', /\b(?:fundraising|fund raising|raising capital|raise capital|raising funds)\b/g],
 ['kubernetes', /\b(?:kubernetes|k8s)\b/g],
 ['ios', /\b(?:ios|iphone|ipad)\b/g],
 ['prototype', /\b(?:prototypes?|prototyping)\b/g],
]
const aliases = new Map([['apis','api'],['queries','query'],['tests','testing'],['test','testing'],['testers','testing'],['volunteers','volunteer'],['designers','design'],['designer','design'],['designing','design'],['designs','design'],['engineers','engineering'],['engineer','engineering'],['mentors','mentor'],['mentoring','mentor'],['introductions','introduction'],['intro','introduction'],['intros','introduction'],['databases','database'],['optimizing','optimization'],['optimisation','optimization']])
function topics(entry) {
 let text = `${entry.title ?? ''} ${entry.body ?? ''}`.normalize('NFKC').toLowerCase()
 const found = new Set()
 for (const [label, pattern] of concepts) text = text.replace(pattern, () => { found.add(label); return ' ' })
 for (let word of text.match(/[\p{L}\p{N}][\p{L}\p{N}+#-]*/gu) || []) {
  word = aliases.get(word) || word
  if ((word.length > 2 || ['go','c#'].includes(word)) && !stop.has(word) && !/^\d+$/.test(word)) found.add(word)
 }
 return found
}
const stable = (a,b) => b.score-a.score || String(a.other.id).localeCompare(String(b.other.id)) || String(a.mine.id).localeCompare(String(b.mine.id)) || a.memberId.localeCompare(b.memberId)

export function matchGroupMembers(entries, memberId, limit=12) {
 if (!memberId || !Number.isSafeInteger(limit) || limit<=0) return []
 const open = entries.filter(e=>e.memberId && e.status==='open' && ['ask','offer'].includes(e.kind)).map(entry=>({entry,topics:topics(entry)}))
 const own = open.filter(e=>e.entry.memberId===memberId), others=open.filter(e=>e.entry.memberId!==memberId)
 const members = new Set(open.map(e=>e.entry.memberId)), frequency=new Map()
 for (const row of open) for (const topic of row.topics) {
  if (!frequency.has(topic)) frequency.set(topic,new Set())
  frequency.get(topic).add(row.entry.memberId)
 }
 const weight = topic=>1+Math.log((members.size+1)/(frequency.get(topic).size+1))
 const total = terms=>[...terms].reduce((sum,t)=>sum+weight(t),0)
 for(const row of open)row.weight=total(row.topics)
 const byMember=new Map()
 for (const {entry:mine,topics:mineTopics,weight:mineWeight} of own) for (const {entry:other,topics:theirTopics,weight:theirWeight} of others) {
  if (mine.kind===other.kind) continue
  const shared=[...mineTopics].filter(t=>theirTopics.has(t)).sort()
  if (!shared.length) continue
  const score=total(shared)/Math.sqrt(mineWeight*theirWeight) + Math.min(shared.length,4)*0.1
  const pair={memberId:other.memberId,mine,other,topics:shared,score,direction:mine.kind==='ask'?'receive':'give'}
  const member=byMember.get(other.memberId)||{memberId:other.memberId,name:other.name,pairs:[]}
  const index=member.pairs.findIndex(p=>p.direction===pair.direction)
  if(index<0)member.pairs.push(pair)
  else if(stable(pair,member.pairs[index])<0)member.pairs[index]=pair
  byMember.set(other.memberId,member)
 }
 return [...byMember.values()].map(member=>{
  member.pairs.sort(stable)
  return {...member,reciprocal:member.pairs.length===2,score:member.pairs[0].score+(member.pairs.length===2?0.15:0)}
 }).sort((a,b)=>b.score-a.score||a.memberId.localeCompare(b.memberId)).slice(0,Math.min(limit,50))
}

export const MATCH_SCAN_LIMIT = 2000
export async function loadGroupMatchEntries(client, actor, groupId, roster) {
 const entries=[],ids=new Set(),allowed=new Map(roster.map(r=>[r.id,r]))
 let cursor,scanned=0
 for(let page=0;page<4;page++) {
  const result=await client.group(actor,groupId,roster,{limit:500,...(cursor?{cursor}:{})})
  if(!Array.isArray(result.entries)||result.entries.length>500)throw new Error('invalid_match_page')
  scanned+=result.entries.length
  for(const e of result.entries) {
   if(!allowed.has(e.memberId)||!Number.isSafeInteger(e.id)||e.id<1||ids.has(e.id))continue
   ids.add(e.id)
   if(e.audience!=='group'||e.groupId!==groupId||e.requiresSocialReview||e.status!=='open'||!['ask','offer'].includes(e.kind))continue
   if(typeof e.title!=='string'||e.title.length>300||typeof e.body!=='string'||e.body.length>1000)continue
   entries.push({id:e.id,memberId:e.memberId,name:allowed.get(e.memberId).name,title:e.title,body:e.body,kind:e.kind,status:e.status})
  }
  if(result.nextCursor==null)return {entries,scanned,complete:true}
  if(!Number.isSafeInteger(result.nextCursor)||result.nextCursor<1||(cursor&&result.nextCursor>=cursor))throw new Error('invalid_match_cursor')
  cursor=result.nextCursor
 }
 return {entries,scanned,complete:false}
}
