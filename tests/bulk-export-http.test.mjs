import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createBulkExports } from '../mcp-server/bulk-exports.mjs'
import { createBulkExportHttp } from '../mcp-server/bulk-export-http.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { accountGrantTools,CURRENT_ACCOUNT_GRANT_VERSION,scopeCoversPublic,scopeAllowsPrivateNotes } from '../mcp-server/account-grants.mjs'

test('one authenticated HTTP request downloads all rows, while REST queries return complete data or permission errors',async t=>{
 let handler
 const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const endpoint=`http://127.0.0.1:${server.address().port}`,origin=endpoint.replace('http:','https:')
 const owner={ownerId:'owner',userId:'user'},scope='owner_network_and_public_and_private_notes'
 const grant={...owner,grantId:'grant',scope,version:CURRENT_ACCOUNT_GRANT_VERSION,tools:[...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION,scope)]}
 const authenticateGrant=async req=>req.headers.authorization==='Bearer synthetic'?grant:null
 const getBackend=async bound=>{assert.equal(bound.ownerId,owner.ownerId);return {listImportIds:async()=>[],readResource:async()=>null}}
 const exports=createBulkExports({getBackend,isVerified:async()=>true,readPublishedSnapshot:async()=>({state:'published',complete:true,revision:'http-export',profiles:Array.from({length:245},(_,i)=>({id:'person-'+i,name:'Person '+i,positions:[],education:[],skills:[]})),connections:[]})})
 const service=createAccountToolService({getBackend,exportManifest:(g,input,signal)=>exports.manifest(g,input,{publicAllowed:scopeCoversPublic(g.scope),privateAllowed:scopeAllowsPrivateNotes(g.scope)},signal)})
 const download=createBulkExportHttp({origin,authenticateGrant,exports,service}),api=createAccountAgentApiHandler({origin,authenticateGrant,authenticateGrantDetailed:async req=>({grant:await authenticateGrant(req)}),service})
 handler=(req,res)=>new URL(req.url,origin).pathname==='/api/agent/v1/export'?download(req,res):api(req,res)
 assert.equal((await fetch(endpoint+'/api/agent/v1/export?scope=everyone')).status,401)
 const headers={Authorization:'Bearer synthetic'}
 const file=await fetch(endpoint+'/api/agent/v1/export?scope=everyone&format=json&detail=headline',{headers});assert.equal(file.status,200);const data=await file.json();assert.equal(data.complete,true);assert.equal(data.count,245);assert.equal(data.rows.length,245)
 const query=await fetch(endpoint+'/api/agent/v1/exports',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({scope:'everyone',query:'Person',inline:true,fields:['name']})});assert.equal(query.status,200);const result=await query.json();assert.equal(result.complete,true);assert.equal(result.total,245)
 const bad=await fetch(endpoint+'/api/agent/v1/export?ownerId=another',{headers});assert.equal(bad.status,400)
 const untrusted=await fetch(endpoint+'/api/agent/v1/export?scope=everyone',{headers:{...headers,Origin:'https://other.invalid'}});assert.equal(untrusted.status,403)
})
