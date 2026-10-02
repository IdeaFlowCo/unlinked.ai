import test from 'node:test'
import assert from 'node:assert/strict'
import { createKnownConnectionsReader, knownConnectionQuery } from '../src/utils/public-people/known-connections.mjs'
const profile=id=>({id,name:'Person '+id,headline:'Engineer',positions:[],email:'private@test.invalid'})
const owner={ownerId:'owner-a',userId:'user-a'},anchor={profileId:'a',receiptId:'verified-link',revision:'legacy-public-v1:source'}
const snapshot={state:'published',complete:true,revision:'public-v1',profiles:['a','b','c','d','other'].map(profile),connections:[{fromId:'a',toId:'b'},{fromId:'b',toId:'c'},{fromId:'b',toId:'a'},{fromId:'a',toId:'d'},{fromId:'d',toId:'c'},{fromId:'other',toId:'d'}]}
const make=(change={})=>createKnownConnectionsReader({owner,getBackend:async actual=>{assert.deepEqual(actual,owner);return{readLegacyProfile:async()=>anchor}},readPublishedSnapshot:async()=>snapshot,...change})
test('same caller directed one/two-hop uses both public endpoints, excludes direct/self and unrelated graph, no contact fields',async()=>{
 const one=await make()();assert.deepEqual(one.profiles.map(p=>p.id),['b','d'])
 const two=await make()({degree:2});assert.deepEqual(two.profiles.map(p=>p.id),['c']);assert.deepEqual(two.paths,[{fromId:'a',viaId:'b',toId:'c'}]);assert.equal(two.sourceRevision,anchor.revision);assert.ok(!JSON.stringify(two).includes('private@test'))
 assert.equal((await make()({degree:2,query:'no-match'})).total,0)
})
test('unknown owner anchor, private-only endpoint and revoked/changing source cannot bypass path privacy',async()=>{
 await assert.rejects(make({getBackend:async()=>({readLegacyProfile:async()=>null})})(),/anchor_unavailable/)
 await assert.rejects(make({readPublishedSnapshot:async()=>({...snapshot,profiles:snapshot.profiles.filter(p=>p.id!=='c')})})({degree:2}),/unavailable/)
 let calls=0;await assert.rejects(make({getBackend:async()=>({readLegacyProfile:async()=>++calls===1?anchor:null})})({degree:2}),/changed/)
 let reads=0;await assert.rejects(make({readPublishedSnapshot:async()=>({...snapshot,revision:++reads===1?'public-v1':'revoked-v2'})})(),/changed/)
 await assert.rejects(make()({degree:3}),/input_invalid/)
})
test('pagination cursor is owner, query, degree, confirmation and live revision bound',async()=>{
 const large={...snapshot,profiles:[profile('a'),...Array.from({length:101},(_,i)=>profile('n'+String(i).padStart(3,'0')))],connections:Array.from({length:101},(_,i)=>({fromId:'a',toId:'n'+String(i).padStart(3,'0')}))}
 const read=make({readPublishedSnapshot:async()=>large}), first=await read();assert.equal(first.profiles.length,100);assert.equal((await read({cursor:first.nextCursor})).profiles.length,1)
 await assert.rejects(read({cursor:first.nextCursor,degree:2}),/cursor_invalid/)
 await assert.rejects(read({cursor:first.nextCursor,query:'Engineer'}),/cursor_invalid/)
 const mutable={...owner},captured=createKnownConnectionsReader({owner:mutable,getBackend:async actual=>{assert.deepEqual(actual,owner);return{readLegacyProfile:async()=>anchor}},readPublishedSnapshot:async()=>large});mutable.ownerId='other';assert.equal((await captured()).profiles.length,100)
})

test('natural second-degree request selects recorded two-hop while ordinary AI search keeps its query',()=>{
 assert.deepEqual(knownConnectionQuery('my second-degree connections'),{degree:2,query:''})
 assert.deepEqual(knownConnectionQuery('find my two-hop connections Engineer'),{degree:2,query:'Engineer'})
 assert.deepEqual(knownConnectionQuery('Graph engineers'),{query:'Graph engineers'})
 assert.deepEqual(knownConnectionQuery('Engineer',1),{degree:1,query:'Engineer'})
 assert.throws(()=>knownConnectionQuery('Engineer',3),/input_invalid/)
})
