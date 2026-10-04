import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

test('canonical anonymous discovery GET/HEAD works while owner and mutation routes remain protected', async t => {
  let handler, ownerReads = 0
  const server = createServer((req,res)=>handler(req,res))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  handler=createPrivateBrowserHandler({baseUrl:`https://127.0.0.1:${server.address().port}`,login:{begin:async()=>{},finish:async()=>{}},resolveOwner:async()=>null,getBackend:async()=>{ownerReads++;throw Error('unexpected_owner_read')}})
  for(const path of ['/agents','/llms.txt','/robots.txt','/sitemap.xml','/.well-known/security.txt','/AGENTS.md','/openapi.json','/.well-known/agent.json','/.well-known/unlinked.json','/.well-known/mcp/server-card.json','/meet','/import-linkedin','/public-assets/openchat-card.js','/public-assets/unlinked-card.js','/public-assets/meet-scan.js','/public-assets/browser-card-scanner.js','/public-assets/jsqr.js','/public-assets/jsqr-module.mjs','/manifest.webmanifest','/sw.js','/offline.html','/app-icon-192.png','/app-icon-512.png','/app-icon-maskable-512.png']) {
    const get=await fetch(endpoint+path);assert.equal(get.status,200,path);assert.ok((await get.text()).length)
    const head=await fetch(endpoint+path,{method:'HEAD'});assert.equal(head.status,200,path);assert.equal(await head.text(),'')
  }
  assert.equal(ownerReads,0)
  assert.equal((await fetch(endpoint+'/network')).status,503) // Public source unavailable; never private fallback.
  for(const path of ['/profile','/settings','/imports/'+'a'.repeat(64)+'/status','/public-assets/runtime.env']) assert.equal((await fetch(endpoint+path)).status,401,path)
  assert.equal((await fetch(endpoint+'/agents',{method:'POST',headers:{Origin:`https://127.0.0.1:${server.address().port}`}})).status,401)
  assert.equal((await fetch(endpoint+'/agents',{method:'POST',headers:{Origin:'https://wrong.invalid'}})).status,403)
  assert.equal((await fetch(endpoint+'/network',{method:'HEAD'})).status,503) // Same unavailable public source as GET.
  assert.equal(await new Promise((resolve,reject)=>{const req=httpRequest(endpoint+'/meet',{headers:{Host:'wrong.invalid'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()}),403)
  const card=await(await fetch(endpoint+'/.well-known/mcp/server-card.json')).json();assert.equal(card.transports['streamable-http'].url,'https://www.unlinked.ai/mcp');assert.deepEqual(card.tools.map(t=>t.name),['unlinked_search_network','unlinked_search_everyone','unlinked_whoami','unlinked_list_people','unlinked_list_connections','unlinked_get_profile','unlinked_ai_search','unlinked_list_connection_requests','unlinked_list_notifications','unlinked_send_connection_request','unlinked_accept_connection_request','unlinked_ignore_connection_request','unlinked_withdraw_connection_request'])
  const meet=await fetch(endpoint+'/meet');assert.match(meet.headers.get('content-security-policy'),/script-src 'self' 'nonce-/)
  const meetHtml=await meet.text()
  // Scans classify through one validator and always stop at a visible confirm step.
  assert.match(meetHtml,/classifyMeetCode/)
  assert.match(meetHtml,/id="confirm-open"/)
  assert.match(meetHtml,/id="confirm-cancel"/)
  assert.doesNotMatch(meetHtml,/location\.assign/)
  const scanner=await(await fetch(endpoint+'/public-assets/browser-card-scanner.js')).text();assert.match(scanner,/from '\/public-assets\/jsqr-module.mjs'/)
})
