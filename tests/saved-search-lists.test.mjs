import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createMemorySavedSearchLists } from '../mcp-server/saved-search-lists.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
const alice={ownerId:'alice',userId:'alice-user'},bob={ownerId:'bob',userId:'bob-user'}
test('saved lists isolate owners and share tokens rotate/revoke',async()=>{
 const store=createMemorySavedSearchLists()
 const row=await store.create(alice,{name:'Selected people',queryUrl:'/network?q=private+query',refs:['public:first','contact:private']})
 assert.equal(await store.get(bob,row.id),null);assert.deepEqual(await store.list(bob),[])
 await store.remove(bob,row.id);assert.ok(await store.get(alice,row.id))
 const shared=await store.share(alice,row.id,['first']);assert.ok(await store.shared(shared.shareToken))
 const rotated=await store.share(alice,row.id,['first']);assert.equal(await store.shared(shared.shareToken),null)
 await store.share(alice,row.id,[]);assert.equal(await store.shared(rotated.shareToken),null)
 await store.removeOwner(alice);assert.deepEqual(await store.list(alice),[])
})
test('HTTP save/select/share/revoke survives handlers, revalidates publication and hides query',async t=>{
 const store=createMemorySavedSearchLists();let hidden=false,handler
 const profile=id=>({id,name:id,positions:[],education:[],skills:[]})
 const options={savedSearchLists:store,networkFreshMs:0,login:{begin:async()=>({location:'https://identity.invalid',transaction:{state:'test'}}),finish:async url=>({issuer:'https://identity.invalid',subject:url.searchParams.get('code')})},resolveOwner:async identity=>identity.subject==='bob'?bob:alice,signup:async()=>alice,issueAccountGrant:async()=>({}),revokeAccountGrant:async()=>{},readPublishedSnapshot:async()=>({state:'published',complete:true,revision:hidden?'v2':'v1',profiles:[profile('first'),profile('second')],connections:[{fromId:'first',toId:'second'}],...(hidden?{unlisted:[{id:'first'}]}:{})}),ownProfileId:async()=>null,getBackend:async()=>({adapter:{},readResource:async()=>null,listImportIds:async()=>[],listImportJobIds:async()=>[]})}
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const endpoint=`http://127.0.0.1:${server.address().port}`,baseUrl=endpoint.replace('http:','https:')
 handler=createPrivateBrowserHandler({...options,baseUrl})
 const get=(path,cookie)=>fetch(endpoint+path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}})
 const login=async who=>{const start=await get('/login'),loginCookie=start.headers.getSetCookie()[0].split(';')[0];const callback=await get('/auth/callback/ideaflow?state=test&code='+who,loginCookie);return callback.headers.getSetCookie().find(c=>c.startsWith('__Host-ul-session=')).split(';')[0]}
 const cookie=await login('alice'),other=await login('bob')
 const page=await(await get('/network?q=first&company=',cookie)).text(),csrf=page.match(/name="csrf" value="([^"]+)"/)?.[1]
 assert.ok(csrf,page.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g,''))
 assert.match(page,/id="save-results"/);assert.match(page,/form="save-results" name="refs" value="public:first"/)
 const post=(path,fields,c=cookie)=>fetch(endpoint+path,{method:'POST',redirect:'manual',headers:{Cookie:c,'Content-Type':'application/x-www-form-urlencoded',Origin:baseUrl},body:new URLSearchParams(fields)})
 assert.equal((await post('/lists',{csrf:'wrong',name:'List',queryUrl:'/network',refs:'public:first'})).status,400)
 assert.equal((await post('/lists',{csrf,name:'List',queryUrl:'https://evil.invalid',refs:'public:first'})).status,400)
 assert.equal((await post('/lists',{csrf,name:'List',queryUrl:'/network',refs:'contact:foreign'})).status,400)
 const saved=await post('/lists',{csrf,name:'Selected list',queryUrl:'/network?q=private-secret',refs:'public:first'})
 assert.equal(saved.status,303);const path=saved.headers.get('location')
 assert.equal((await get(path,other)).status,404)
 assert.match(await(await get(path,cookie)).text(),/private-secret/)
 assert.equal((await post(path+'/share',{csrf})).status,303)
 const row=(await store.list(alice))[0],share='/lists/shared/'+row.shareToken
 let response=await get(share);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/)
 const body=await response.text();assert.match(body,/href="\/people\/first"/);assert.doesNotMatch(body,/private-secret|contact:foreign/)
 hidden=true
 // Suspension/removal is checked afresh, never a frozen public copy.
 options.readPublishedSnapshot=async()=>({state:'published',complete:true,revision:'v3',profiles:[profile('second')],connections:[]})
 handler=createPrivateBrowserHandler({...options,baseUrl})
 response=await get(share);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/href="\/people\/first"/)
 await store.share(alice,row.id,[]);assert.equal((await get(share)).status,404)
})

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const graphEnabled = /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri ?? '') && process.env.UNLINKED_TEST_NEO4J_DRIVER
test('durable lists survive store recreation, isolate owners and retire public links', { skip: !graphEnabled }, async t => {
 const { createRequire } = await import('node:module'), { randomUUID } = await import('node:crypto')
 const { createNeo4jSavedSearchLists } = await import('../mcp-server/saved-search-lists.mjs')
 const neo = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
 const driver = neo.driver(uri,neo.auth.basic('neo4j',process.env.UNLINKED_TEST_NEO4J_PASSWORD))
 const owner={ownerId:'list-fixture-'+randomUUID(),userId:'list-fixture-user'}, stranger={ownerId:'list-stranger',userId:'list-stranger-user'}
 const run=async(query,params)=>{const session=driver.session();try{return await session.run(query,params)}finally{await session.close()}}
 t.after(async()=>{await run('MATCH (n) WHERE (n:UnlinkedSavedSearchList AND n.ownerId=$ownerId) OR (n:OperationalOwner AND n.sourceOwnerId=$ownerId) DETACH DELETE n',owner);await driver.close()})
 await run("CREATE (:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId,active:true})",owner)
 const store=createNeo4jSavedSearchLists(driver);await store.initialize()
 const row=await store.create(owner,{name:'Durable selected set',queryUrl:'/network?degree=2',refs:['public:fixture-profile']})
 const fresh=createNeo4jSavedSearchLists(driver);assert.equal((await fresh.get(owner,row.id)).name,row.name);assert.equal(await fresh.get(stranger,row.id),null)
 const first=await fresh.share(owner,row.id,['fixture-profile']);assert.ok(await store.shared(first.shareToken))
 const second=await store.share(owner,row.id,['fixture-profile']);assert.equal(await fresh.shared(first.shareToken),null)
 await run("MATCH (o:OperationalOwner {sourceOwnerId:$ownerId}) SET o.active=false",owner);assert.equal(await fresh.shared(second.shareToken),null)
 await run("MATCH (o:OperationalOwner {sourceOwnerId:$ownerId}) SET o.active=true",owner)
 await fresh.share(owner,row.id,[]);assert.equal(await store.shared(second.shareToken),null)
 await fresh.removeOwner(owner);assert.deepEqual(await store.list(owner),[])
})

