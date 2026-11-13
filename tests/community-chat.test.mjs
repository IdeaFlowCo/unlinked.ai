import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberBlocks, createMemoryBlockStore } from '../mcp-server/member-blocks.mjs'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'
import { createCollectiveGroups } from '../mcp-server/collective-groups.mjs'
import { createOpenChatGroupSync } from '../mcp-server/openchat-groups.mjs'
import { renderGroupAbout } from '../mcp-server/collective-group-views.mjs'
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
 const store=createNeo4jCollectiveGroupsStore(driver),id=randomUUID(),legacyId=randomUUID()
 const query=async(q,p)=>{const s=driver.session();try{return await s.run(q,p)}finally{await s.close()}}
 t.after(async()=>{await query('MATCH(g) WHERE (g:UnlinkedCollectiveGroup OR g:UnlinkedGroupChatJob) AND g.id IN $ids DETACH DELETE g',{ids:[id,legacyId]});await driver.close()})
 await store.initialize();await store.create({id:legacyId,name:'Legacy',organizer:owner,members:[],invites:[],shares:[]});await store.initialize();assert.equal(await store.chatJob(legacyId),null)
 await store.create({id,chatManaged:true,slug:'test-'+id,name:'Test',organizer:owner,members:[],invites:[],shares:[]})
 assert.equal((await store.bySlug('test-'+id)).id,id)
 const job=await store.chatJob(id);assert.equal(job.revision,1)
 await Promise.all([store.change(id,g=>({...g,name:'Second'})),store.change(id,g=>({...g,description:'Concurrent'}))])
 const next=await store.chatJob(id);assert.equal(next.revision,3)
 await store.chatFinish(id,1,{done:true});assert.equal((await store.chatJob(id)).done,false)
 const immutable={organizer:{issuer:'https://id.ideaflow.app/api/auth',subject:'u',name:'Organizer'}}
 await store.chatPrepare(id,3,immutable,'fixture')
 assert.deepEqual(await store.chatPrepare(id,3,{organizer:{subject:'other'}},'other'),immutable)
 await store.chatFinish(id,3,{done:true})
 const restarted=createNeo4jCollectiveGroupsStore(driver);await restarted.initialize();assert.equal((await restarted.chatJob(id)).revision,3)
 await restarted.change(id,()=>null);assert.equal(await restarted.get(id),null)
 const deleted=await restarted.chatJob(id);assert.equal(deleted.deleted,true);assert.equal(deleted.revision,4);assert.equal(deleted.organizer.subject,'u');assert.equal(deleted.lastSnapshot,undefined);assert.deepEqual(Object.keys(deleted.group).sort(),['id','name'])
})

const receiptFor = snapshot => Response.json({conversationId:communityChatId({id:snapshot.groupId,chatConversationId:snapshot.existingConversationId}),revision:snapshot.revision})

test('outbox excludes private metadata and scrubs acknowledged roster and deletion bindings',async()=>{
 const store=createMemoryCollectiveGroupsStore(),groups=createCollectiveGroups({store,active:identityForOwner}),sent=[]
 const sync=createOpenChatGroupSync({store,identityForOwner,secret:'x'.repeat(32),fetchImpl:async(_,opts)=>{const s=JSON.parse(opts.body);sent.push(s);return receiptFor(s)}})
 const g=await groups.create(owner,'Private group')
 await groups.updateMetadata(owner,g.id,{description:'PRIVATE DESCRIPTION',chatUrl:'https://chat.whatsapp.com/'+'a'.repeat(32),openChatUrl:'https://chat.ideaflow.app/i/'+'b'.repeat(32)})
 await groups.share(owner,g.id,{ids:['PRIVATE SELECTION'],source:'secret-list',name:'Secret list'})
 const pending=await store.chatJob(g.id)
 assert.deepEqual(Object.keys(pending.group).sort(),['id','members','name','organizer'])
 await sync.runOnce()
 const ack=await store.chatJob(g.id)
 assert.deepEqual(Object.keys(ack).sort(),['done','fingerprint','id','organizer','revision'])
 await groups.removeOwner(owner)
 const deleted=await store.chatJob(g.id)
 assert.deepEqual(deleted.group,{id:g.id,name:'Deleted community'})
 assert.equal(deleted.lastSnapshot,undefined)
 await sync.runOnce()
 assert.equal(sent.at(-1).deleted,true);assert.deepEqual(sent.at(-1).members,[])
 assert.deepEqual(Object.keys(await store.chatJob(g.id)).sort(),['done','id','revision'])
})

test('ack loss replays an immutable revision and identity changes enqueue a higher revision',async()=>{
 const store=createMemoryCollectiveGroupsStore(),groups=createCollectiveGroups({store,active:identityForOwner}),sent=[]
 const g=await groups.create(owner,'Builders'),f=await groups.createFlyer(owner,g.id,{capacity:10,approval:false})
 await groups.joinFlyer(member,g.id,f.id,{name:'Member',profileId:null})
 let clock=1,subject='m',fail=true
 const lookup=async actor=>({...await identityForOwner(actor),subject:actor.ownerId==='m'?subject:'u'})
 const sync=createOpenChatGroupSync({store,identityForOwner:lookup,secret:'x'.repeat(32),now:()=>clock,fetchImpl:async(_,opts)=>{
  const s=JSON.parse(opts.body);sent.push(s);if(fail)throw Error('ack lost');return receiptFor(s)
 }})
 await sync.runOnce()
 const first=await store.chatJob(g.id)
 const other={...first.lastSnapshot,name:'Different concurrent computation'}
 assert.deepEqual(await store.chatPrepare(g.id,first.revision,other,'different'),first.lastSnapshot)
 clock=2000;await sync.runOnce()
 assert.deepEqual(sent[0],sent[1])
 subject='rebound-member';clock=4000;fail=false;await sync.runOnce()
 assert.ok(sent.at(-1).revision>sent[0].revision)
 assert.equal(sent.at(-1).members[0].subject,'rebound-member')
 subject='m';await sync.runOnce()
 assert.equal(sent.at(-1).members[0].subject,'m')
 assert.ok(sent.at(-1).revision>sent.at(-2).revision)
})

