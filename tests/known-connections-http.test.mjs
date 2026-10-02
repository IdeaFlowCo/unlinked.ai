import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {createAccountHostedHandler} from '../mcp-server/account-hosted.mjs'
import {createPrivateBrowserHandler} from '../mcp-server/private-browser.mjs'
const require=createRequire(new URL('../mcp-server/package.json',import.meta.url))
const {Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const {StreamableHTTPClientTransport}=await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const owner={ownerId:'synthetic-known-owner',userId:'synthetic-known-user'}
const anchor={profileId:'a',receiptId:'confirmed-link',revision:'source-v1'}
const snapshot={state:'published',complete:true,revision:'public-v1',profiles:['a','b','c','other'].map(id=>({id,name:'Person '+id,headline:'Engineer',positions:[],education:[],skills:[],email:'private@example.invalid'})),connections:[{fromId:'a',toId:'b'},{fromId:'b',toId:'c'},{fromId:'other',toId:'a'}]}

test('real MCP SDK routes natural degree query through signed owner anchor and denies mid-read grant revocation',async t=>{
 let active=true,linked=true,revokeOnRead=false,reads=0,models=0,handler
 const grant={...owner,grantId:'synthetic-grant',scope:'owner_network',tools:['unlinked_search_network']}
 const server=createServer((req,res)=>void handler(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const endpoint=`http://127.0.0.1:${server.address().port}`,origin=endpoint.replace('http:','https:')
 handler=createAccountHostedHandler({origin,authenticateGrant:async req=>active&&req.headers.authorization==='Bearer synthetic-token'?grant:null,
 getBackend:async actual=>{assert.equal(actual.ownerId,owner.ownerId);assert.equal(actual.userId,owner.userId);return{readLegacyProfile:async()=>linked?anchor:null}},
 readPublishedSnapshot:async()=>{reads++;if(revokeOnRead)active=false;return snapshot},complete:async()=>{models++;throw Error('should not call model for recorded paths')}})
 const client=new Client({name:'known-connections-proof',version:'1.0'})
 try{await client.connect(new StreamableHTTPClientTransport(new URL(endpoint+'/mcp'),{requestInit:{headers:{Authorization:'Bearer synthetic-token'}}}))
 const result=await client.callTool({name:'unlinked_search_network',arguments:{query:'my second-degree connections'}})
 assert.ok(!result.isError);const value=JSON.parse(result.content[0].text);assert.equal(value.degree,2);assert.deepEqual(value.profiles.map(p=>p.id),['c']);assert.deepEqual(value.paths,[{fromId:'a',viaId:'b',toId:'c'}]);assert.ok(!JSON.stringify(value).includes('private@example'));assert.equal(models,0)
 linked=false;assert.equal((await client.callTool({name:'unlinked_search_network',arguments:{query:'Engineer',degree:1}})).isError,true)
 linked=true;revokeOnRead=true;assert.equal((await client.callTool({name:'unlinked_search_network',arguments:{query:'Engineer',degree:2}})).isError,true);assert.ok(reads>=2)
 await assert.rejects(client.callTool({name:'unlinked_search_network',arguments:{query:'Engineer',degree:2}}))
 }finally{await client.close()}
})

test('signed HTTP connection reads use server owner only, unknown binding denied and anonymous remains private',async t=>{
 let handler,linked=true,secondOwner=false
 const server=createServer((req,res)=>void handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const endpoint=`http://127.0.0.1:${server.address().port}`,baseUrl=endpoint.replace('http:','https:')
 handler=createPrivateBrowserHandler({baseUrl,login:{begin:async()=>({location:'https://idp.invalid/login',transaction:{state:'state'}}),finish:async()=>({issuer:'https://idp.invalid',subject:secondOwner?'subject-b':'subject-a'})},resolveOwner:async identity=>identity.subject==='subject-a'?owner:{ownerId:'owner-b',userId:'user-b'},
 getBackend:async actual=>({readLegacyProfile:async()=>actual.ownerId===owner.ownerId&&linked?anchor:null}),readPublishedSnapshot:async()=>snapshot})
 const request=(path,options={})=>fetch(endpoint+path,{redirect:'manual',...options})
 assert.equal((await request('/api/my-connections?degree=2')).status,401)
 const signIn=async()=>{const start=await request('/login');const callback=await request('/auth/callback/ideaflow?code=test&state=state',{headers:{Cookie:start.headers.getSetCookie()[0].split(';')[0]}});assert.equal(callback.status,303);return callback.headers.getSetCookie().find(x=>x.startsWith('__Host-ul-session=')).split(';')[0]}
 const cookie=await signIn(),signed=path=>request(path,{headers:{Cookie:cookie}})
 const response=await signed('/api/my-connections?degree=2&q=Engineer');assert.equal(response.status,200);assert.deepEqual((await response.json()).profiles.map(p=>p.id),['c'])
 assert.equal((await signed('/api/my-connections?degree=2&ownerId=owner-b')).status,400)
 assert.equal((await signed('/api/my-connections?degree=2&degree=1')).status,400)
 assert.equal((await signed('/api/my-connections?cursor=wrong')).status,400)
 linked=false;assert.equal((await signed('/api/my-connections?degree=2')).status,409)
 linked=true;secondOwner=true;const foreign=await signIn();assert.equal((await request('/api/my-connections?degree=2',{headers:{Cookie:foreign}})).status,409)
})