// Run alongside the durable saved-search test in hosted graph CI. This
// exercises the group ACL and its existing list source in the same graph.
test('durable group ACL shares a saved result and serializes competing accepts', { skip: !graphEnabled }, async t => {
 const { createRequire } = await import('node:module'), { randomUUID } = await import('node:crypto')
 const { createNeo4jSavedSearchLists } = await import('../mcp-server/saved-search-lists.mjs')
 const { createNeo4jCollectiveGroupsStore } = await import('../mcp-server/collective-groups-store.mjs')
 const { createCollectiveGroups } = await import('../mcp-server/collective-groups.mjs')
 const { createCollectiveListProjection } = await import('../mcp-server/collective-group-lists.mjs')
 const neo = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
 const driver = neo.driver(uri, neo.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
 t.after(() => driver.close())
 const listStore = createNeo4jSavedSearchLists(driver), groupStore = createNeo4jCollectiveGroupsStore(driver)
 await listStore.initialize()
 await groupStore.initialize()
 const fixture = () => ({ ownerId: 'group-fixture-' + randomUUID(), userId: 'group-fixture-user' })
 const organizer = fixture(), invitee = fixture()
 const create = () => createCollectiveGroups({ store: createNeo4jCollectiveGroupsStore(driver), active: () => true })
 const a = create(), b = create(), group = await a.create(organizer, 'Durable group')
 const projection = createCollectiveListProjection({ savedSearchLists: listStore,
   lookup: async ids => new Map(ids.map(id => [id, { id, name: 'Public person' }])) })
 try {
   const invite = await a.invite(organizer, group.id, invitee, { id: 'public-fixture-member', name: 'Fixture member' })
   assert.equal((await b.directory(invitee)).invites[0].id, invite)
   const results = await Promise.allSettled([a.respond(invitee, group.id, invite, 'accept'), b.respond(invitee, group.id, invite, 'accept')])
   assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'])
   assert.equal(results.find(result => result.status === 'rejected').reason.code, 'not_found')
   assert.equal((await a.detail(organizer, group.id)).members.length, 1)
   const list = await listStore.create(organizer, { name: 'One list', queryUrl: '/network?q=private', refs: ['public:fixture-profile', 'contact:private'] })
   const selection = await projection.preview(organizer, group.id, 'saved:' + list.id)
   const share = await a.share(organizer, group.id, selection)
   assert.deepEqual((await b.readShare(invitee, group.id, share.id, projection.project)).profiles.map(profile => profile.id), ['fixture-profile'])
   await a.revoke(organizer, group.id, 'member', invite)
   await assert.rejects(b.readShare(invitee, group.id, share.id, projection.project), { code: 'not_found' })
   const flyer = await a.createFlyer(organizer, group.id, { capacity: 3, approval: false })
   const first = fixture(), second = fixture(), excess = fixture()
   assert.deepEqual(await b.previewFlyer(group.id, flyer.id), { title: 'Durable group' })
   assert.equal((await a.detail(organizer, group.id)).members.length, 0)
   const joining = actor => b.joinFlyer(actor, group.id, flyer.id, { profileId: null, name: 'Fixture founder', source: { utm_content: 'yc_fall_2026_collective_v2' } })
   const accepted = await Promise.all([joining(first), joining(second), joining(first)])
   assert.deepEqual(accepted, ['member', 'member', 'member'])
   assert.equal((await a.detail(organizer, group.id)).members.length, 2)
   await assert.rejects(joining(excess), { code: 'group_full' })
   await a.revokeFlyer(organizer, group.id, flyer.id)
   await assert.rejects(b.previewFlyer(group.id, flyer.id), { code: 'not_found' })
   await assert.rejects(joining(excess), { code: 'not_found' })
 } finally {
   await a.removeOwner(organizer)
   await listStore.removeOwner(organizer)
 }
})
