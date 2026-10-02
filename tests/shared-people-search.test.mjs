import test from 'node:test'
import assert from 'node:assert/strict'
import {createSharedPeopleSearch} from '../src/utils/public-people/shared-search.mjs'
const snapshot = profiles => ({state:'published',complete:true,revision:'public-v1',profiles,connections:[]})
test('member without any import searches the entire public index including final profile, and AI only receives safe professional candidates',async()=>{
 const profiles=Array.from({length:16296},(_,i)=>({id:'legacy-'+i,name:'Public person '+i,positions:[],education:[],skills:[]}));profiles.at(-1).headline='Quantum graph engineer';profiles.at(-1).email='never-pass-private-field@example.invalid'
 let calls=0;const search=createSharedPeopleSearch({readPublishedSnapshot:async()=>snapshot(profiles),complete:async({input,candidateIds})=>{calls++;const value=JSON.parse(input);assert.equal(value.observations.length,1);assert.equal(value.observations[0].fields.email,undefined);assert.equal(input.includes('never-pass-private-field'),false);return{matches:[{id:candidateIds[0],reason:'Recorded quantum graph role'}]}}})
 const result=await search({query:'Who is a quantum graph engineer?'});assert.equal(result.considered,16296);assert.equal(result.modelCandidates,1);assert.equal(result.matches[0].id,'legacy-16295');assert.equal(calls,1)
 const empty=await search({query:'unique-unobserved-specialty'});assert.equal(empty.matches.length,0);assert.equal(calls,1)
})
test('bounded retrieval ranks all lexical matches deterministically and rejects invented model IDs',async()=>{
 const data=snapshot(Array.from({length:1001},(_,i)=>({id:String(i).padStart(4,'0'),name:'Engineer '+i,positions:[],education:[],skills:[]})))
 const search=createSharedPeopleSearch({readPublishedSnapshot:async()=>data,complete:async({candidateIds})=>{assert.equal(candidateIds.length,200);return{matches:[{id:'invented',reason:'No proof'}]}}})
 await assert.rejects(search({query:'engineer'}),/shared_search_result_invalid/)
})
test('unavailable/incomplete publications are not empty results; late revocation wins over model output',async()=>{
 let live=true;const data=snapshot([{id:'p',name:'Graph engineer',positions:[],education:[],skills:[]}])
 const search=createSharedPeopleSearch({readPublishedSnapshot:async()=>live?data:null,complete:async({candidateIds})=>{live=false;return{matches:[{id:candidateIds[0],reason:'Recorded graph role'}]}}})
 await assert.rejects(search({query:'graph'}),/shared_people_changed/)
 await assert.rejects(search({query:'graph'}),/shared_people_unavailable/)
 await assert.rejects(search({query:''}),/shared_search_query_invalid/)
})
