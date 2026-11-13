import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {matchGroupMembers,loadGroupMatchEntries} from '../mcp-server/group-matchmaking.mjs'
const entry=(id,memberId,kind,title,extra={})=>({id,memberId,kind,title,body:'',status:'open',audience:'group',groupId:'group',...extra})
test('related wording connects complementary needs rather than generic help and review',async()=>{
 for(const [ask,offer,topics] of [
  ['Need user research','I offer customer interviews',['user research']],
  ['Need JS advice','JavaScript reviews',['javascript']],
  ['Need Node.js advice','Nodejs reviews',['node.js']],
  ['Nodejs advice','Node.js reviews',['node.js']],
  ['Need React.js advice','React reviews',['react']],
  ['React advice','Reactjs reviews',['react']],
  ['Accessible React UI','React.js WCAG user interface',['accessibility','react','user interface']],
  ['Raising capital','Fundraising mentoring',['fundraising']],
  ['PostgreSQL queries','Postgres query optimization',['postgres','query']],
 ]) {
  const matches=await matchGroupMembers([entry(1,'me','ask',ask),entry(2,'b','offer',offer)],'me')
  assert.equal(matches.length,1);assert.deepEqual(matches[0].pairs[0].topics,topics)
 }
 for(const [ask,offer] of [['Design review','Code review'],['Looking for help','Happy to help'],['Java advice','JavaScript advice'],['Node.js','JavaScript'],['React.js','JavaScript']])assert.deepEqual(await matchGroupMembers([entry(1,'me','ask',ask),entry(2,'b','offer',offer)],'me'),[])
})
test('one card per member, evidence in both directions and no invented offer from bio or same-kind asks',async()=>{
 const rows=[entry(1,'me','ask','React accessibility'),entry(2,'me','offer','Python APIs'),entry(3,'b','offer','React a11y'),entry(4,'b','ask','Python API'),entry(5,'b','offer','React accessibility'),entry(6,'c','note','React accessibility'),entry(7,'d','ask','React accessibility'),entry(8,'e','offer','React accessibility',{status:'done'}),entry(9,'f','offer','React accessibility',{status:'paused'}),entry(10,'me','offer','React accessibility')]
 const matches=await matchGroupMembers(rows,'me');assert.equal(matches.length,2)
 const bob=matches.find(m=>m.memberId==='b');assert.equal(bob.reciprocal,true);assert.equal(bob.pairs.length,2)
 assert.deepEqual(new Set(bob.pairs.map(p=>p.direction)),new Set(['give','receive']))
 assert.ok(matches.every(m=>!['me','c','e','f'].includes(m.memberId)))
 assert.deepEqual(await matchGroupMembers(rows,'absent'),[]);assert.deepEqual(await matchGroupMembers(rows,'me',0),[])
})
test('specific coverage outranks incidental keyword overlap and ranking does not depend on entry order',async()=>{
 const rows=[entry(1,'me','ask','React accessibility'),entry(2,'b','offer','React accessibility'),entry(3,'c','offer','React Python Java SQL database fundraising')]
 assert.equal((await matchGroupMembers(rows,'me'))[0].memberId,'b')
 assert.deepEqual(await matchGroupMembers(rows,'me'),await matchGroupMembers([...rows].reverse(),'me'))
})
test('entry text is tokenized once and repeated topics do not inflate a member',async()=>{
 let reads=0
 const rows=Array.from({length:500},(_,i)=>({id:i,memberId:i<250?'me':'m'+i,kind:i<250?'ask':'offer',status:'open',get title(){reads++;return 'React accessibility'},body:''}))
 const result=await matchGroupMembers(rows,'me');assert.equal(reads,500);assert.equal(result.length,12)
 assert.ok(result.every(m=>m.pairs.length===1))
})
test('scan follows empty filtered pages and finds old requests independently of board pagination',async()=>{
 const calls=[],roster=[{id:'me',name:'Me'},{id:'b',name:'Bob'}]
 const pages=[{entries:[],nextCursor:800},{entries:[entry(600,'b','offer','User interviews')],nextCursor:500},{entries:[entry(100,'me','ask','Customer research')],nextCursor:null}]
 const r=await loadGroupMatchEntries({group:async(a,g,r,p)=>{calls.push(p);return pages.shift()}},{},'group',roster)
 assert.equal(r.complete,true);assert.equal((await matchGroupMembers(r.entries,'me')).length,1)
 assert.deepEqual(calls,[{limit:500},{limit:500,cursor:800},{limit:500,cursor:500}])
})
test('scan is bounded, marks partial results, rejects non-progressing cursors and never uses partial failed results',async()=>{
 let calls=0
 const r=await loadGroupMatchEntries({group:async()=>({entries:[],nextCursor:5000-++calls})},{},'group',[])
 assert.equal(calls,4);assert.equal(r.complete,false)
 calls=0
 await assert.rejects(()=>loadGroupMatchEntries({group:async()=>({entries:[],nextCursor:500})},{},'group',[]),/invalid_match_cursor/)
 await assert.rejects(()=>loadGroupMatchEntries({group:async()=>{if(++calls===1)return {entries:[],nextCursor:10};throw Error('private upstream error')}},{},'group',[]))
})
test('scan excludes private/public/other-group/review/closed/unknown-member rows and overrides untrusted names',async()=>{
 const rows=[entry(1,'b','offer','React',{name:'UNTRUSTED',ownerKey:'secret'}),entry(2,'b','offer','PRIVATE',{audience:'only_me'}),entry(3,'b','offer','PUBLIC',{audience:'public'}),entry(4,'b','offer','OTHER',{groupId:'other'}),entry(5,'outsider','offer','OUTSIDE'),entry(6,'b','offer','REVIEW',{requiresSocialReview:true}),entry(7,'b','offer','CLOSED',{status:'done'})]
 const r=await loadGroupMatchEntries({group:async()=>({entries:rows})},{},'group',[{id:'b',name:'Bob'}])
 assert.equal(r.entries.length,1);assert.equal(r.entries[0].name,'Bob');assert.equal('ownerKey' in r.entries[0],false)
})

