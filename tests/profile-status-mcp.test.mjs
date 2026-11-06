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
 assert.equal((await reader.profile({id:'alias'})).profile.enrichmentStatus,'enriched')
 assert.equal((await reader.profile({id:'complete'})).profile.enrichmentStatus,'enriched')
 rows=null
 assert.equal((await reader.profile({id:'member'})).profile.enrichmentStatus,'not_recorded')
 assert.equal((await reader.profile({id:'complete'})).profile.enrichmentStatus,'not_recorded')
})