test('block and unblock change effective chat access and completed jobs reconcile account changes',async()=>{
 const store=createMemoryCollectiveGroupsStore(),sent=[];let groups,memberActive=true,ownerActive=true
 const lookup=async actor=>(actor.ownerId==='m'&&!memberActive || actor.ownerId==='o'&&!ownerActive)?null:identityForOwner(actor)
 const blocks=createMemberBlocks({store:createMemoryBlockStore(),onChange:actor=>groups.reconcileActor(actor)})
 groups=createCollectiveGroups({store,active:lookup,blocked:blocks.between})
 const g=await groups.create(owner,'Builders'),f=await groups.createFlyer(owner,g.id,{capacity:10,approval:false})
 await groups.joinFlyer(member,g.id,f.id,{name:'Member',profileId:null})
 const sync=createOpenChatGroupSync({store,identityForOwner:lookup,blocked:blocks.between,secret:'x'.repeat(32),fetchImpl:async(_,opts)=>{const s=JSON.parse(opts.body);sent.push(s);return receiptFor(s)}})
 await sync.runOnce();assert.equal(sent.at(-1).members.length,1)
 const block=await blocks.block(member,{blocked:owner})
 await assert.rejects(groups.detail(member,g.id),/not_found/)
 const blockedRevision=(await store.chatJob(g.id)).revision
 await sync.runOnce();assert.equal(sent.at(-1).revision,blockedRevision);assert.equal(sent.at(-1).members.length,0)
 await blocks.unblock(member,block.id)
 assert.ok((await store.chatJob(g.id)).revision>blockedRevision)
 assert.equal((await groups.detail(member,g.id)).id,g.id)
 await sync.runOnce();assert.equal(sent.at(-1).members.length,1)
 memberActive=false;await sync.runOnce();assert.equal(sent.at(-1).members.length,0)
 memberActive=true;await sync.runOnce();assert.equal(sent.at(-1).members.length,1)
 ownerActive=false;await sync.runOnce();assert.equal(sent.at(-1).deleted,true)
})

test('legacy groups stay unmanaged through restart and edits until verified organizer activation',async()=>{
 const store=createMemoryCollectiveGroupsStore();let healthy=false,verified=true,verifications=0
 const groups=createCollectiveGroups({store,active:identityForOwner,chatEnabled:true,verifyChatActivation:async input=>{
  verifications++;assert.equal(input.actor.ownerId,owner.ownerId)
  return {healthy,organizerVerified:verified,conversationId:input.conversationId}
 }})
 const id='12345678-1234-4123-8123-123456789abc',conversationId='44HsMDzl6YZ7l1AdNusAT'
 const old={id,name:'Boulder',organizer:owner,organizerProfileId:null,members:[],invites:[],shares:[],openChatUrl:'https://chat.ideaflow.app/i/'+'b'.repeat(32)}
 await store.create(old);await store.initialize()
 assert.equal(await store.chatJob(id),null)
 assert.equal((await groups.detail(owner,id)).chatConversationId,null)
 assert.ok(renderGroupAbout(await groups.detail(owner,id)).includes(old.openChatUrl))
 assert.ok(!renderGroupAbout(await groups.detail(owner,id)).includes('/messages/c/'))
 await groups.updateMetadata(owner,id,{description:'Old group',chatUrl:'',openChatUrl:old.openChatUrl})
 assert.equal(await store.chatJob(id),null)
 await assert.rejects(groups.activateChat(member,id,{existingConversationId:conversationId}),/not_found/)
 assert.equal(verifications,0)
 await assert.rejects(groups.activateChat(owner,id,{existingConversationId:conversationId}),/chat_activation_unavailable/)
 healthy=true;verified=false
 await assert.rejects(groups.activateChat(owner,id,{existingConversationId:conversationId}),/chat_activation_unavailable/)
 verified=true
 await groups.activateChat(owner,id,{existingConversationId:conversationId})
 const first=await store.chatJob(id)
 assert.equal(first.group.chatConversationId,conversationId)
 await groups.activateChat(owner,id,{existingConversationId:conversationId})
 assert.equal((await store.chatJob(id)).revision,first.revision)
 await assert.rejects(groups.activateChat(owner,id,{existingConversationId:'different'}),/chat_binding_conflict/)
 const sent=[],sync=createOpenChatGroupSync({store,identityForOwner,secret:'x'.repeat(32),fetchImpl:async(_,opts)=>{const s=JSON.parse(opts.body);sent.push(s);return receiptFor(s)}})
 await sync.runOnce();assert.equal(sent[0].existingConversationId,conversationId)
 assert.equal((await groups.detail(owner,id)).chatConversationId,conversationId)
 assert.ok(renderGroupAbout(await groups.detail(owner,id)).includes('/messages/c/'+conversationId))
 assert.equal((await store.get(id)).openChatUrl,old.openChatUrl)
 await groups.removeOwner(owner);await sync.runOnce()
 assert.equal(sent.at(-1).existingConversationId,conversationId);assert.equal(sent.at(-1).deleted,true)
})
