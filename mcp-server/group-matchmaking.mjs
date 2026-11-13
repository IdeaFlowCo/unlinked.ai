// Request-local suggestions over the existing authorized community projection.
// No private imports, model calls, persisted scores, or copied group membership.
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

const stop = new Set(('a an and are as at be been being build building can could demo developer developers do for from get give group help helping i if in into is it looking me my need needs of on or our people please project projects s some someone something that the their them there these they this to use want we what who with working would you your offer offers offering ask asks advice advise review reviews reviewing experience experienced expert expertise interested interest happy available seeking support guidance connect connecting connection connections context shared sharing details about').split(' '))
const concepts = [
 ['react', /\breact(?:\.js|js)?\b/g],
 ['node.js', /\bnode(?:\.js|js)\b/g],
 ['javascript', /\b(?:javascript|java\s*script|js)\b/g],
 ['typescript', /\b(?:typescript|type\s*script)\b/g],
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
const aliases = new Map([['apis','api'],['queries','query'],['tests','testing'],['test','testing'],['testers','testing'],['volunteers','volunteer'],['designers','design'],['designer','design'],['designing','design'],['designs','design'],['engineers','engineering'],['engineer','engineering'],['mentors','mentor'],['mentoring','mentor'],['introductions','introduction'],['intro','introduction'],['intros','introduction'],['meeting','meet'],['meetings','meet'],['meets','meet'],['chats','chat'],['chatting','chat'],['calls','call'],['feedbacks','feedback'],['databases','database'],['optimizing','optimization'],['optimisation','optimization']])
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
const generic = new Set(['introduction','feedback','meet','chat','call'])
const stable = (a,b) => b.score-a.score || String(a.other.id).localeCompare(String(b.other.id)) || String(a.mine.id).localeCompare(String(b.mine.id)) || a.memberId.localeCompare(b.memberId)

export async function matchGroupMembers(entries, memberId, limit=12) {
 if (!memberId || !Number.isSafeInteger(limit) || limit<=0) return []
 const open=[],topicSets=new Map()
 let work=0
 for (const entry of entries) {
  if (!entry.memberId || entry.status!=='open' || !['ask','offer'].includes(entry.kind)) continue
  const terms=[...topics(entry)].sort(),key=JSON.stringify(terms)
  let set=topicSets.get(key)
  if (!set) { set={id:topicSets.size,terms,count:0,weight:0};topicSets.set(key,set) }
  set.count++
  open.push({entry,set})
  work+=terms.length+1
  if(work>=16384){work=0;await yieldToEventLoop()}
 }
 const own = open.filter(e=>e.entry.memberId===memberId), others=open.filter(e=>e.entry.memberId!==memberId)
 if(!own.length || !others.length)return []
 const members = new Set(open.map(e=>e.entry.memberId)), frequency=new Map()
 for (const row of open) {
  for (const topic of row.set.terms) {
   if (!frequency.has(topic)) frequency.set(topic,new Set())
   frequency.get(topic).add(row.entry.memberId)
  }
  work+=row.set.terms.length+1
  if(work>=16384){work=0;await yieldToEventLoop()}
 }
 const labels=[...frequency.keys()].sort(),index=new Map(labels.map((topic,i)=>[topic,i])),weights=new Float64Array(labels.length),specific=new Uint8Array(labels.length)
 labels.forEach((topic,i)=>{weights[i]=1+Math.log((members.size+1)/(frequency.get(topic).size+1));specific[i]=generic.has(topic)?0:1})
 for(const set of topicSets.values()){
  set.ids=Int32Array.from(set.terms,topic=>index.get(topic))
  set.weight=set.ids.reduce((sum,id)=>sum+weights[id],0)
 }
 const sharedTopics=(a,b)=>{
  const shared=[]
  for(let i=0,j=0;i<a.length&&j<b.length;){
   if(a[i]<b[j])i++
   else if(a[i]>b[j])j++
   else {shared.push(labels[a[i]]);i++;j++}
  }
  return shared
 }
 const byMember=new Map(),comparisons=new Map(),probe={score:0,mine:null,other:null,memberId:''}
 for (const {entry:mine,set:mineSet} of own) for (const {entry:other,set:theirSet} of others) {
  if(++work>=16384){work=0;await yieldToEventLoop()}
  if (mine.kind===other.kind || !mineSet.weight || !theirSet.weight) continue
  const key=Math.min(mineSet.id,theirSet.id)*topicSets.size+Math.max(mineSet.id,theirSet.id)
  let score=comparisons.get(key)
  if (score===undefined) {
   const a=mineSet.ids,b=theirSet.ids
   let sharedWeight=0,count=0,specificCount=0
   for(let i=0,j=0;i<a.length&&j<b.length;){
    if(a[i]<b[j])i++
    else if(a[i]>b[j])j++
    else {sharedWeight+=weights[a[i]];count++;specificCount+=specific[a[i]];i++;j++}
   }
   score=specificCount?sharedWeight/Math.sqrt(mineSet.weight*theirSet.weight)+Math.min(count,4)*0.1:0
   if(mineSet.count>1 || theirSet.count>1){
    if(comparisons.size>=4096)comparisons.delete(comparisons.keys().next().value)
    comparisons.set(key,score)
   }
   work+=a.length+b.length
   if(work>=16384){work=0;await yieldToEventLoop()}
  }
  if (!score) continue
  const direction=mine.kind==='ask'?'receive':'give'
  let member=byMember.get(other.memberId)
  if(!member){member={memberId:other.memberId,name:other.name,pairs:[]};byMember.set(other.memberId,member)}
  const existing=member.pairs.findIndex(p=>p.direction===direction)
  probe.score=score;probe.mine=mine;probe.other=other;probe.memberId=other.memberId
  if(existing>=0&&stable(probe,member.pairs[existing])>=0)continue
  const pair={memberId:other.memberId,mine,other,score,direction,ids:[mineSet.ids,theirSet.ids]}
  if(existing<0)member.pairs.push(pair)
  else member.pairs[existing]=pair
 }
 return [...byMember.values()].map(member=>{
  member.pairs.sort(stable)
  return {...member,reciprocal:member.pairs.length===2,score:member.pairs[0].score+(member.pairs.length===2?0.15:0)}
 }).sort((a,b)=>b.score-a.score||a.memberId.localeCompare(b.memberId)).slice(0,Math.min(limit,50))
  .map(member=>({...member,pairs:member.pairs.map(({ids,...pair})=>({...pair,topics:sharedTopics(...ids)}))}))
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
