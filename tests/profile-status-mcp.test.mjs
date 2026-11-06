import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createMemberPublicIndex, ENRICHMENT_DATASET, LINKEDIN_ENRICHMENT_DATASETS, linkedinEnrichmentId } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { applyProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { ACCOUNT_TOOL_SCHEMAS } from '../mcp-server/account-tools.mjs'
const person = (id, extra={}) => ({id,name:id,positions:[],education:[],skills:[],...extra})
const legacy = {state:'published',complete:true,revision:'status-fixture',profiles:[person('a'),person('b',{about:'Detailed from own content'}),person('c')],connections:[]}
test('published enrichment evidence is independent of membership and depth; revoke removes evidence',async()=>{
 let enrichment={state:'published',complete:true,revision:ENRICHMENT_DATASET+':v1',profiles:[person('a')],connections:[]}
 const source=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>[],publicPeople:{read:async()=>enrichment},readMembers:async()=>['b']})
 const reader=createPublicPeopleReader({readPublishedSnapshot:source,pageSize:1})
 const a=(await reader.profile({id:'a'})).profile,b=(await reader.profile({id:'b'})).profile
 assert.equal(a.enrichmentStatus,'enriched');assert.equal(a.detailLevel,'basic');assert.equal(a.presence,'shadow')
 assert.equal(b.enrichmentStatus,'not_recorded');assert.equal(b.detailLevel,'detailed');assert.equal(b.presence,'member')
 const listed=await reader.list({enrichmentStatus:'not_recorded'})
 assert.equal(listed.total,2);assert.ok(listed.nextCursor)
 await assert.rejects(reader.list({enrichmentStatus:'enriched',cursor:listed.nextCursor}))
 assert.deepEqual((await reader.list({presence:'member',enrichmentStatus:'enriched'})).profiles,[])
 enrichment=null
 assert.equal((await reader.profile({id:'a'})).profile.enrichmentStatus,'not_recorded')
 const older=createPublicPeopleReader({readPublishedSnapshot:async()=>legacy})
 assert.equal((await older.profile({id:'a'})).profile.enrichmentStatus,'unknown')
})
test('merge carries evidence independently of content and preserves owner fields',()=>{
 const snapshot={...legacy,profiles:[person('a',{enrichmentStatus:'enriched',about:'Enriched'}),person('b')]}
 for(const fill of [true,false]){
  const result=applyProfileDecisions(snapshot,[{id:'merge',kind:'merge',profileId:'a',survivorId:'b',fill}])
  assert.equal(result.profiles[0].enrichmentStatus,'enriched')
  assert.equal(result.profiles[0].about,fill?'Enriched':undefined)
 }
})
test('discovery advertises executable membership and enrichment filters',async()=>{
 const card=JSON.parse(await readFile(new URL('../public/.well-known/mcp/server-card.json',import.meta.url)))
 const schema=card.tools.find(t=>t.name==='unlinked_list_people').inputSchema.properties
 for(const key of ['presence','enrichmentStatus']) assert.deepEqual(schema[key].enum,ACCOUNT_TOOL_SCHEMAS.unlinked_list_people[key].unwrap().options)
})

test('MCP service applies the filter and exposes matching status through profile and contact lookup', async()=>{
 const {createAccountToolService}=await import('../mcp-server/account-tools.mjs')
 const {accountGrantTools,CURRENT_ACCOUNT_GRANT_VERSION}=await import('../mcp-server/account-grants.mjs')
 const source=async()=>({...legacy,members:['a'],profiles:[person('a',{enrichmentStatus:'enriched'}),person('b',{enrichmentStatus:'not_recorded'})]})
 const service=createAccountToolService({readPublishedSnapshot:source,getBackend:async()=>({listImportIds:async()=>[]})})
 const scope='owner_network_and_public', grant={ownerId:'fixture-owner',userId:'fixture-user',scope,version:CURRENT_ACCOUNT_GRANT_VERSION,tools:accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION,scope)}
 const call=async(name,input)=>(await service.call({grant,name,input})).result
 const list=await call('unlinked_list_people',{presence:'member',enrichmentStatus:'enriched'})
 assert.deepEqual(list.profiles.map(p=>p.id),['a']);assert.equal(list.total,1)
 const profile=(await call('unlinked_get_profile',{id:'a'})).profile
 const contact=(await call('unlinked_lookup_contact',{profileId:'a'})).contact
 for(const value of [profile,contact]){assert.equal(value.presence,'member');assert.equal(value.enrichmentStatus,'enriched')}
 await assert.rejects(call('unlinked_list_people',{enrichmentStatus:'made-up'}),error=>error.code==='invalid_input')
})

