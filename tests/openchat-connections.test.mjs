import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectionRequests, createMemoryConnectionStore } from '../mcp-server/member-connections.mjs'
import { createOpenChatConnectionSync } from '../mcp-server/openchat-connections.mjs'
const a = { ownerId: 'a-owner', userId: 'a-user' }, b = { ownerId: 'b-owner', userId: 'b-user' }
const issuer = 'https://id.ideaflow.app/api/auth'
async function fixture(fetchImpl, identityForOwner = async owner => ({ issuer, subject: owner.userId })) {
  let clock = 1000
  const storage = createMemoryConnectionStore(), deliveries = []
  const store = {
    get: id => storage.get(id),
    async due(now, limit) { return [...storage.records.values()].filter(r => r.status === 'accepted' && !r.openChatSyncStatus && (r.openChatNextAttemptAt ?? 0) <= now).slice(0,limit).map(r=>r.id) },
    async finish(id, at, patch) { const r=storage.records.get(id); if (r?.status==='accepted' && r.respondedAt===at && !r.openChatSyncStatus) Object.assign(r,patch) },
  }
  const service = createConnectionRequests({ store: storage, now:()=>clock })
  const request = await service.send({ sender:a,recipient:b,senderName:'Alice',recipientName:'Bob',note:'PRIVATE NOTE' })
  const make = () => createOpenChatConnectionSync({store,identityForOwner,secret:'s'.repeat(40),now:()=>clock,fetchImpl:async(url,options)=>{deliveries.push({url,options});return fetchImpl(url,options)}})
  return { service,storage,deliveries,id:request.request.id, make, advance:ms=>{clock+=ms} }
}
const ok = () => new Response(JSON.stringify({status:'synced',conversationId:'dm'}))
test('only authorized acceptance queues delivery; no note or local owner IDs leave Unlinked; ack deduplicates restarts',async()=>{
 const f=await fixture(ok),sync=f.make(); await sync.runOnce();assert.equal(f.deliveries.length,0)
 await assert.rejects(f.service.respond(a,f.id,'accept'));await sync.runOnce();assert.equal(f.deliveries.length,0)
 await f.service.respond(b,f.id,'accept');await sync.runOnce();await f.make().runOnce()
 assert.equal(f.deliveries.length,1);const req=f.deliveries[0];assert.equal(req.url,'https://chat.ideaflow.app/api/unlinked/connections/accepted');assert.equal(req.options.redirect,'error')
 assert.deepEqual(JSON.parse(req.options.body),{requestId:f.id,acceptedAt:1000,sender:{issuer,subject:a.userId,name:'Alice'},recipient:{issuer,subject:b.userId,name:'Bob'}})
})
test('lost response retries the identical intention after durable backoff across worker restart',async()=>{
 let attempts=0;const f=await fixture(()=>{if(++attempts===1)throw Error('lost response');return ok()})
 await f.service.respond(b,f.id,'accept');await f.make().runOnce();await f.make().runOnce();assert.equal(attempts,1)
 f.advance(5000);await f.make().runOnce();assert.equal(attempts,2);assert.equal(f.deliveries[0].options.body,f.deliveries[1].options.body)
 assert.equal(f.storage.records.get(f.id).openChatSyncStatus,'synced')
})
test('crossed requests converge on original acceptance; ignored, withdrawn and removed requests never deliver',async()=>{
 const f=await fixture(ok);await f.service.send({sender:b,recipient:a});await f.make().runOnce();assert.equal(f.deliveries.length,1)
 for (const action of ['ignore','withdraw','remove']) {
  const x=await fixture(ok)
  if(action==='withdraw')await x.service.withdraw(a,x.id)
  else {await x.service.respond(b,x.id,action==='remove'?'accept':action);if(action==='remove')await x.service.remove(a,x.id)}
  await x.make().runOnce();assert.equal(x.deliveries.length,0)
 }
})
test('identity outages/ambiguity retry without transport; rejection of a stale removed request after lookup',async()=>{
 const f=await fixture(ok,async()=>null);await f.service.respond(b,f.id,'accept');await f.make().runOnce();assert.equal(f.deliveries.length,0);assert.equal(f.storage.records.get(f.id).openChatSyncAttempts,1)
 let x; x=await fixture(ok,async owner=>{if(owner.userId===a.userId)await x.service.remove(a,x.id);return {issuer,subject:owner.userId}})
 await x.service.respond(b,x.id,'accept');await x.make().runOnce();assert.equal(x.deliveries.length,0)
})
test('server suppression is final and overlapping wakes do not duplicate transport',async()=>{
 const f=await fixture(()=>new Response(JSON.stringify({status:'suppressed',conversationId:null})));await f.service.respond(b,f.id,'accept');const sync=f.make()
 await Promise.all([sync.runOnce(),sync.runOnce(),sync.runOnce()]);assert.equal(f.deliveries.length,1);await f.make().runOnce();assert.equal(f.deliveries.length,1)
 await sync.stop();await sync.runOnce();assert.equal(f.deliveries.length,1)
})
