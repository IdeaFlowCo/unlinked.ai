import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'

test('signed legacy match asks once; CSRF, typed identity injection and anonymous confirmation cannot link', async t => {
  let handler, linked = false, confirms = 0
  const owner = { ownerId: 'owner-one', userId: 'user-one' }, profileId = 'old-profile'
  const server = createServer((req,res) => void handler(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve=>server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:','https:')
  const identity = { issuer:'https://identity.invalid',subject:'signed-subject',clientId:'client',verifiedAt:Math.floor(Date.now()/1000),verifiedEmail:'legacy@example.invalid',emailEvidence:'signed-ideaflow-beta-v1',displayName:'Current Member' }
  handler = createPrivateBrowserHandler({ baseUrl, login:{begin:async()=>({location:'https://identity.invalid/login',transaction:{state:'state'}}),finish:async()=>identity},
    resolveOwner:async()=>owner, signup:async()=>owner, issueAccountGrant:async()=>{},revokeAccountGrant:async()=>{},
    legacyAccount:{candidate:async proof=>{assert.deepEqual(proof,{issuer:identity.issuer,subject:identity.subject,clientId:'client',verifiedAt:identity.verifiedAt,email:identity.verifiedEmail,emailEvidence:identity.emailEvidence,...owner});return {profileId,linked}},
      confirm:async(proof,id,confirmation)=>{assert.equal(proof.email,identity.verifiedEmail);assert.equal(proof.subject,identity.subject);assert.equal(id,profileId);assert.equal(confirmation,true);confirms++;linked=true}},
    getBackend:async()=>({adapter:{},listImportIds:async()=>[],listImportJobIds:async()=>[],readResource:async()=>null,readLegacyProfile:async()=>linked?{profile:{name:'Recovered Member',headline:'Original role',positions:[],education:[],skills:['Preserved skill']}}:null}),
  })
  const request=(path,options={})=>fetch(endpoint+path,{redirect:'manual',...options})
  assert.equal((await request('/legacy-account',{method:'POST',headers:{Origin:baseUrl},body:'action=confirm'})).status,401)
  const signin=async()=>{const begin=await request('/login');const result=await request('/auth/callback/ideaflow?code=code&state=state',{headers:{Cookie:begin.headers.getSetCookie()[0].split(';')[0]}});return {result,cookie:result.headers.getSetCookie().find(value=>value.startsWith('__Host-ul-session=')).split(';')[0]}}
  const {result,cookie}=await signin();assert.equal(result.headers.get('Location'),'/legacy-account');assert.equal(confirms,0)
  const page=await request('/legacy-account',{headers:{Cookie:cookie}}), content=await page.text();assert.match(content,/This looks like your old Unlinked account/)
  const csrf=content.match(/name="csrf" value="([^"]+)"/)[1]
  const post=(body,origin=baseUrl)=>request('/legacy-account',{method:'POST',headers:{Cookie:cookie,Origin:origin},body})
  assert.equal((await post('csrf=wrong&action=confirm')).status,400)
  assert.equal((await post(new URLSearchParams({csrf,action:'confirm',email:'victim@example.invalid'}))).status,400)
  assert.equal((await post(new URLSearchParams({csrf,action:'confirm'}),'https://other.invalid')).status,403)
  assert.equal(confirms,0)
  assert.equal((await post(new URLSearchParams({csrf,action:'confirm'}))).headers.get('Location'),'/profile');assert.equal(confirms,1)
  assert.equal((await post(new URLSearchParams({csrf,action:'confirm'}))).status,400);assert.equal(confirms,1)
  const profile=await request('/profile',{headers:{Cookie:cookie}});assert.match(await profile.text(),/Recovered Member/)
  assert.equal((await signin()).result.headers.get('Location'),'/')
})

test('legacy own-network rows retain directed source provenance and disappear on binding revocation',async()=>{
  const owner={ownerId:'owner',userId:'user'}, legacy={profileId:'first',receiptId:'receipt',sourceSha256:'a'.repeat(64),revision:'legacy-public-v1:'+ 'a'.repeat(64),profiles:[{id:'second',name:'Known Person',positions:[{company:'Old Company'}]}],connections:[{fromId:'first',toId:'second'}]}
  let calls=0
  const getBackend=async()=>({listImportIds:async()=>[],readLegacyProfile:async()=>legacy})
  const network=await createAccountNetwork({owner,getBackend}).readNetwork()
  assert.equal(network.legacyProfileId,'first');assert.equal(network.assertions.length,1);assert.equal(network.assertions[0].ownerId,'owner');assert.equal(network.assertions[0].fields.company,'Old Company');assert.deepEqual(network.assertions[0].provenance,{source:'recovered-legacy-public-v1',revision:legacy.revision,fromId:'first',toId:'second'})
  await assert.rejects(createAccountNetwork({owner,getBackend:async()=>({listImportIds:async()=>[],readLegacyProfile:async()=>++calls===1?legacy:null})}).readNetwork(),/legacy_network_changed/)
})
