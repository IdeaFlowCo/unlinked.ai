import { createMemorySessionStore } from '../mcp-server/session-store.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createBulkExports } from '../mcp-server/bulk-exports.mjs'
import { renderPeople,renderPrivateList,renderSavedSearchList } from '../mcp-server/private-onboarding-views.mjs'

test('ordinary signed-in owners get a complete CSV and format/detail controls; public bulk access stays verified-only',async t=>{
 let handler
 const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const endpoint=`http://127.0.0.1:${server.address().port}`,baseUrl=endpoint.replace('http:','https:'),owner={ownerId:'owner',userId:'user'}
 const people=Array.from({length:123},(_,i)=>({id:'person-'+i,name:'Person '+i,headline:'Role'}))
 const backend={adapter:{},readResource:async()=>null,listImportIds:async()=>[],listAccountGrantIds:async()=>[],readLegacyProfile:async()=>({profileId:'self',sourceSha256:'a'.repeat(64),receiptId:'receipt',revision:'v1',profile:{id:'self',name:'Owner'},profiles:people,connections:people.map(row=>({fromId:'self',toId:row.id}))})}
 const getBackend=async bound=>{assert.deepEqual(bound,owner);return backend},isVerified=async()=>false
 const sessionStore=createMemorySessionStore(),originalGet=sessionStore.get.bind(sessionStore);let reads=0,revokeAt=Infinity
 sessionStore.get=async(...args)=>++reads>=revokeAt?null:originalGet(...args)
 const bulkExports=createBulkExports({getBackend,isVerified})
 handler=createPrivateBrowserHandler({baseUrl,bulkExports,sessionStore,isVerified,getBackend,resolveOwner:async()=>owner,signup:async()=>owner,issueAccountGrant:async()=> 'synthetic',revokeAccountGrant:async()=>{},login:{begin:async()=>({location:'https://identity.invalid/start',transaction:{state:'state'}}),finish:async()=>({issuer:'https://identity.invalid',subject:'subject'})}})
 assert.equal((await fetch(endpoint+'/downloads/file')).status,401)
 const start=await fetch(endpoint+'/login',{redirect:'manual'}),callback=await fetch(endpoint+'/auth/callback/ideaflow?code=synthetic&state=state',{redirect:'manual',headers:{Cookie:start.headers.get('set-cookie').split(';')[0]}})
 const cookie=callback.headers.getSetCookie().find(value=>value.startsWith('__Host-ul-session=')).split(';')[0],headers={Cookie:cookie}
 const page=await fetch(endpoint+'/downloads?scope=mine',{headers});assert.equal(page.status,200);const html=await page.text();assert.match(html,/<title>Download my network · Unlinked<\/title>/);assert.match(html,/All matching people are included/);assert.match(html,/id="download-format"/);assert.match(html,/id="download-detail"/)
 const file=await fetch(endpoint+'/downloads/file?scope=mine&format=csv&detail=headline',{headers});assert.equal(file.status,200);assert.match(file.headers.get('content-type'),/text\/csv/);assert.equal((await file.text()).split('\r\n').length,125)
 assert.equal((await fetch(endpoint+'/downloads/file?scope=everyone',{headers})).status,403)
 reads=0;revokeAt=4
 await assert.rejects(async()=>{const interrupted=await fetch(endpoint+'/downloads/file?scope=mine&format=json',{headers});await interrupted.text()},'a session removed during streaming must not complete the attachment')
})
test('network and owned list actions carry the whole selection, query and structured filters; shared lists expose no private download',()=>{
 const network=renderPeople({csrf:'csrf',query:'Engineer',mode:'exact',filters:{company:'Example'},connectedView:{rows:[],total:123}}).content
 const href=network.match(/href="([^"<>]*\/downloads\?[^"<>]*)"/)[1].replaceAll('&amp;','&'),url=new URL(href,'https://www.unlinked.ai')
 assert.equal(url.searchParams.get('scope'),'mine');assert.equal(url.searchParams.get('q'),'Engineer');assert.equal(url.searchParams.get('company'),'Example');assert.equal(url.searchParams.has('cursor'),false)
 const list=renderPrivateList({csrf:'csrf',list:{id:'private-list',name:'My list'},query:'Example',members:[]}).content
 assert.match(list,/Search this whole list/);assert.match(list,/Download all matches/)
 const saved={id:'a'.repeat(8)+'-'+ 'b'.repeat(4)+'-'+ 'c'.repeat(4)+'-'+ 'd'.repeat(4)+'-'+ 'e'.repeat(12),name:'Saved',queryUrl:'/network',refs:[]}
 assert.match(renderSavedSearchList({csrf:'csrf',saved,people:[]}).content,/Download whole list/)
 assert.doesNotMatch(renderSavedSearchList({csrf:'csrf',saved,people:[],shared:true}).content,/Download whole list/)
})
