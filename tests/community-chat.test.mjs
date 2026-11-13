import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'
import { createCollectiveGroups } from '../mcp-server/collective-groups.mjs'
import { createOpenChatGroupSync } from '../mcp-server/openchat-groups.mjs'
import { communityChatId } from '../mcp-server/community-chat-id.mjs'
const owner={ownerId:'o',userId:'u'}, member={ownerId:'m',userId:'m'}
const identityForOwner=async actor=>({issuer:'https://id.ideaflow.app/api/auth',subject:actor.userId})
test('readable stable addresses, opaque choice and existing UUID lookup',async()=>{
 const store=createMemoryCollectiveGroupsStore(),groups=createCollectiveGroups({store,active:identityForOwner,chatEnabled:true})
 const g=await groups.create(owner,'Boulder Tech Builders')
 assert.match(g.urlKey,/^boulder-tech-builders-/)
 assert.equal(await groups.resolveKey(g.urlKey),g.id)
 assert.equal(await groups.resolveKey(g.id),g.id)
 let detail=await groups.detail(owner,g.id)
 assert.equal(detail.chatConversationId,communityChatId(g))
 await groups.updateMetadata(owner,g.id,{description:'Meetup',chatUrl:'',urlMode:'opaque'})
 assert.equal(await groups.resolveKey(g.urlKey),null)
 assert.equal((await groups.detail(owner,g.id)).urlKey,g.id)
 await groups.updateMetadata(owner,g.id,{description:'Meetup',chatUrl:'',urlMode:'readable'})
 assert.equal((await groups.detail(owner,g.id)).urlKey,g.urlKey)
 await assert.rejects(groups.detail(member,g.id),/not_found/)
})
test('durable roster includes accepted members, excludes pending, removes departures and deletes',async()=>{
 const store=createMemoryCollectiveGroupsStore(),groups=createCollectiveGroups({store,active:identityForOwner}),sent=[]
 const sync=createOpenChatGroupSync({store,identityForOwner,secret:'x'.repeat(32),fetchImpl:async(url,opts)=>{
  const body=JSON.parse(opts.body);sent.push(body);return {ok:true,text:async()=>JSON.stringify({conversationId:communityChatId({id:body.groupId}),revision:body.revision})}
 }})
 const g=await groups.create(owner,'Builders');await sync.runOnce();assert.equal(sent.at(-1).members.length,0)
 const f=await groups.createFlyer(owner,g.id,{days:1,capacity:20,approval:true})
 await groups.joinFlyer(member,g.id,f.id,{name:'Member',profileId:null});await sync.runOnce();assert.equal(sent.at(-1).members.length,0)
 const detail=await groups.detail(owner,g.id)
 await groups.decideFlyerRequest(owner,g.id,f.id,detail.flyer.requests[0].id,'approve');await sync.runOnce();assert.equal(sent.at(-1).members[0].subject,'m')
 await groups.leave(member,g.id);await sync.runOnce();assert.equal(sent.at(-1).members.length,0)
 await groups.removeOwner(owner);await sync.runOnce();assert.equal(sent.at(-1).deleted,true)
 assert.deepEqual(await store.chatDue(Date.now(),20),[])
})
test('delivery retries and an older receipt cannot mark a newer membership change complete',async()=>{
 const store=createMemoryCollectiveGroupsStore(),groups=createCollectiveGroups({store,active:identityForOwner});const g=await groups.create(owner,'Builders');let clock=1,fail=true
 const sync=createOpenChatGroupSync({store,identityForOwner,secret:'x'.repeat(32),now:()=>clock,fetchImpl:async(url,opts)=>{
  if(fail)throw Error('offline');const snapshot=JSON.parse(opts.body)
  await store.change(g.id,row=>({...row,description:'new edit'}))
  return {ok:true,text:async()=>JSON.stringify({conversationId:communityChatId(g),revision:snapshot.revision})}
 }})
 await sync.runOnce();assert.equal((await store.chatJob(g.id)).done,false)
 clock=2000;fail=false;await sync.runOnce();assert.equal((await store.chatJob(g.id)).done,false)
})

test('real Neo4j outbox survives restart, serialized changes and deletion', {skip:!/^bolt:\/\/127\.0\.0\.1:\d+$/.test(process.env.UNLINKED_TEST_NEO4J_URI??'') || !process.env.UNLINKED_TEST_NEO4J_DRIVER},async t=>{
 const {createRequire}=await import('node:module'),{randomUUID}=await import('node:crypto')
 const neo4j=createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
 const driver=neo4j.driver(process.env.UNLINKED_TEST_NEO4J_URI,neo4j.auth.basic('neo4j',process.env.UNLINKED_TEST_NEO4J_PASSWORD))
 const {createNeo4jCollectiveGroupsStore}=await import('../mcp-server/collective-groups-store.mjs')
 const store=createNeo4jCollectiveGroupsStore(driver),id=randomUUID()
 const query=async(q,p)=>{const s=driver.session();try{return await s.run(q,p)}finally{await s.close()}}
 t.after(async()=>{await query('MATCH(g) WHERE (g:UnlinkedCollectiveGroup OR g:UnlinkedGroupChatJob) AND g.id=$id DETACH DELETE g',{id});await driver.close()})
 await store.initialize();await store.create({id,slug:'test-'+id,name:'Test',organizer:owner,members:[],invites:[],shares:[]})
 assert.equal((await store.bySlug('test-'+id)).id,id)
 const job=await store.chatJob(id);assert.equal(job.revision,1)
 await Promise.all([store.change(id,g=>({...g,name:'Second'})),store.change(id,g=>({...g,description:'Concurrent'}))])
 const next=await store.chatJob(id);assert.equal(next.revision,3)
 await store.chatFinish(id,1,{done:true});assert.equal((await store.chatJob(id)).done,false)
 await store.chatFinish(id,3,{lastSnapshot:{organizer:{issuer:'https://id.ideaflow.app/api/auth',subject:'u',name:'Owner'}},done:true})
 const restarted=createNeo4jCollectiveGroupsStore(driver);await restarted.initialize();assert.equal((await restarted.chatJob(id)).revision,3)
 await restarted.change(id,()=>null);assert.equal(await restarted.get(id),null)
 const deleted=await restarted.chatJob(id);assert.equal(deleted.deleted,true);assert.equal(deleted.revision,4);assert.equal(deleted.lastSnapshot.organizer.subject,'u')
})