test('LinkedIn evidence survives member merges and budgets, then disappears on revocation', async () => {
 const dataset=LINKEDIN_ENRICHMENT_DATASETS[0]
 const url='https://www.linkedin.com/in/example-person'
 const profiles=[person('member',{headline:'Member words'}),person('alias',{linkedinUrl:url,headline:'Already complete'}),person('complete',{linkedinUrl:'https://www.linkedin.com/in/complete',headline:'Complete'})]
 let rows=[person(linkedinEnrichmentId('example-person'),{headline:'External words'}),person(linkedinEnrichmentId('complete'),{headline:'External words'})]
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>['member'],readDecisions:async()=>[{id:'merge',kind:'merge',profileId:'alias',survivorId:'member',fill:false}],linkedinEnrichmentDatasets:[dataset],linkedinEnrichmentTextBudget:0,publicPeople:{read:async name=>name===dataset && rows ? {state:'published',complete:true,revision:dataset+':1',profiles:rows,connections:[]} : null}})
 const reader=createPublicPeopleReader({readPublishedSnapshot:read})
 const member=(await reader.profile({id:'member'})).profile
 assert.equal(member.headline,'Member words'); assert.equal(member.enrichmentStatus,'enriched'); assert.equal(member.presence,'member')
 assert.deepEqual(await reader.profile({id:'alias'}),{moved:'member'})
 assert.equal((await reader.profile({id:'complete'})).profile.enrichmentStatus,'enriched')
 rows=null
 assert.equal((await reader.profile({id:'member'})).profile.enrichmentStatus,'not_recorded')
 assert.equal((await reader.profile({id:'complete'})).profile.enrichmentStatus,'not_recorded')
})

test('curated evidence preserves confirmed and historical members without import overlays', async () => {
 const profiles=['member','historical','shadow'].map(id=>person(id,{headline:'Own headline',about:'Own about',skills:['Own skill']}))
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>['member'],readLegacyMembers:async()=>['historical'],publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:profiles.map(p=>person(p.id,{headline:'External headline'})),connections:[]})}})
 const result=await read()
 for(const id of ['member','historical']) assert.deepEqual(result.profiles.find(p=>p.id===id),{...profiles.find(p=>p.id===id),enrichmentStatus:'enriched'})
 assert.equal(result.profiles.find(p=>p.id==='shadow').headline,'External headline')
})

test('every linked owner upload contributes evidence even when only the newest supplies text', async () => {
 const {PUBLIC_UPLOAD_CONSENT}=await import('../src/utils/private-import/consent.mjs')
 const older='a'.repeat(64), newer='b'.repeat(64), source='c'.repeat(64), dataset=LINKEDIN_ENRICHMENT_DATASETS[0]
 const owner={ownerId:'owner',userId:'user'}, link={profileId:'claimed',sourceSha256:source,receiptId:'link',revision:1}
 let active=[older,newer]
 const jobs=Object.fromEntries([older,newer].map((id,index)=>[id,{id,ownerId:owner.ownerId,archiveSha256:source,consent:PUBLIC_UPLOAD_CONSENT,status:'indexed',counts:{accepted:1,indexed:1},createdAt:index+1}]))
 const snapshots=Object.fromEntries([older,newer].map(id=>[id,{state:'published',complete:true,revision:'member-public-v1:'+id,profiles:[person('member-import-'+id,{name:id===older?'Older':'Newest',linkedinUrl:'https://www.linkedin.com/in/'+(id===older?'enriched-old':'plain-new')})],connections:[]}]))
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,revision:'legacy-public-v1:'+source,profiles:[person('claimed')]}),discover:async()=>active.map(id=>({id,owner,revision:1})),readMembers:async()=>['claimed'],linkedinEnrichmentDatasets:[dataset],getBackend:async()=>({readResource:async(type,id)=>({sourceOwnerId:owner.ownerId,sourceRevision:1,payload:jobs[id]}),readLegacyProfile:async()=>link}),publicPeople:{read:async name=>name===dataset?{state:'published',complete:true,revision:dataset+':1',profiles:[person(linkedinEnrichmentId('enriched-old'))],connections:[]}:snapshots[name.slice('public-import-'.length)]??null}})
 let result=(await read()).profiles.find(p=>p.id==='claimed')
 assert.equal(result.name,'Newest'); assert.equal(result.enrichmentStatus,'enriched')
 active=[newer]
 result=(await read()).profiles.find(p=>p.id==='claimed')
 assert.equal(result.name,'Newest'); assert.equal(result.enrichmentStatus,'not_recorded')
})


