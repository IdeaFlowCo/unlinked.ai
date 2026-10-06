import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createMessagingHandler, createMessagingResolver, IDEAFLOW_ISSUER, MESSAGING_PATH } from '../mcp-server/messaging.mjs'

const owner = { ownerId:'private-owner', userId:'private-user' }
const identity = { issuer:IDEAFLOW_ISSUER, subject:'private-subject' }
const snapshot = { state:'published', complete:true, profiles:[{ id:'person', name:'Person', email:'imported@example.invalid' }] }
test('published owner resolves via durable identity without leaking imported/private fields', async () => {
  const resolve = createMessagingResolver({ readPublishedSnapshot:async()=>snapshot, accountForProfile:async id=>{ assert.equal(id,'person');return owner }, identityForOwner:async value=>{ assert.deepEqual(value,owner);return identity } })
  assert.deepEqual(await resolve('person'), { status:'member', name:'Person', identity })
  assert.deepEqual(await resolve('removed'), { status:'unavailable' })
})
test('unclaimed, revoked and incomplete publication never become recipients', async () => {
  let account = null, published = snapshot, calls = 0
  const resolve = createMessagingResolver({ readPublishedSnapshot:async()=>published, accountForProfile:async()=>account, identityForOwner:async()=>{ calls++;return null } })
  assert.deepEqual(await resolve('person'), { status:'unclaimed', name:'Person' });assert.equal(calls,0)
  account=owner;assert.deepEqual(await resolve('person'), { status:'unavailable' })
  published={...snapshot,complete:false};await assert.rejects(resolve('person'))
})
test('confidential endpoint rejects browsers, grants, malformed requests and excess body data before resolving', async t => {
  const secret='s'.repeat(40);let calls=0,handler
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  handler=createMessagingHandler({origin:endpoint.replace('http:','https:'),secret,resolveRecipient:async()=>{calls++;return {status:'member',name:'Person',identity}}})
  const request=(body,headers={Authorization:`Bearer ${secret}`})=>fetch(endpoint+MESSAGING_PATH,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  assert.equal((await request({profileId:'person'},{})).status,401)
  assert.equal((await request({profileId:'person'},{Authorization:'Bearer ordinary-agent-grant'})).status,401)
  assert.equal((await request({profileId:'person'},{Authorization:`Bearer ${secret}`,Origin:'https://www.unlinked.ai'})).status,403)
  assert.equal((await request({profileId:'person',subject:'forged'})).status,400)
  assert.equal((await request({profileId:'../private'})).status,400)
  assert.equal((await request({profileId:'x'.repeat(3000)})).status,413)
  assert.equal(calls,0)
  const ready=await request({profileId:'person'});assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store');assert.deepEqual(await ready.json(),{status:'member',name:'Person',identity});assert.equal(calls,1)
})
test('missing service configuration and resolver outages return availability errors',async t=>{
  let handler=createMessagingHandler({origin:'https://www.unlinked.ai'})
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(endpoint+MESSAGING_PATH)).status,503)
  handler=createMessagingHandler({origin:endpoint.replace('http:','https:'),secret:'s'.repeat(40),resolveRecipient:async()=>{throw Error('offline')}})
  const response=await fetch(endpoint+MESSAGING_PATH,{method:'POST',headers:{Authorization:`Bearer ${'s'.repeat(40)}`},body:JSON.stringify({profileId:'person'})})
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'messaging_unavailable'})
})
