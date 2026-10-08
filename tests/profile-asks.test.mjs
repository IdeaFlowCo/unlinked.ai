import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomInt } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'
import { createProfileAsks, profileAskMessagePath, ProfileAskError } from '../mcp-server/profile-asks.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderOwnerAsks, renderProfileAsks } from '../mcp-server/profile-asks-views.mjs'

const evidenceDirectory = process.env.PROFILE_ASKS_EVIDENCE_DIR
async function evidence(name, content) {
 if (!evidenceDirectory) return
 await mkdir(evidenceDirectory, { recursive: true })
 await writeFile(join(evidenceDirectory, name), content)
}

const owner={ownerId:'synthetic-owner-a',userId:'synthetic-user-a'}
const identity={issuer:'https://id.ideaflow.app/api/auth',subject:'synthetic-owner-a'}
const ask={id:'fixture-ask',kind:'ask',text:'Synthetic founders ask <script>',expiresAt:new Date(Date.now()+86400000).toISOString(),revision:1,status:'active',visibility:'public',userIds:[],conversationIds:[]}
const bridge=(extra={})=>createProfileAsks({secret:'synthetic-service-secret-'.repeat(3),identityForOwner:async()=>identity,resolveRecipient:async()=>({status:'member',identity}),...extra})
test('bridge sends only exact trusted identity/opaque ID to fixed OpenChat endpoint and strips private DTO fields',async()=>{
 const calls=[]
 const service=bridge({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify({asks:[{...ask,details:'PRIVATE',counterparty:'SECRET',ownerUserId:'HIDDEN'}]}))}})
 assert.deepEqual(await service.forProfile('seed-person'),[{id:ask.id,kind:'ask',text:ask.text,expiresAt:ask.expiresAt}])
 assert.equal(calls[0].url,'https://chat.ideaflow.app/api/unlinked/profile-asks')
 assert.deepEqual(JSON.parse(calls[0].body),{operation:'list',owner:identity,viewer:null})
 assert.equal(calls[0].redirect,'error')
 await service.mutate(owner,'close',ask.id,{expectedRevision:1})
 assert.deepEqual(JSON.parse(calls[1].body),{operation:'close',owner:identity,viewer:identity,askId:ask.id,input:{expectedRevision:1}})
 const missing=bridge({resolveRecipient:async()=>({status:'unclaimed',name:'Same Name'}),fetchImpl:async()=>{throw Error('must not fetch')}})
 assert.deepEqual(await missing.forProfile('seed-person'),[])
 await assert.rejects(bridge({identityForOwner:async()=>({issuer:'https://evil.invalid',subject:identity.subject})}).mine(owner),{status:403})
 const failure=bridge({fetchImpl:async()=>new Response('outage',{status:503})})
 await assert.rejects(failure.forProfile('seed-person'),{status:503})
})
test('rendered controls are labelled, private by default and escaped; message links carry no ask text or identity',()=>{
 const mine=renderOwnerAsks({asks:[ask],audience:{people:[{id:'person-b',name:'Person B'}],groups:[]}},'fixture-csrf')
 assert.match(mine,/>Add an ask</);assert.match(mine,/>Publish ask</);assert.match(mine,/>Edit ask</);assert.match(mine,/>Close ask</);assert.match(mine,/>Remove ask</)
 assert.match(mine,/<option value="private" selected>/)
 assert.ok(!mine.includes('<script>'));assert.ok(mine.includes('&lt;script&gt;'))
 const path=profileAskMessagePath('seed-person',ask.id),url=new URL(path,'https://www.unlinked.ai')
 assert.deepEqual([...url.searchParams],[['profile','https://www.unlinked.ai/people/seed-person'],['askId',ask.id]])
 assert.ok(renderProfileAsks([ask],'seed-person').includes('Message about this'));assert.equal(renderProfileAsks([],'seed-person'),'')
 assert.equal(profileAskMessagePath('seed-person','bad/ask'),null)
})
for (const entry of ['browser', 'pilot']) test(`${entry} owner publish/edit/close/remove requires same-origin CSRF; viewer cards enforce canonical bridge without polluting public People JSON`,async t=>{
 let mutations=[], live={...ask}, visible=true, reads=[], failMutation=null, failInventory=false
 const service={
  async mine(actor){if(failInventory)throw new ProfileAskError(503,'Synthetic inventory outage');assert.deepEqual(actor,owner);return {asks:live?[live]:[],audience:{people:[{id:'selected-person',name:'Fixture Person'}],groups:[]}}},
  async forProfile(id,viewer){reads.push({id,viewer});return live && visible && live.status==='active'?[live]:[]},
  async mutate(actor,operation,id,input){if(failMutation)throw failMutation;mutations.push({actor,operation,id,input});if(operation==='publish')live={...ask,...input};if(operation==='edit')live={...live,...input,revision:2};if(operation==='close')live={...live,status:'withdrawn'};if(operation==='remove')live=null},
 }
 const snapshot={state:'published',complete:true,revision:'synthetic-asks-v1',profiles:[{id:'seed-person',name:'Same Name',presence:'member',positions:[],education:[],skills:[]}],connections:[]}
 const options={dataMode:'synthetic',profileAsks:service,
  login:{begin:async()=>({location:'https://id.example.invalid/authorize',transaction:{state:'synthetic-state'}}),finish:async()=>identity},
  resolveOwner:async()=>owner,signup:async()=>owner,issueAccountGrant:async()=>({accessToken:'synthetic-fixture'}),revokeAccountGrant:async()=>{},ownProfileId:async()=> 'seed-person',
  getBackend:async()=>({adapter:{},readLegacyProfile:async()=>({profileId:'seed-person',profile:{name:'Owner A'}}),listImportIds:async()=>[],listImportJobIds:async()=>[],readResource:async()=>null}),readPublishedSnapshot:async()=>snapshot,
 }
 let endpoint,origin,runtime
 for(let attempt=0;attempt<10;attempt++){
  const port=randomInt(7000,10000)
  endpoint=`http://127.0.0.1:${port}`;origin=endpoint.replace('http:','https:')
  try{
   if(entry==='pilot') runtime=await startPrivatePilot({...options,baseUrl:origin,port,complete:async()=>({}),accountGrantKey:new Uint8Array(32).fill(7)})
   else{
    const handler=createPrivateBrowserHandler({...options,baseUrl:origin})
    const server=createServer((req,res)=>handler(req,res))
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
    runtime={stop:()=>new Promise(resolve=>server.close(resolve))}
   }
   break
  }catch(error){if(error.code!=='EADDRINUSE'||attempt===9)throw error}
 }
 t.after(()=>runtime.stop())
 const get=(path,cookie)=>fetch(endpoint+path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}})
 const anonymous=await get('/people/seed-person'),html=await anonymous.text();assert.match(html,/Message about this/);assert.equal(anonymous.headers.get('Cache-Control'),'no-store');assert.equal(reads[0].viewer,undefined)
 await evidence(`${entry}-viewer-active.html`, html)
 const publicJson=await(await get('/api/people/seed-person')).json();assert.ok(!JSON.stringify(publicJson).includes('fixture-ask'))
 const start=await get('/login');const transaction=start.headers.getSetCookie().find(c=>c.startsWith('__Host-ul-login=')).split(';')[0]
 const finish=await get('/auth/callback/ideaflow?state=synthetic-state&code=synthetic-code',transaction);const cookie=finish.headers.getSetCookie().find(c=>c.startsWith('__Host-ul-session=')).split(';')[0]
 const ownHtml=await(await get('/profile',cookie)).text(),csrf=/name="csrf" value="([^"]+)"/.exec(ownHtml)[1];assert.match(ownHtml,/>Add an ask</)
 await evidence(`${entry}-owner-profile.html`, ownHtml)
 const post=(operation,fields={},csrfValue=csrf,postOrigin=origin)=>fetch(endpoint+'/profile/asks/'+operation,{redirect:'manual',method:'POST',headers:{Cookie:cookie,Origin:postOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams([['csrf',csrfValue],...Object.entries(fields).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(item=>[key,item]))])})
 const draft={text:'漢'.repeat(2000),visibility:'public',expiresAt:ask.expiresAt.slice(0,16)}
 assert.equal((await post('publish',draft,'forged')).status,403);assert.equal((await post('publish',draft,csrf,'https://evil.invalid')).status,403);assert.equal(mutations.length,0)
 assert.equal((await post('publish',draft)).status,303);assert.deepEqual(mutations[0].actor,owner);assert.deepEqual(mutations[0].input.userIds,[]);assert.equal(mutations[0].input.text,draft.text)
 await evidence(`${entry}-owner-published.html`, await(await get('/profile',cookie)).text())
 const audienceIds=Array.from({length:100},(_,i)=>`synthetic-${i}-`.padEnd(80,'a'))
 assert.equal((await post('edit',{...draft,id:ask.id,visibility:'selected',userIds:audienceIds,conversationIds:audienceIds,expectedRevision:'1'})).status,303)
 assert.equal(mutations[1].input.text,draft.text)
 assert.deepEqual(mutations[1].input.userIds,audienceIds)
 assert.deepEqual(mutations[1].input.conversationIds,audienceIds)
 assert.equal((await post('publish',{...draft,text:'x'.repeat(128 * 1024)})).status,413)
 assert.equal(mutations.length,2)
 visible=false;const revokedHtml=await(await get('/people/seed-person')).text();assert.ok(!revokedHtml.includes('Message about this'))
 await evidence(`${entry}-viewer-revoked.html`, revokedHtml)
 const messages=await get(profileAskMessagePath('seed-person',ask.id),cookie);const messagesHtml=await messages.text();assert.match(messagesHtml,/askId=fixture-ask/)
 await evidence(`${entry}-messages-entry.html`, messagesHtml)
 const signedOut=await get(profileAskMessagePath('seed-person',ask.id));assert.match(await signedOut.text(),/askId%3Dfixture-ask/)
 assert.equal((await post('close',{id:ask.id,expectedRevision:'2'})).status,303);assert.equal((await post('remove',{id:ask.id,expectedRevision:'2'})).status,303)
 assert.equal(mutations.length,4)
 live={...ask,revision:9,text:'Current stored version'}
 const unsaved={text:'Unsaved changes <keep>',visibility:'selected',userIds:'selected-person',expiresAt:draft.expiresAt,id:ask.id,expectedRevision:'3'}
 for(const status of [400,409,503]) {
  failMutation=new ProfileAskError(status,'Synthetic failed edit')
  const failed=await post('edit',unsaved),page=await failed.text()
  assert.equal(failed.status,status);assert.match(page,/Unsaved changes &lt;keep&gt;/);assert.match(page,/Current stored version/)
  assert.match(page,/name="expectedRevision" value="3"/);assert.match(page,/value="selected-person" checked/)
 }
 failInventory=true
 const outageEdit=await post('edit',unsaved),outageEditHtml=await outageEdit.text()
 assert.equal(outageEdit.status,503);assert.match(outageEditHtml,/Your unsaved text/);assert.match(outageEditHtml,/Unsaved changes &lt;keep&gt;/);assert.match(outageEditHtml,/selected-person/)
 assert.ok(!outageEditHtml.includes('action="/profile/asks/edit"'))
 const outagePublish=await post('publish',{...draft,text:'Unsaved publication'})
 assert.equal(outagePublish.status,503);assert.match(await outagePublish.text(),/Unsaved publication/)
 assert.equal(mutations.length,4)

})

 test('bridge filters expired and closed asks and fails closed on malformed responses and revision conflicts',async()=>{
  const service=bridge({fetchImpl:async()=>new Response(JSON.stringify({asks:[ask,{...ask,id:'expired',expiresAt:'2000-01-01T00:00:00Z'},{...ask,id:'closed',status:'withdrawn'}]}))})
  assert.deepEqual((await service.forProfile('seed-person',owner)).map(row=>row.id),[ask.id])
  for (const body of ['invalid JSON',JSON.stringify({asks:[{...ask,id:'invalid/id'}]}),JSON.stringify({asks:null})]) {
   await assert.rejects(bridge({fetchImpl:async()=>new Response(body)}).forProfile('seed-person'),{status:503})
  }
  await assert.rejects(bridge({fetchImpl:async()=>new Response('{}',{status:409})}).mutate(owner,'edit',ask.id,{expectedRevision:0}),{status:409,message:'This ask changed. Reload your profile before saving.'})
  let calls=0
  const disabled=bridge({secret:'',fetchImpl:async()=>{calls++;throw Error('must not fetch')}})
  await assert.rejects(disabled.mine(owner),{status:503});assert.equal(calls,0)
 })

 test('owner adapter accepts the canonical active plus bounded history inventory without widening viewer reads',async()=>{
  const asks=Array.from({length:100},(_,i)=>({...ask,id:`history-${i}`,status:i<50?'active':'withdrawn'}))
  const service=bridge({fetchImpl:async(_url,options)=>new Response(JSON.stringify(JSON.parse(options.body).operation==='audience'?{people:[],groups:[]}:{asks}))})
  const state=await service.mine(owner)
  assert.equal(state.asks.length,100)
  assert.equal(state.asks.filter(a=>a.status==='active').length,50)
  assert.match(renderOwnerAsks(state,'synthetic-csrf'),/history-0/)
  const displayed=await service.forProfile('seed-person',owner)
  assert.deepEqual(displayed.map(row=>row.id),asks.slice(0,50).map(row=>row.id))
  assert.equal((renderProfileAsks(displayed,'seed-person').match(/Message about this/g)??[]).length,50)
  await assert.rejects(service.forProfile('seed-person'),{status:503})
  await assert.rejects(bridge({identityForOwner:async()=>({...identity,subject:'different-owner'}),fetchImpl:async()=>new Response(JSON.stringify({asks}))}).forProfile('seed-person',owner),{status:503})
  const overactive=bridge({fetchImpl:async()=>new Response(JSON.stringify({asks:asks.map(row=>({...row,status:'active'}))}))})
  assert.equal((await overactive.forProfile('seed-person',owner)).length,50)
  const oversized=bridge({fetchImpl:async(_url,options)=>new Response(JSON.stringify(JSON.parse(options.body).operation==='audience'?{people:[],groups:[]}:{asks:[...asks,{...ask,id:'over-bound'}]}))})
  await assert.rejects(oversized.mine(owner),{status:503})
  await assert.rejects(oversized.forProfile('seed-person',owner),{status:503})
 })
