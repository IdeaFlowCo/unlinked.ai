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
  const make = (options = {}) => createOpenChatConnectionSync({store,identityForOwner,secret:'s'.repeat(40),now:()=>clock,fetchImpl:async(url,options)=>{deliveries.push({url,options});return fetchImpl(url,options)},...options})
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

test('invalid receipts and HTTP failures remain retryable; missing credentials and invalid identities never dispatch', async () => {
  for (const response of [() => new Response('', {status:503}), () => new Response('not json'),
    () => new Response(JSON.stringify({status:'synced'})),
    () => new Response(JSON.stringify({status:'suppressed',conversationId:'unexpected'})),
    () => new Response('x'.repeat(2049))]) {
    const f = await fixture(response)
    await f.service.respond(b, f.id, 'accept')
    await f.make().runOnce()
    assert.equal(f.storage.records.get(f.id).openChatSyncStatus, undefined)
    assert.equal(f.storage.records.get(f.id).openChatNextAttemptAt, 6000)
    await f.make().runOnce()
    assert.equal(f.deliveries.length, 1)
  }
  for (const secret of [undefined, '', 'short']) {
    const f = await fixture(ok)
    await f.service.respond(b, f.id, 'accept')
    await f.make({secret}).runOnce()
    assert.equal(f.deliveries.length, 0)
  }
  for (const identityForOwner of [async () => ({issuer:'https://wrong.invalid',subject:'id'}),
    async () => ({issuer,subject:'same'}), async () => ({issuer,subject:'bad\nsubject'})]) {
    const f = await fixture(ok, identityForOwner)
    await f.service.respond(b, f.id, 'accept')
    await f.make().runOnce()
    assert.equal(f.deliveries.length, 0)
  }
})

test('acceptance and crossed requests wake synchronization only after the accepted state is readable', async () => {
  for (const crossed of [false, true]) {
    const store = createMemoryConnectionStore()
    let wakes = 0, statusAtWake
    const service = createConnectionRequests({store, onAccepted:async () => {
      wakes++
      statusAtWake = [...store.records.values()][0].status
    }})
    const {request} = await service.send({sender:a,recipient:b})
    assert.equal(wakes, 0)
    if (crossed) await service.send({sender:b,recipient:a})
    else await service.respond(b, request.id, 'accept')
    assert.equal(wakes, 1)
    assert.equal(statusAtWake, 'accepted')
    await assert.rejects(service.respond(b, request.id, 'accept'))
    assert.equal(wakes, 1)
  }
})

test('startup reconciles old acceptances over HTTP; periodic retry preserves the event and ack prevents replay', async t => {
  const {createServer} = await import('node:http')
  const {setTimeout:delay} = await import('node:timers/promises')
  const transcript = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    assert.equal(req.headers.authorization, `Bearer ${'s'.repeat(40)}`)
    transcript.push({method:req.method, path:req.url, authorizedWithSyntheticSecret:true, payload:JSON.parse(raw)})
    if (transcript.length === 1) { req.socket.destroy(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({status:'synced',conversationId:'synthetic-receiver-dm'}))
  })
  for (let port = 7000 + Math.floor(Math.random() * 3000); ; port = 7000 + (port - 6999) % 3000) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      break
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const f = await fixture((url, options) => {
    assert.equal(url, 'https://chat.ideaflow.app/api/unlinked/connections/accepted')
    return fetch(`http://127.0.0.1:${server.address().port}/api/unlinked/connections/accepted`, options)
  })
  await f.service.respond(b, f.id, 'accept')
  const old = f.make()
  old.start()
  await old.runOnce()
  await old.stop()
  const retryState = structuredClone(f.storage.records.get(f.id))
  assert.equal(retryState.openChatNextAttemptAt, 6000)
  const restarted = f.make({intervalMs:10})
  t.after(() => restarted.stop())
  restarted.start()
  await restarted.runOnce()
  assert.equal(transcript.length, 1)
  f.advance(5000)
  for (let i = 0; i < 200 && !f.storage.records.get(f.id).openChatSyncStatus; i++) await delay(10)
  await restarted.stop()
  assert.equal(f.storage.records.get(f.id).openChatSyncStatus, 'synced')
  await f.make().runOnce()
  assert.equal(transcript.length, 2)
  assert.deepEqual(transcript[0].payload, transcript[1].payload)
  assert.deepEqual(Object.keys(transcript[0].payload).sort(), ['acceptedAt','recipient','requestId','sender'])
  if (process.env.UNLINKED_SYNC_TEST_EVIDENCE) {
    const {writeFile} = await import('node:fs/promises')
    await writeFile(process.env.UNLINKED_SYNC_TEST_EVIDENCE, JSON.stringify({
      scope:'Actual sender and local HTTP transport; synthetic receiver responses and memory store. Does not validate OpenChat DM creation or Neo4j durability.',
      acceptance:await f.storage.get(f.id), retryState, http:transcript,
      receipt:{status:'synced',conversationId:'synthetic-receiver-dm'}, dispatchesAfterAcknowledgedRestart:0,
    }, null, 2))
  }
})

test('unresponsive transport aborts within the eight-second delivery budget and schedules retry', {timeout:11000}, async () => {
  const f = await fixture((_url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once:true})
  }))
  await f.service.respond(b, f.id, 'accept')
  const start = performance.now()
  const keepAlive = setTimeout(() => {}, 10000)
  try { await f.make().runOnce() } finally { clearTimeout(keepAlive) }
  assert.ok(performance.now() - start >= 7900)
  assert.ok(performance.now() - start < 10000)
  assert.equal(f.storage.records.get(f.id).openChatSyncAttempts, 1)
  assert.equal(f.storage.records.get(f.id).openChatSyncStatus, undefined)
})
