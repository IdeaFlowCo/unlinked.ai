import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { peopleFilters } from '../src/utils/public-people/search-filters.mjs'
const profile=(id,extra={})=>({id,name:id,positions:[],education:[],skills:[],...extra})
const source=()=>({state:'published',complete:true,revision:'v1',profiles:[profile('self'),profile('first'),profile('second',{company:'Acme',location:'Montréal',industry:'Software',positions:[{company:'Oldco',title:'Engineer',endDate:'2020'},{company:'Acme',title:'Founder'}],education:[{institution:'MIT'}]}),profile('third'),profile('unknown')],connections:[{fromId:'self',toId:'first'},{fromId:'first',toId:'second'},{fromId:'second',toId:'third'}]})
test('degree is shortest recorded visible path; unknown never becomes third degree',async()=>{
 const reader=createPublicPeopleReader({readPublishedSnapshot:async()=>source()})
 for(const [degree,id] of [['1','first'],['2','second'],['3','third']]){
  const result=await reader.list({filters:{degree},networkSeeds:['first'],networkSelf:'self',viewer:{signedIn:true,id:'self'}})
  assert.deepEqual(result.profiles.map(p=>p.id),[id]);assert.equal(result.profiles[0].connectionDegree,Number(degree))
 }
 await assert.rejects(reader.list({filters:{degree:'2'}}),{status:400})
})
test('all facets combine before ranking, totals and pagination; cursor bound to facets',async()=>{
 const reader=createPublicPeopleReader({readPublishedSnapshot:async()=>source(),pageSize:1})
 const all=await reader.list({includeTotal:true})
 const filters={location:'Montreal',company:'acme',pastCompany:'oldco',school:'mit',title:'founder',industry:'software'}
 assert.deepEqual((await reader.list({filters,includeTotal:true})).profiles.map(p=>p.id),['second'])
 assert.equal((await reader.list({filters:{...filters,company:'Oldco'},includeTotal:true})).total,0)
 await assert.rejects(reader.list({filters,cursor:all.nextCursor}),{status:400})
 assert.throws(()=>peopleFilters(new URLSearchParams('degree=2&degree=3')))
 assert.throws(()=>peopleFilters({degree:'4'}))
})
test('degree traversal honors private connection policy',async()=>{
 const data=source();data.connectionPrivacy={first:{audience:'only_me',scope:'all'}}
 const reader=createPublicPeopleReader({readPublishedSnapshot:async()=>data})
 assert.deepEqual((await reader.list({filters:{degree:'2'},networkSeeds:['first'],networkSelf:'self',viewer:{signedIn:true,id:'self'}})).profiles,[])
})

test('first-degree private contacts retain owner-only contact links and save identities', async () => {
 const {renderPeople}=await import('../mcp-server/private-onboarding-views.mjs')
 const id='a'.repeat(64)
 const view=renderPeople({csrf:'fixture',filters:{degree:'1'},savedListsAvailable:true,connectedView:{total:1,rows:[{name:'Private direct contact',sourceRowId:id,contactHref:'/network/contacts/'+id}]}})
 assert.match(view.content,new RegExp('href="/network/contacts/'+id+'"'))
 assert.match(view.content,new RegExp('value="contact:'+id+'"'))
 assert.doesNotMatch(view.content,/href="\/people\/"/)
})