test('historical member words survive a merge into a curated shadow', async () => {
 const profiles=[person('historical',{name:'Member name',headline:'Member headline',about:'Member about',skills:['Member skill']}),person('shadow',{headline:'Shadow headline'})]
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>[],readLegacyMembers:async()=>['historical'],readDecisions:async()=>[{id:'merge',kind:'merge',profileId:'historical',survivorId:'shadow'}],publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:[person('shadow',{headline:'Curated headline',about:'Curated about'})],connections:[]})}})
 const result=await read(), survivor=result.profiles.find(p=>p.id==='shadow')
 assert.equal(survivor.name,'Member name'); assert.equal(survivor.headline,'Member headline'); assert.equal(survivor.about,'Member about'); assert.deepEqual(survivor.skills,['Member skill']); assert.equal(survivor.enrichmentStatus,'enriched')
 assert.deepEqual(result.legacyMembers,['shadow']); assert.equal(result.aliases.historical,'shadow')
})


test('curated identity participates in member merges without replacing member words', async () => {
 const address='https://www.linkedin.com/in/verified-member'
 const profiles=[person('member',{name:'Member name',headline:'Member words',linkedinUrl:address}),person('shadow',{name:'Old shadow'})]
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>['member'],readLegacyMembers:async()=>['member'],mergeSameLinkedin:true,publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:[person('shadow',{name:'Curated name',headline:'Curated words',linkedinUrl:address})],connections:[]})}})
 const result=await read(), member=result.profiles.find(p=>p.id==='member')
 assert.equal(result.aliases.shadow,'member'); assert.equal(result.profiles.length,1)
 assert.equal(member.name,'Member name'); assert.equal(member.headline,'Member words'); assert.equal(member.enrichmentStatus,'enriched')
})

test('curated shadow names yield to explicit operator renames', async () => {
 const profiles=[person('shadow',{name:'Original'}),person('renamed',{name:'Before rename'})]
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>[],readDecisions:async()=>[{id:'rename',kind:'rename',profileId:'renamed',name:'Operator name'}],publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:[person('shadow',{name:'Corrected name'}),person('renamed',{name:'Curated name'})],connections:[]})}})
 const result=await read()
 assert.equal(result.profiles.find(p=>p.id==='shadow').name,'Corrected name')
 assert.equal(result.profiles.find(p=>p.id==='renamed').name,'Operator name')
})


test('suspension follows curated-only identity across otherwise distinct profiles', async () => {
 const url='https://www.linkedin.com/in/suspended-person'
 for (const suspended of ['first','second']) {
  const profiles=[person('first'),person('second',{linkedinUrl:url})]
  const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>[],readDecisions:async()=>[{id:'suspend',kind:'suspend',profileId:suspended}],publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:[person('first',{linkedinUrl:url})],connections:[]})}})
  const result=await read()
  assert.deepEqual(result.profiles,[]); assert.ok(result.suspended.includes('first')); assert.ok(result.suspended.includes('second'))
 }
})

test('curated replacement precedes shadow merge filling and preserves explicit decisions', async () => {
 const profiles=[person('survivor',{name:'Original',headline:'Old'}),person('merged',{about:'Merged about',skills:['Merged skill']})]
 let decisions=[{id:'merge',kind:'merge',profileId:'merged',survivorId:'survivor'},{id:'rename',kind:'rename',profileId:'survivor',name:'Renamed'}], reads=0
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles}),discover:async()=>[],readMembers:async()=>[],readDecisions:async()=>{reads++;return decisions},publicPeople:{read:async()=>({state:'published',complete:true,revision:ENRICHMENT_DATASET+':1',profiles:[person('survivor',{name:'Curated',headline:'Curated headline'})],connections:[]})}})
 let result=await read(), survivor=result.profiles[0]
 assert.equal(reads,1); assert.equal(survivor.name,'Renamed'); assert.equal(survivor.headline,'Curated headline'); assert.equal(survivor.about,'Merged about'); assert.deepEqual(survivor.skills,['Merged skill'])
 decisions=[{id:'merge',kind:'merge',profileId:'merged',survivorId:'survivor',fill:false}]
 survivor=(await read()).profiles[0]; assert.equal(survivor.about,undefined); assert.deepEqual(survivor.skills,[]); assert.equal(survivor.name,'Curated')
})