test('connection and context boilerplate cannot supply evidence, while concrete body topics can',async()=>{
 for(const body of ['Happy to connect','Connection details about shared context','connect connecting connection connections context shared sharing details about']) {
  assert.deepEqual(await matchGroupMembers([entry(1,'me','ask','Design review',{body}),entry(2,'b','offer','Code review',{body})],'me'),[])
  const matches=await matchGroupMembers([entry(1,'me','ask','Design review',{body:body+' PostgreSQL'}),entry(2,'b','offer','Code review',{body:body+' Postgres'})],'me')
  assert.deepEqual(matches[0].pairs[0].topics,['postgres'])
 }
})

test('maximum duplicate workload caches topic operations and lets heartbeats progress',async()=>{
 const terms=Array.from({length:200},(_,i)=>'t'+String(i).padStart(3,'0'))
 const rows=Array.from({length:2000},(_,i)=>entry(i+1,i<1000?'me':'m'+i,i<1000?'ask':'offer','',{body:(i%2?[...terms].reverse():terms).join(' ')}))
 const originalHas=Set.prototype.has,originalLog=Math.log,originalSort=Array.prototype.sort
 let lookups=0,logs=0,sorts=0,heartbeats=0,finished=false
 Set.prototype.has=function(value){lookups++;return originalHas.call(this,value)}
 Math.log=function(value){logs++;return originalLog(value)}
 Array.prototype.sort=function(compare){sorts++;return originalSort.call(this,compare)}
 const heartbeat=async()=>{while(!finished){await nextTurn();if(!finished&&logs===200)heartbeats++}}
 const ticking=heartbeat()
 let matches
 try { matches=await matchGroupMembers(rows,'me') }
 finally {finished=true;Set.prototype.has=originalHas;Math.log=originalLog;Array.prototype.sort=originalSort;await ticking}
 assert.equal(matches.length,12)
 assert.ok(matches.every(m=>m.pairs.length===1&&m.pairs[0].topics.length===200&&m.pairs[0].mine.id===1))
 assert.ok(heartbeats>1,'the event loop progresses during the maximum scan')
 assert.ok(logs<=200,'term weights are calculated once per topic')
 assert.ok(lookups<1000000,'duplicate topic intersections are reused')
 assert.ok(sorts<5000,'intersections are not sorted per pair')
})

test('distinct topic comparisons also yield and preserve deterministic evidence',async()=>{
 const common=Array.from({length:199},(_,i)=>'t'+String(i).padStart(3,'0'))
 const rows=Array.from({length:2000},(_,i)=>entry(i+1,i<1000?'me':'m'+i,i<1000?'ask':'offer','unique'+i,{body:common.join(' ')}))
 let heartbeats=0,comparisons=0,finished=false
 const originalSqrt=Math.sqrt
 Math.sqrt=function(value){comparisons++;return originalSqrt(value)}
 const heartbeat=async()=>{while(!finished){await nextTurn();if(!finished&&comparisons>0)heartbeats++}}
 const ticking=heartbeat()
 let matches
 try {matches=await matchGroupMembers(rows,'me')}
 finally {finished=true;Math.sqrt=originalSqrt;await ticking}
 assert.ok(heartbeats>10,'uncached comparisons cooperate with other requests')
 assert.equal(matches.length,12)
 assert.ok(matches.every(m=>m.pairs[0].mine.id===1))
 assert.deepEqual(matches[0].pairs[0].topics,common)
})

test('introduction, feedback, meeting, chat and call wording needs a concrete shared topic',async()=>{
 for(const [ask,offer] of [['Intro to a designer','Intros to investors'],['Feedback on my pitch','Feedback on resumes'],['Meet founders','Meetings with mentors'],['Quick chat','Chats with operators'],['Sales call','Calls with buyers'],['Introduction, feedback and a call','Intros, feedback, meetings and chats']])
  assert.deepEqual(await matchGroupMembers([entry(1,'me','ask',ask),entry(2,'b','offer',offer)],'me'),[],ask)
 const matches=await matchGroupMembers([entry(1,'me','ask','Intro to a fundraising mentor'),entry(2,'b','offer','Introductions for raising capital')],'me')
 assert.deepEqual(matches[0].pairs[0].topics,['fundraising','introduction'])
 const feedback=await matchGroupMembers([entry(1,'me','ask','Feedback on my React accessibility'),entry(2,'b','offer','WCAG feedback')],'me')
 assert.deepEqual(feedback[0].pairs[0].topics,['accessibility','feedback'])
})
