import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySavedSearchLists } from '../mcp-server/saved-search-lists.mjs'
import { createCollectiveGroups, GROUP_LIMITS } from '../mcp-server/collective-groups.mjs'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'

const account = id => ({ ownerId: id, userId: id + '-user' })
const alice = account('alice'), bob = account('bob'), carol = account('carol')
const profiles = ['alice', 'bob', 'carol', 'public-a', 'public-b'].map(id => ({ id, name: id, headline: 'Public bio', positions: [], education: [], skills: [] }))
const secret = 'Private fixture contact and query'

async function browser(t, extra = {}, groupOptions = {}) {
  const store = createMemoryCollectiveGroupsStore()
  const registered = new Set(['alice', 'bob', 'carol'])
  const savedSearchLists = createMemorySavedSearchLists()
  const saved = await savedSearchLists.create(alice, { name: 'Reviewed set', queryUrl: '/network?q=private-query', refs: ['public:public-a', 'contact:private-contact'] })
  await savedSearchLists.create(alice, { name: 'Unselected set', queryUrl: '/network?q=unselected', refs: ['public:public-b'] })
  const foreign = await savedSearchLists.create(carol, { name: 'Carol private list', queryUrl: '/network', refs: ['public:public-b'] })
  let now = 1000
  const active = actor => registered.has(actor.ownerId) && actor.userId === account(actor.ownerId).userId
  const collectiveGroups = createCollectiveGroups({ store, now: () => now, active, ...groupOptions })
  let exchanges = 0
  const options = { ...extra, collectiveGroups, savedSearchLists, networkFreshMs: 0,
    privateLists: {
      list: async owner => ({ lists: owner.ownerId === 'alice' ? [{ id: 'fixture-graph-list', name: 'Founder introductions' }] : [] }),
      get: async (owner, id) => {
        if (owner.ownerId !== 'alice' || id !== 'fixture-graph-list') throw Object.assign(Error('not_found'), { code: 'not_found' })
        return { list: { name: 'Founder introductions', description: secret }, members: [{ profileId: 'public-a', name: secret }, { name: secret }] }
      },
    },
    login: { begin: async () => ({ location: 'https://identity.invalid', transaction: { state: 'test' } }), finish: async url => { exchanges++; return { issuer: 'https://identity.invalid', subject: url.searchParams.get('code') } } },
    resolveOwner: async identity => registered.has(identity.subject) ? account(identity.subject) : null,
    signup: async identity => { registered.add(identity.subject); return account(identity.subject) },
    issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    selfClaims: { lookupSlug: async () => null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    readPublishedSnapshot: extra.readPublishedSnapshot ?? (async () => ({ state: 'published', complete: true, revision: 'v1', profiles, connections: [] })),
    ownProfileId: async owner => owner.ownerId,
    accountForProfile: async id => ['alice', 'bob', 'carol'].includes(id) ? account(id) : null,
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [] }),
  }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ ...options, baseUrl })
  const get = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const post = (path, cookie, fields, origin = baseUrl) => fetch(endpoint + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const login = async (who, next) => {
    const start = await get(next ? '/login?next=' + encodeURIComponent(next) : '/login')
    const loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await get('/auth/callback/ideaflow?state=test&code=' + who, loginCookie)
    const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
    const csrf = token(await (await get('/groups', cookie)).text())
    return { cookie, csrf, destination: callback.headers.get('location') }
  }
  return { get, post, login, saved, foreign, store, groups: collectiveGroups, expire: () => { now += GROUP_LIMITS.inviteMs },
    restart: () => { handler = createPrivateBrowserHandler({ ...options, baseUrl }) },
    exchanges: () => exchanges,
  }
}
const token = html => html.match(/name="csrf" value="([^"]+)"/)?.[1]
import { draftContext, createCommunityIntakeClient, identityKey } from '../mcp-server/community-intake.mjs'

test('bounded local drafts preserve tasks and support quoted Goodreads CSV and assistant JSON',()=>{
 const draft=draftContext('Call accountant\nI need help finding a cofounder\nI can help with Postgres','tasks')
 assert.deepEqual(draft.map(r=>r.kind),['note','ask','offer'])
 assert.deepEqual(draft.map(r=>r.selected),[false,true,true])
 assert.equal(draftContext('Title,Author\n"Thinking, Fast and Slow",Daniel Kahneman','bookshelf')[0].title,'Thinking, Fast and Slow — Daniel Kahneman')
 assert.deepEqual(draftContext(JSON.stringify({asks:['A CTO intro'],tasks:['Send invoices'],about:'I build tools'}),'assistant').map(r=>r.kind),['note','ask','note'])
 assert.throws(()=>draftContext('x'.repeat(20001),'tasks'))
 assert.throws(()=>draftContext(JSON.stringify([{kind:'admin',title:'bad'}]),'assistant'))
})
test('shared client binds every call to persisted identity and filters group results',async()=>{
 const calls=[]
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId}),fetchImpl:async(url,opts)=>{calls.push({url,...opts,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({entries:[]})}}})
 await client.save(alice,{issuer:'evil',subject:'other',requestId:'fixture',entries:[]})
 assert.equal(calls[0].body.subject,alice.userId)
 assert.equal(calls[0].body.issuer,'https://id.ideaflow.app/api/auth')
 assert.equal(calls[0].redirect,'error')
 assert.equal(createCommunityIntakeClient({secret:'short'}),null)
})
test('unverified identities fail closed before any Social partner request',async()=>{
 let requests=0
 for(const identity of [null,{issuer:'https://untrusted.invalid',subject:'alice-user'},{issuer:'https://id.ideaflow.app/api/auth',subject:''}]) {
  const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async()=>identity,fetchImpl:async()=>{requests++;throw Error('must not reach Social')}})
  for(const call of [()=>client.list(alice),()=>client.save(alice,{entries:[]}),()=>client.update(alice,{id:1}),()=>client.group(alice,randomUUID(),[])])
   await assert.rejects(call,/verified Ideaflow identity is unavailable/)
 }
 assert.equal(requests,0)
})
test('partner conflicts map known attached-content errors without exposing upstream details',async()=>{
 const stale='This entry changed. Reload it before saving again.'
 const unavailable='Your Ideaflow profile could not be reached. Nothing new was confirmed saved; retry this same review to recover a completed save.'
 const attached='This entry has attached content. Manage its audience and attached content in Social before changing its sharing here.'
 const privateDetail='Private upstream detail https://untrusted.invalid/private'
 for(const [status,body,message] of [
  [409,JSON.stringify({error:'entry_has_children'}),attached],
  [409,JSON.stringify({error:'entry_has_children',message:privateDetail,url:'https://untrusted.invalid/private'}),attached],
  [409,JSON.stringify({error:'entry_visibility_conflict',message:privateDetail,url:'https://untrusted.invalid/private'}),'Review this entry’s visibility in Social before editing it through Unlinked. Open My asks and offers to find its Social link.'],
  [409,JSON.stringify({error:'entry_changed'}),stale],
  [409,JSON.stringify({error:'request_changed'}),stale],
  [409,JSON.stringify({error:privateDetail}),stale],
  [409,JSON.stringify({error:{code:'entry_has_children',message:privateDetail}}),stale],
  [409,'null',stale],
  [409,privateDetail,stale],
  [500,JSON.stringify({error:'entry_has_children',message:privateDetail}),unavailable],
 ]) {
  const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async()=>({issuer:'https://id.ideaflow.app/api/auth',subject:alice.userId}),fetchImpl:async()=>new Response(body,{status,headers:{'content-type':'application/json'}})})
  await assert.rejects(()=>client.update(alice,{id:7,revision:'a'.repeat(64),entry:{title:'Need a collaborator',body:'',kind:'ask',source:'manual',audience:'only_me'},status:'open'}),{message})
 }
})
test('one flyer signup reaches introduction, review saves only selections and group removal revokes read access',async t=>{
 const saved=[]
 const client={list:async()=>({entries:saved}),save:async(owner,body)=>{saved.push(...body.entries.map((e,i)=>({...e,id:i+1,name:'Member',status:'open',revision:1})));return {entries:saved}},group:async()=>({entries:saved}),update:async()=>{}}
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice')
 const created=await b.post('/groups',owner.cookie,{csrf:owner.csrf,name:'Boulder Tech Builders'})
 const groupPath=created.headers.get('location')
 await b.post(groupPath+'/flyer',owner.cookie,{csrf:owner.csrf,capacity:'100',mode:'join'})
 const record=await b.store.get(groupPath.split('/').pop()),invite=groupPath+'/join/'+record.flyer.id
 const member=await b.login('new-builder',invite)
 assert.equal(member.destination,invite)
 const joined=await b.post(invite,member.cookie,{csrf:member.csrf,decision:'join'})
 assert.equal(joined.headers.get('location'),groupPath+'/welcome')
 const welcome=await b.get(groupPath+'/welcome',member.cookie)
 assert.equal(welcome.status,200);assert.match(await welcome.text(),/Boulder Tech Builders/)
 const preview=await b.post(groupPath+'/welcome/preview',member.cookie,{csrf:member.csrf,source:'tasks',text:'Email my accountant\nI need help with Postgres'})
 assert.equal(preview.status,200)
 const content=await preview.text(),requestId=content.match(/name="requestId" value="([^"]+)"/)[1]
 const fields={csrf:member.csrf,requestId,count:'2',selected:'1','title-0':'Email my accountant','body-0':'','kind-0':'note','source-0':'tasks','audience-0':'only_me','title-1':'I need help with Postgres','body-1':'','kind-1':'ask','source-1':'tasks','audience-1':'group'}
 assert.equal((await b.post(groupPath+'/welcome/save',member.cookie,{...fields,csrf:'wrong'})).status,400)
 assert.equal(saved.length,0)
 assert.equal((await b.post(groupPath+'/welcome/save',member.cookie,fields,'https://evil.invalid')).status,403)
 const result=await b.post(groupPath+'/welcome/save',member.cookie,fields)
 assert.equal(result.status,303);assert.equal(saved.length,1);assert.equal(saved[0].title,'I need help with Postgres')
 assert.equal(saved[0].groupId,record.id)
 const shown=await b.get(groupPath+'/community',member.cookie);assert.equal(shown.status,200);assert.match(await shown.text(),/I need help with Postgres/)
 assert.match(shown.headers.get('cache-control'),/no-store/)
 const after=await b.store.get(record.id),seat=after.members.find(m=>m.actor.ownerId==='new-builder')
 await b.post(groupPath+'/members/'+seat.id+'/remove',owner.cookie,{csrf:owner.csrf})
 assert.notEqual((await b.get(groupPath+'/community',member.cookie)).status,200)
})
test('a saved private entry can be shared later only into a current community',async t=>{
 const updates=[],entry={id:7,title:'Need a collaborator',body:'',kind:'ask',source:'manual',audience:'only_me',status:'open',revision:'a'.repeat(64)};
 const client={list:async()=>({entries:[entry]}),update:async(actor,data)=>updates.push(data)};
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice');
 const created=await b.post('/groups',owner.cookie,{csrf:owner.csrf,name:'Boulder Tech Builders'}),id=created.headers.get('location').split('/').pop();
 const page=await b.get('/asks/7',owner.cookie);assert.equal(page.status,200);assert.match(await page.text(),/Boulder Tech Builders/);
 const form={csrf:owner.csrf,revision:entry.revision,count:'1',selected:'0','title-0':entry.title,'body-0':'','kind-0':'ask','source-0':'manual','audience-0':'group',groupId:id,status:'open'};
 assert.equal((await b.post('/asks/7',owner.cookie,{...form,groupId:randomUUID()})).status,400);assert.equal(updates.length,0);
 assert.equal((await b.post('/asks/7',owner.cookie,form)).status,303);assert.equal(updates[0].entry.groupId,id);assert.equal(updates[0].revision,entry.revision);
});

const decodeForm = value => value.replace(/&(amp|quot|#39|lt|gt);/g, (_, key) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' })[key])
function htmlForm(html, action = /^\/asks\/\d+$/) {
 const form=[...html.matchAll(/<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/g)].find(row=>typeof action==='string'?row[1]===action:action.test(row[1]))?.[2]
 assert.ok(form,'entry edit form is present')
 const fields=new URLSearchParams()
 for(const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
  const name=tag.match(/name="([^"]*)"/)?.[1],value=tag.match(/value="([^"]*)"/)?.[1]||''
  if(name&&(!/type="checkbox"/.test(tag)||/ checked(?:>|\s)/.test(tag)))fields.append(name,decodeForm(value))
 }
 for(const [,name,value] of form.matchAll(/<textarea name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g))fields.set(name,decodeForm(value))
 for(const [,name,content] of form.matchAll(/<select name="([^"]*)">([\s\S]*?)<\/select>/g)) {
  const choices=[...content.matchAll(/<option value="([^"]*)"([^>]*)>/g)]
  const choice=choices.find(row=>/\bselected\b/.test(row[2]))||choices[0]
  fields.set(name,decodeForm(choice[1]))
 }
 return fields
}
const editForm = html => htmlForm(html)

function paginatedPartner(entries, onGroup = async () => {}) {
 const calls=[]
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId}),fetchImpl:async(url,opts)=>{
  const data=JSON.parse(opts.body),route=url.split('/').pop();calls.push({route,...data})
  if(route==='entry')return {ok:true,json:async()=>({entry:data.entry})}
  if(route==='group')await onGroup()
  const matching=entries.filter(e=>(!data.cursor||e.id<data.cursor)&&(route!=='group'||e.groupId===data.groupId)).sort((a,b)=>b.id-a.id)
  const page=matching.slice(0,data.limit??100)
  return {ok:true,json:async()=>({entries:page,nextCursor:matching.length>page.length?page.at(-1).id:null})}
 }})
 return {client,calls}
}
const nextPage = html => decodeForm(html.match(/<a[^>]*href="([^"]+)"[^>]*rel="next"[^>]*>/)?.[1]??'')
const intakeEntry = id => ({id,title:`Entry ${id}`,body:'',kind:'ask',source:'manual',audience:'only_me',status:'open',revision:'a'.repeat(64),ownerKey:identityKey({issuer:'https://id.ideaflow.app/api/auth',subject:alice.userId})})
async function paginationEvidence(files) {
 const dir=process.env.COMMUNITY_INTAKE_EVIDENCE_DIR
 if(!dir)return
 await mkdir(dir,{recursive:true})
 for(const [name,content] of Object.entries(files))await writeFile(join(dir,name),content)
}

test('personal pagination reaches older entries and editing targets their exact revision',async t=>{
 const entries=Array.from({length:103},(_,i)=>intakeEntry(i+1)),{client,calls}=paginatedPartner(entries)
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice')
 const first=await b.get('/asks',owner.cookie);assert.equal(first.status,200)
 const html=await first.text();assert.match(html,/Entry 103<\/h2>/);assert.doesNotMatch(html,/Entry 3<\/h2>/)
 const next=nextPage(html);assert.ok(next.startsWith('/asks?'))
 const second=await b.get(next,owner.cookie);assert.equal(second.status,200)
 const older=await second.text();assert.match(older,/Entry 3<\/h2>/);assert.match(older,/Entry 1<\/h2>/);assert.equal(nextPage(older),'')
 assert.equal(calls[1].cursor,4);assert.equal(calls[1].limit,100)
 const editing=await b.get('/asks/1',owner.cookie);assert.equal(editing.status,200)
 const editHtml=await editing.text(),edit=editForm(editHtml);assert.equal(edit.get('revision'),entries[0].revision)
 edit.set('status','done');assert.equal((await b.post('/asks/1',owner.cookie,edit)).status,303)
 assert.equal(calls.at(-1).id,1);assert.equal(calls.at(-1).status,'done')
 assert.equal(calls.at(-1).revision,entries[0].revision)
 const newest=decodeForm(older.match(/href="([^"]+)">Newest entries/)[1])
 assert.equal(newest,'/asks?limit=100')
 const returned=await b.get(newest,owner.cookie);assert.equal(returned.status,200)
 assert.match(await returned.text(),/Entry 103<\/h2>/)
 const update=calls.find(call=>call.route==='entry')
 const visibleIds=html=>[...html.matchAll(/Entry (\d+)<\/h2>/g)].map(match=>Number(match[1]))
 await paginationEvidence({'11-asks-older-page.html':older,'12-edit-oldest-entry.html':editHtml,'personal-pagination.json':JSON.stringify({fixture:'Synthetic Social partner protocol',steps:[{action:'Open My asks',visibleIds:visibleIds(html),olderLink:next},{action:'Follow Older entries',visibleIds:visibleIds(older),newestLink:newest},{action:'Edit oldest entry and mark Done',id:update.id,status:update.status,revision:update.revision}]},null,2)+'\n'})
})

test('group pagination retains cursors through filtered pages and revalidates live rosters',async t=>{
 let onGroup=async()=>{},blocked=false
 const entries=Array.from({length:5},(_,i)=>({...intakeEntry(i+1),status:i>=3?'done':'open'}))
 const {client,calls}=paginatedPartner(entries,()=>onGroup())
 const b=await browser(t,{communityIntake:client},{blocked:async(a,b)=>blocked&&[a.ownerId,b.ownerId].includes('bob')})
 const owner=await b.login('alice'),member=await b.login('bob'),group=await b.groups.create(alice,'Paged community')
 const invite=await b.groups.invite(alice,group.id,bob,profiles[1]);await b.groups.respond(bob,group.id,invite,'accept')
 entries.forEach(e=>{e.groupId=group.id;e.audience='group'})
 const path=`/groups/${group.id}/community`
 const first=await b.get(path+'?limit=2',owner.cookie);assert.equal(first.status,200)
 const html=await first.text();assert.doesNotMatch(html,/Entry [45]<\/h3>/)
 const next=nextPage(html);assert.ok(next.startsWith(path+'?'))
 const second=await b.get(next,owner.cookie);assert.equal(second.status,200)
 const older=await second.text();assert.match(older,/Entry 3<\/h3>/);assert.match(older,/Entry 2<\/h3>/)
 assert.equal(calls[1].cursor,4);assert.equal(calls[1].limit,2)
 const last=await b.get(nextPage(older),owner.cookie);assert.equal(last.status,200);assert.match(await last.text(),/Entry 1<\/h3>/)
 onGroup=async()=>{blocked=true}
 const changed=await b.get(next,owner.cookie);assert.equal(changed.status,400);assert.doesNotMatch(await changed.text(),/Entry 3/)
 blocked=false
 onGroup=async()=>{const seat=(await b.store.get(group.id)).members[0];await b.groups.revoke(alice,group.id,'member',seat.id)}
 const removed=await b.get(next,member.cookie);assert.equal(removed.status,400);assert.doesNotMatch(await removed.text(),/Entry 3/)
 await paginationEvidence({'13-community-filtered-page.html':html,'14-community-older-page.html':older,'group-pagination.json':JSON.stringify({fixture:'Synthetic Social partner protocol',firstPage:{url:path+'?limit=2',visibleEntries:[],olderLink:next},olderPage:{url:next,visibleEntries:[3,2],olderLink:nextPage(older)},blockChangeStatus:changed.status,removedViewerStatus:removed.status},null,2)+'\n'})
})

test('pagination rejects unsupported, repeated and out-of-bounds query parameters before partner reads',async t=>{
 const {client,calls}=paginatedPartner([]),b=await browser(t,{communityIntake:client}),owner=await b.login('alice')
 const group=await b.groups.create(alice,'Query fixture'),paths=['/asks',`/groups/${group.id}/community`]
 for(const path of paths) {
  const valid=await b.get(path+'?cursor=20&limit=500',owner.cookie);assert.equal(valid.status,200);await valid.text()
  assert.equal(calls.at(-1).cursor,20);assert.equal(calls.at(-1).limit,500)
  const count=calls.length
  for(const query of ['extra=1','cursor=0','cursor=-1','cursor=1.5','cursor=9007199254740992','cursor=','cursor=2&cursor=3','limit=0','limit=501','limit=2&limit=3','limit=1e2','limit=']) {
   const response=await b.get(path+'?'+query,owner.cookie);assert.equal(response.status,400,path+'?'+query);await response.text()
  }
  assert.equal(calls.length,count)
 }
 for(const path of ['/asks/1','/profile/context',`/groups/${group.id}/welcome`]) {
  const response=await b.get(path+'?cursor=20',owner.cookie);assert.equal(response.status,400);await response.text()
 }
 const post=await b.post('/asks/1?limit=2',owner.cookie,{csrf:owner.csrf});assert.equal(post.status,400);await post.text()
})

test('editing a former-group entry never submits a replacement community implicitly',async t=>{
 const updates=[],entry={id:7,title:'Private introduction',body:'Need a mentor',kind:'ask',source:'manual',audience:'group',status:'open',revision:'a'.repeat(64)}
 const b=await browser(t,{communityIntake:{list:async()=>({entries:[entry]}),update:async(actor,data)=>updates.push(data)}})
 const owner=await b.login('alice'),organizer=await b.login('bob')
 const former=await b.groups.create(bob,'Former community')
 entry.groupId=former.id
 const invite=await b.groups.invite(bob,former.id,alice,profiles[0])
 await b.groups.respond(alice,former.id,invite,'accept')
 const unchanged=editForm(await (await b.get('/asks/7',owner.cookie)).text())
 assert.equal(unchanged.get('groupId'),former.id)
 const member=(await b.store.get(former.id)).members[0]
 assert.equal((await b.post(`/groups/${former.id}/members/${member.id}/remove`,organizer.cookie,{csrf:organizer.csrf})).status,303)
 const noGroups=editForm(await (await b.get('/asks/7',owner.cookie)).text())
 assert.equal(noGroups.get('audience-0'),'group')
 assert.equal((await b.post('/asks/7',owner.cookie,noGroups)).status,400)
 const current=await b.groups.create(alice,'Current community')
 const form=editForm(await (await b.get('/asks/7',owner.cookie)).text())
 assert.equal(form.get('audience-0'),'group')
 assert.equal(form.get('groupId'),'')
 form.set('status','done')
 assert.equal((await b.post('/asks/7',owner.cookie,form)).status,400)
 assert.equal(updates.length,0)
 form.set('groupId',former.id)
 assert.equal((await b.post('/asks/7',owner.cookie,form)).status,400)
 assert.equal(updates.length,0)
 form.set('groupId',current.id)
 assert.equal((await b.post('/asks/7',owner.cookie,form)).status,303)
 assert.equal(updates[0].entry.groupId,current.id)
 assert.equal(updates[0].status,'done')
 form.set('groupId','')
 form.set('audience-0','only_me')
 assert.equal((await b.post('/asks/7',owner.cookie,form)).status,303)
 assert.equal(updates[1].entry.audience,'only_me')
 assert.equal(updates[1].entry.groupId,undefined)
})
test('all intake HTTP pages and error responses retain no-store and noindex',async t=>{
 const entry={id:7,title:'An ask',body:'',kind:'ask',source:'manual',audience:'only_me',status:'open',revision:'a'.repeat(64)}
 const b=await browser(t,{communityIntake:{list:async()=>({entries:[entry]}),group:async()=>({entries:[]})}}),owner=await b.login('alice')
 const group=await b.groups.create(alice,'Cache fixture')
 const paths=['/asks','/asks/7','/profile/context',`/groups/${group.id}/welcome`,`/groups/${group.id}/community`]
 for(const path of paths)for(const cookie of [owner.cookie,undefined]) {
  const response=await b.get(path,cookie)
  assert.equal(response.status,cookie?200:401,path)
  assert.match(response.headers.get('cache-control'),/\bno-store\b/,path)
  assert.match(response.headers.get('x-robots-tag'),/noindex/,path)
  await response.text()
 }
 for(const path of ['/asks/999','/profile/context?unexpected=1']) {
  const response=await b.get(path,owner.cookie)
  assert.equal(response.status,400)
  assert.match(response.headers.get('cache-control'),/\bno-store\b/)
  await response.text()
 }
 const preview=await b.post('/profile/context/preview',owner.cookie,{csrf:owner.csrf,source:'quick',ask:'Need a mentor'})
 assert.equal(preview.status,200)
 assert.match(preview.headers.get('cache-control'),/\bno-store\b/)
 await preview.text()
})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('500-seat rosters bound live checks and preserve order and final membership',async()=>{
 const store=createMemoryCollectiveGroupsStore(),id=randomUUID()
 const members=Array.from({length:499},(_,i)=>({id:randomUUID(),actor:account('member-'+i),name:'Member '+i,profileId:null}))
 await store.create({id,name:'Large community',organizer:alice,organizerProfileId:null,members,invites:[],shares:[]})
 let inFlight=0,peak=0,unavailable=false
 const check=async value=>{inFlight++;peak=Math.max(peak,inFlight);try{await tick();await tick();return value}finally{inFlight--}}
 const groups=createCollectiveGroups({store,active:async actor=>{
  if(unavailable&&actor.ownerId==='member-0')throw Error('identity unavailable')
  if(actor.ownerId==='member-30')await store.change(id,group=>({...group,members:group.members.filter(row=>row.actor.ownerId!=='member-30')}))
  return check(actor.ownerId!=='member-10')
 },blocked:async(a,b)=>check(b.ownerId==='member-20')})
 const roster=await groups.roster(alice,id)
 assert.ok(peak>1)
 assert.ok(peak<=8)
 assert.deepEqual(roster.map(row=>row.actor.ownerId),['alice',...members.map(row=>row.actor.ownerId).filter(id=>!['member-10','member-20','member-30'].includes(id))])
 unavailable=true
 await assert.rejects(groups.roster(alice,id),/identity unavailable/)
})
test('Social group identity resolution is bounded, ordered, filtered and fails closed',async()=>{
 const roster=Array.from({length:500},(_,i)=>({id:'seat-'+i,name:'Member '+i,actor:account('member-'+i)})),calls=[]
 let inFlight=0,peak=0,unavailable=false
 const identityForOwner=async owner=>{
  inFlight++;peak=Math.max(peak,inFlight)
  try {
   await tick()
   if(unavailable&&owner.ownerId==='member-0')throw Error('identity unavailable')
   if(owner.ownerId==='member-10')return null
   return {issuer:owner.ownerId==='member-20'?'https://untrusted.invalid':'https://id.ideaflow.app/api/auth',subject:owner.userId}
  }finally{inFlight--}
 }
 const identity=subject=>({issuer:'https://id.ideaflow.app/api/auth',subject})
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner,fetchImpl:async(url,opts)=>{
  calls.push(JSON.parse(opts.body))
  return {ok:true,json:async()=>({entries:[{ownerKey:identityKey(identity('member-0-user')),title:'Visible ask'},{ownerKey:identityKey(identity('member-10-user')),title:'Inactive'},{ownerKey:identityKey(identity('member-20-user')),title:'Unverified'},{ownerKey:identityKey(identity('outsider')),title:'Outsider'}]})}
 }})
 assert.deepEqual(await client.group(alice,randomUUID(),roster),{entries:[{title:'Visible ask',memberId:'seat-0',name:'Member 0'}],nextCursor:undefined})
 assert.ok(peak>1)
 assert.ok(peak<=8)
 assert.deepEqual(calls[0].members,roster.filter(row=>!['member-10','member-20'].includes(row.actor.ownerId)).map(row=>identity(row.actor.userId)))
 unavailable=true
 await assert.rejects(client.group(alice,randomUUID(),roster),/identity unavailable/)
 assert.equal(calls.length,1)
})
test('community responses revalidate live blocks and membership after Social returns',async t=>{
 let blocked=false,onRead=async()=>{}
 const b=await browser(t,{communityIntake:{group:async()=>{await onRead();return {entries:[{kind:'ask',title:'Hidden fixture ask',status:'open'}]}}}},{blocked:async(a,b)=>blocked&&[a.ownerId,b.ownerId].includes('bob')})
 const owner=await b.login('alice'),member=await b.login('bob'),group=await b.groups.create(alice,'Revalidation fixture')
 const invite=await b.groups.invite(alice,group.id,bob,profiles[1])
 await b.groups.respond(bob,group.id,invite,'accept')
 onRead=async()=>{blocked=true}
 const changedBlock=await b.get(`/groups/${group.id}/community`,owner.cookie)
 assert.equal(changedBlock.status,400)
 assert.doesNotMatch(await changedBlock.text(),/Hidden fixture ask/)
 blocked=false
 onRead=async()=>{const seat=(await b.store.get(group.id)).members[0];await b.groups.revoke(alice,group.id,'member',seat.id)}
 const removedViewer=await b.get(`/groups/${group.id}/community`,member.cookie)
 assert.equal(removedViewer.status,400)
 assert.doesNotMatch(await removedViewer.text(),/Hidden fixture ask/)
})

test('HTTP walkthrough reviews private drafts, saves through the Social partner client and tracks shared asks',async t=>{
 const entries=[],calls=[],transcript=[]
 const partnerSecret='synthetic-partner-secret-'.repeat(3)
 // A protocol fixture, not a replacement implementation of Social persistence.
 const partner=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const data=JSON.parse(raw)
  assert.equal(req.headers.authorization,'Bearer '+partnerSecret)
  assert.equal(data.issuer,'https://id.ideaflow.app/api/auth')
  assert.equal(data.subject,'new-builder-user')
  calls.push({path:req.url,data})
  const ownerKey=identityKey(data)
  let result
  if(req.url.endsWith('/intake')) {
   entries.push(...data.entries.map(e=>({...e,id:entries.length+1,ownerKey,name:'Fixture builder',status:'open',revision:'a'.repeat(64)})))
   result={entries}
  } else if(req.url.endsWith('/entry')) {
   const entry=entries.find(e=>e.id===data.id)
   assert.equal(data.revision,entry.revision)
   Object.assign(entry,data.entry,{status:data.status})
   result={entry}
  } else if(req.url.endsWith('/group')) {
   result={entries:entries.filter(e=>e.audience==='group'&&e.groupId===data.groupId)}
  } else if(req.url.endsWith('/entries')) result={entries,profileUrl:'https://social.ideaflow.app/u/fixture-builder'}
  else {res.writeHead(404).end();return}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result))
 })
 await new Promise(resolve=>partner.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>partner.close(resolve)))
 const client=createCommunityIntakeClient({secret:partnerSecret,origin:`http://127.0.0.1:${partner.address().port}`,identityForOwner:async owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId})})
 const b=await browser(t,{communityIntake:client}),organizer=await b.login('alice')
 const created=await b.post('/groups',organizer.cookie,{csrf:organizer.csrf,name:'Boulder Tech Builders'})
 const groupPath=created.headers.get('location'),groupId=groupPath.split('/').pop()
 await b.post(groupPath+'/flyer',organizer.cookie,{csrf:organizer.csrf,capacity:'100',mode:'join'})
 const invite=groupPath+'/join/'+(await b.store.get(groupId)).flyer.id
 const member=await b.login('new-builder',invite)
 assert.equal(member.destination,invite)
 assert.equal((await b.store.get(groupId)).members.length,0)
 const joined=await b.post(invite,member.cookie,{csrf:member.csrf,decision:'join'})
 assert.equal(joined.headers.get('location'),groupPath+'/welcome')
 assert.equal(calls.length,0,'joining does not provision or copy membership to Social')
 transcript.push({step:'Signup retains the QR destination; explicit Join reaches optional introduction',destination:member.destination,joined:joined.headers.get('location'),partnerCalls:calls.length})
 const evidenceDir=process.env.COMMUNITY_INTAKE_EVIDENCE_DIR
 if(evidenceDir)await mkdir(evidenceDir,{recursive:true})
 const capture=async(name,response)=>{
  assert.equal(response.status,200,name)
  assert.match(response.headers.get('cache-control'),/no-store/)
  const html=await response.text()
  assert.doesNotMatch(html,new RegExp(partnerSecret))
  if(evidenceDir)await writeFile(join(evidenceDir,name+'.html'),html)
  return html
 }
 const welcome=await capture('01-welcome',await b.get(groupPath+'/welcome',member.cookie))
 assert.match(welcome,/<title>Introduce yourself to Boulder Tech Builders · Unlinked<\/title>/)
 assert.match(welcome,/<details class="card"><summary><strong>Add more about me/)
 const quick=htmlForm(welcome,groupPath+'/welcome/preview')
 quick.set('about','I build developer tools in Boulder')
 quick.set('ask','A Postgres mentor')
 quick.set('offer','Help with accessible interfaces')
 const review=await capture('02-private-review',await b.post(groupPath+'/welcome/preview',member.cookie,quick))
 const form=htmlForm(review,groupPath+'/welcome/save')
 assert.equal(form.get('count'),'3')
 for(let i=0;i<3;i++){assert.equal(form.get('audience-'+i),'group');form.set('audience-'+i,'only_me')}
 assert.equal(calls.length,0,'preview does not send drafts to Social or a model')
 form.delete('selected');form.append('selected','1')
 const saved=await b.post(groupPath+'/welcome/save',member.cookie,form)
 assert.equal(saved.status,303)
 assert.equal(entries.length,1)
 assert.equal(entries[0].title,'Ask: A Postgres mentor')
 assert.equal(entries[0].audience,'only_me')
 assert.equal(entries[0].groupId,undefined)
 assert.equal(calls[0].path,'/api/partners/unlinked/intake')
 assert.equal(calls[0].data.consent,true)
 assert.equal(calls[0].data.members,undefined)
 const privateCommunity=await capture('03-community-before-sharing',await b.get(groupPath+'/community',member.cookie))
 assert.doesNotMatch(privateCommunity,/A Postgres mentor/)
 const editing=await capture('04-share-entry',await b.get('/asks/1',member.cookie))
 const edit=editForm(editing)
 edit.set('audience-0','group');edit.set('groupId',groupId)
 assert.equal((await b.post('/asks/1',member.cookie,edit)).status,303)
 const community=await capture('05-shared-community',await b.get(groupPath+'/community',member.cookie))
 assert.match(community,/A Postgres mentor/)
 assert.match(community,/<title>Boulder Tech Builders · Community · Unlinked<\/title>/)
 const listing=await capture('06-my-asks',await b.get('/asks',member.cookie))
 assert.match(listing,/joining a community here does not automatically join a Superconnector network/)
 transcript.push({step:'Only the selected ask is stored under the verified identity; Only me stays out of community until explicitly shared',saved:entries.map(e=>{const entry={...e};delete entry.ownerKey;return entry}),partnerRequests:calls.map(c=>({path:c.path,issuer:c.data.issuer,subject:c.data.subject,groupId:c.data.groupId,entry:c.data.entry}))})
 edit.set('status','done')
 assert.equal((await b.post('/asks/1',member.cookie,edit)).status,303)
 const done=await capture('07-completed-ask',await b.get('/asks',member.cookie))
 assert.match(done,/ask · done · Boulder Tech Builders/)
 assert.doesNotMatch(await (await b.get(groupPath+'/community',member.cookie)).text(),/A Postgres mentor/)
 const imports=htmlForm(welcome,groupPath+'/welcome/preview')
 imports.delete('about');imports.delete('ask');imports.delete('offer')
 for(const [source,text,name] of [
  ['tasks','Send invoices\nI need help with Postgres','08-task-review'],
  ['bookshelf','Title,Author\n"Thinking, Fast and Slow",Daniel Kahneman','09-goodreads-review'],
  ['assistant',JSON.stringify({about:'I build tools',asks:['A cofounder introduction'],tasks:['Send invoices']}),'10-assistant-review'],
 ]) {
  imports.set('source',source);imports.set('text',text)
  const html=await capture(name,await b.post(groupPath+'/welcome/preview',member.cookie,imports))
  const fields=htmlForm(html,groupPath+'/welcome/save')
  for(let i=0;i<Number(fields.get('count'));i++)assert.equal(fields.get('audience-'+i),'only_me')
  if(source==='tasks')assert.deepEqual(fields.getAll('selected'),['1'])
  if(source==='bookshelf')assert.equal(fields.get('title-0'),'Thinking, Fast and Slow — Daniel Kahneman')
  if(source==='assistant')assert.deepEqual(fields.getAll('selected'),['0','1'])
 }
 assert.equal(entries.length,1,'unsaved import reviews create no entries')
 transcript.push({step:'Status Done removes the ask from the open community; task, Goodreads and assistant drafts all require review and default to Only me',entryStatus:entries[0].status,unsavedImports:3,canonicalFixtureEntries:entries.length,scope:'HTTP integration with synthetic Social protocol fixture; live Social persistence and browser pixels are not exercised'})
 if(evidenceDir)await writeFile(join(evidenceDir,'walkthrough.json'),JSON.stringify(transcript,null,2)+'\n')
})


test('owner entries needing Social visibility review never default to an editable Only me form',async t=>{
 for(const entry of [
  {id:42,title:'Unlisted context',kind:'note',status:'open',audience:'unlisted',visibility:'unlisted',requiresSocialReview:true},
  {id:42,title:'Conflicting visibility',kind:'ask',status:'open',audience:'only_me',visibility:'public',requiresSocialReview:true},
  {id:42,title:'Unlisted without review flag',kind:'note',status:'open',audience:'unlisted',visibility:'unlisted'},
  {id:42,title:'Unknown audience',kind:'note',status:'open',audience:'future-audience'},
 ]) {
  const b=await browser(t,{communityIntake:{list:async()=>({entries:[entry]})}})
  const member=await b.login('alice')
  const response=await b.get('/asks',member.cookie)
  assert.equal(response.status,200)
  const listing=await response.text()
  assert.match(listing,/https:\/\/social.ideaflow.app\/n\/42/)
  assert.doesNotMatch(listing,/note · open · Only me|ask · open · Only me/)
  const editResponse=await b.get('/asks/42',member.cookie)
  assert.equal(editResponse.status,200)
  const editing=await editResponse.text()
  assert.match(editing,/Review visibility in Social/)
  assert.match(editing,/https:\/\/social.ideaflow.app\/n\/42/)
  assert.match(editing,/<title>Review /)
  assert.doesNotMatch(editing,/name="audience-0"|action="\/asks\/42"/)
  await paginationEvidence({['social-'+entry.title.replaceAll(' ','-').toLowerCase()+'-listing.html']:listing,['social-'+entry.title.replaceAll(' ','-').toLowerCase()+'-manage.html']:editing})
 }
})

test('HTTP stale visibility conflict shows fixed guidance without exposing partner text or changing audience',async t=>{
 const entry=intakeEntry(42),updates=[]
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async()=>({issuer:'https://id.ideaflow.app/api/auth',subject:alice.userId}),fetchImpl:async(url,opts)=>{
  if(url.endsWith('/entries'))return Response.json({entries:[entry]})
  updates.push(JSON.parse(opts.body))
  return Response.json({error:'entry_visibility_conflict',message:'PRIVATE UPSTREAM TEXT',url:'https://untrusted.invalid/private'},{status:409})
 }})
 const b=await browser(t,{communityIntake:client}),member=await b.login('alice')
 const form=editForm(await (await b.get('/asks/42',member.cookie)).text())
 assert.equal(form.get('audience-0'),'only_me')
 const response=await b.post('/asks/42',member.cookie,form)
 assert.equal(response.status,400)
 assert.match(response.headers.get('cache-control'),/no-store/)
 const html=await response.text()
 assert.match(html,/Review this entry’s visibility in Social before editing it through Unlinked\. Open My asks and offers to find its Social link\./)
 assert.doesNotMatch(html,/PRIVATE UPSTREAM TEXT|untrusted\.invalid/)
 assert.equal(updates.length,1)
 assert.equal(updates[0].entry.audience,'only_me')
 assert.equal(entry.audience,'only_me')
 await paginationEvidence({'social-visibility-conflict.html':html,'social-visibility-conflict.json':JSON.stringify({status:response.status,audience:entry.audience,message:'Review this entry’s visibility in Social before editing it through Unlinked. Open My asks and offers to find its Social link.',upstreamDetailsExposed:false},null,2)+'\n'})
})

test('organizer edits independent chat invitations without leaking member-only group context',async t=>{
 const client={group:async()=>({entries:[]})},b=await browser(t,{communityIntake:client}),owner=await b.login('alice'),member=await b.login('bob'),stranger=await b.login('carol')
 const group=await b.groups.create(alice,'Boulder'),flyer=await b.groups.createFlyer(alice,group.id,{capacity:100,approval:false}),base='/groups/'+group.id
 await b.groups.joinFlyer(bob,group.id,flyer.id,{profileId:null,name:'Bob',source:{}})
 const memberId=(await b.groups.roster(alice,group.id)).find(row=>row.name==='Bob').id
 const openChatUrl='https://chat.ideaflow.app/i/'+'Ab0_'.repeat(8)
 const fields={csrf:owner.csrf,description:'Build together. <script>bad</script>\nBring a project.',chatUrl:'https://chat.whatsapp.com/AbCdEf1234567890123456?mode=gi_t',openChatUrl}
 assert.equal((await b.post(base+'/about',member.cookie,{...fields,csrf:member.csrf})).status,404)
 assert.equal((await b.post(base+'/about',stranger.cookie,{...fields,csrf:stranger.csrf})).status,404)
 assert.equal((await b.post(base+'/about',owner.cookie,{...fields,csrf:'wrong'})).status,400)
 assert.equal((await b.post(base+'/about',owner.cookie,fields,'https://evil.invalid')).status,403)
 for(const chatUrl of ['javascript:alert(1)','https://chat.whatsapp.com.evil.invalid/AbCdEf1234567890123456','https://name:pass@chat.whatsapp.com/AbCdEf1234567890123456'])assert.equal((await b.post(base+'/about',owner.cookie,{...fields,chatUrl})).status,400)
 for(const value of [
  'javascript:alert(1)',openChatUrl.replace('https:','http:'),openChatUrl.replace('.app/','.app.evil.invalid/'),
  openChatUrl.replace('https://','https://name:pass@'),openChatUrl.replace('https://','https://@'),
  openChatUrl.replace('.app/','.app:444/'),openChatUrl+'?x=1',openChatUrl+'?',openChatUrl+'#x',openChatUrl+'#',
  openChatUrl+'/',openChatUrl.slice(0,-1),openChatUrl+'a',openChatUrl.replace('/i/','/I/'),
  openChatUrl.replace('/i/','/other/../i/'),openChatUrl.replace('/i/','/i%2f'),openChatUrl.replace('/i/','/i/\\'),
 ])assert.equal((await b.post(base+'/about',owner.cookie,{...fields,openChatUrl:value})).status,400,value)
 assert.equal((await b.post(base+'/about',owner.cookie,{...fields,description:'a'.repeat(2001)})).status,400)
 assert.equal((await b.groups.detail(alice,group.id)).description,'')
 assert.equal((await b.groups.detail(alice,group.id)).chatUrl,'')
 assert.equal((await b.groups.detail(alice,group.id)).openChatUrl,'')
 assert.equal((await b.post(base+'/about',owner.cookie,{...fields,openChatUrl:openChatUrl.replace('.app/','.app:443/')})).status,303)
 b.restart()
 Object.assign(owner,await b.login('alice'));Object.assign(member,await b.login('bob'));Object.assign(stranger,await b.login('carol'))
 const persisted=await b.groups.detail(bob,group.id)
 assert.equal(persisted.chatUrl,fields.chatUrl);assert.equal(persisted.openChatUrl,openChatUrl)
 const exported=(await b.groups.exportOwner(alice))[0]
 assert.equal(exported.description,fields.description);assert.equal(exported.chatUrl,fields.chatUrl);assert.equal(exported.openChatUrl,openChatUrl)
 assert.deepEqual(await b.groups.exportOwner(bob),[{groupId:group.id,role:'member'}])
 for(const route of [base,base+'/welcome',base+'/community',base+'/community/'+memberId]) {
  const response=await b.get(route,member.cookie),html=await response.text();assert.equal(response.status,200)
  assert.match(html,/Build together/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.match(html,/Join the WhatsApp group chat/);assert.doesNotMatch(html,/<script>bad/)
  assert.ok(html.includes(`href="${openChatUrl}" target="_blank" rel="noopener noreferrer">Message the group`))
  assert.doesNotMatch(html,/name="openChatUrl"/)
  assert.match(response.headers.get('cache-control'),/no-store/)
  await paginationEvidence({[route===base?'group-member-settings.html':route.endsWith('/welcome')?'group-welcome.html':route.endsWith('/community')?'group-community-metadata.html':'group-member-metadata.html']:html})
  const denied=await b.get(route,stranger.cookie);assert.notEqual(denied.status,200);assert.doesNotMatch(await denied.text(),/Build together|chat.whatsapp|chat.ideaflow.app\/i\//)
  const anonymous=await b.get(route);assert.equal(anonymous.status,401);assert.doesNotMatch(await anonymous.text(),/Build together|chat.whatsapp|chat.ideaflow.app\/i\//)
 }
 const editHtml=await (await b.get(base,owner.cookie)).text()
 assert.ok(editHtml.includes(`name="chatUrl" type="text" inputmode="url" maxlength="500"`))
 assert.ok(editHtml.includes(`name="openChatUrl" type="text" inputmode="url" maxlength="500" value="${openChatUrl}"`))
 assert.match(editHtml,/The community chat follows group membership/)
 await paginationEvidence({'group-organizer-settings.html':editHtml})
 for(const cookie of [undefined,stranger.cookie]) {
  const invitation=await b.get(base+'/join/'+flyer.id,cookie);assert.equal(invitation.status,200);assert.doesNotMatch(await invitation.text(),/Build together|chat.whatsapp|chat.ideaflow.app\/i\//)
 }
 const directInvite=await b.groups.invite(alice,group.id,carol,profiles[2])
 const invited=await b.get(base+'/invites/'+directInvite,stranger.cookie)
 assert.equal(invited.status,200);assert.doesNotMatch(await invited.text(),/Build together|chat.whatsapp|chat.ideaflow.app\/i\//)
 assert.equal((await b.store.get(group.id)).members.length,1)
 const edit={...fields,csrf:owner.csrf}
 assert.equal((await b.post(base+'/about',owner.cookie,{...edit,chatUrl:''})).status,303)
 assert.equal((await b.groups.detail(bob,group.id)).chatUrl,'');assert.equal((await b.groups.detail(bob,group.id)).openChatUrl,openChatUrl)
 assert.equal((await b.post(base+'/about',owner.cookie,{...edit,openChatUrl:'https://chat.ideaflow.app/i/'+'Cd1-'.repeat(8)})).status,303)
 assert.equal((await b.groups.detail(bob,group.id)).chatUrl,fields.chatUrl)
 assert.equal((await b.groups.detail(bob,group.id)).openChatUrl,'https://chat.ideaflow.app/i/'+'Cd1-'.repeat(8))
 assert.equal((await b.post(base+'/about',owner.cookie,{...edit,openChatUrl:'  '})).status,303)
 assert.equal((await b.groups.detail(bob,group.id)).chatUrl,fields.chatUrl);assert.equal((await b.groups.detail(bob,group.id)).openChatUrl,'')
 assert.equal((await b.post(base+'/about',owner.cookie,{...edit,description:'',chatUrl:'',openChatUrl:''})).status,303)
 const cleared=await b.groups.detail(bob,group.id)
 assert.equal(cleared.description,'');assert.equal(cleared.chatUrl,'');assert.equal(cleared.openChatUrl,'')
})

test('HTTP group metadata accepts maximum CJK descriptions and bounds encoded bodies by route',async t=>{
 const b=await browser(t),owner=await b.login('alice'),group=await b.groups.create(alice,'Encoded metadata'),base='/groups/'+group.id
 const fields={csrf:owner.csrf,description:'界'.repeat(2000),chatUrl:'https://chat.whatsapp.com/'+'A'.repeat(64)+'?mode=gi_t',openChatUrl:'https://chat.ideaflow.app/i/'+'a'.repeat(32)}
 assert.ok(new URLSearchParams(fields).toString().length>16384)
 assert.equal((await b.post(base+'/about',owner.cookie,fields)).status,303)
 const persisted=await b.groups.detail(alice,group.id)
 assert.equal(persisted.description,fields.description);assert.equal(persisted.chatUrl,fields.chatUrl);assert.equal(persisted.openChatUrl,fields.openChatUrl)
 assert.equal((await b.post(base+'/about',owner.cookie,{...fields,description:'界'.repeat(2001)})).status,400)
 assert.equal((await b.post(base+'/about',owner.cookie,{...fields,description:'界'.repeat(4000)})).status,413)
 assert.equal((await b.groups.detail(alice,group.id)).description,fields.description)
 assert.equal((await b.post('/groups',owner.cookie,{csrf:owner.csrf,name:'界'.repeat(500)})).status,413)
})

test('group member profiles bind entries to roster identities and explain matches without leaking other owners',async t=>{
 const identity=owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId})
 let entries=[]
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async owner=>identity(owner),fetchImpl:async()=>new Response(JSON.stringify({entries}),{status:200})})
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice'),member=await b.login('bob'),stranger=await b.login('carol')
 const group=await b.groups.create(alice,'Builders'),flyer=await b.groups.createFlyer(alice,group.id,{capacity:100,approval:false})
 await b.groups.joinFlyer(bob,group.id,flyer.id,{name:'Bob',profileId:null,source:{}})
 const roster=await b.groups.roster(alice,group.id),bobId=roster.find(r=>r.name==='Bob').id,base='/groups/'+group.id+'/community'
 entries=[{id:1,title:'Need React accessibility advice',kind:'ask',status:'open',ownerKey:identityKey(identity(alice))},{id:2,title:'I offer React accessibility reviews',kind:'offer',status:'open',ownerKey:identityKey(identity(bob)),name:'Untrusted name'},{id:3,title:'PRIVATE outsider detail',kind:'offer',status:'open',ownerKey:identityKey(identity(carol))}]
 const community=await b.get(base,owner.cookie),html=await community.text();assert.equal(community.status,200)
 assert.match(html,/Suggested connections/);assert.match(html,/Shared topics: accessibility, react/);assert.match(html,new RegExp('/groups/'+group.urlKey+'/community/'+bobId));assert.doesNotMatch(html,/PRIVATE outsider|Untrusted name|ownerKey|bob-user/)
 const profile=await b.get(base+'/'+bobId,owner.cookie),profileHtml=await profile.text();assert.equal(profile.status,200)
 assert.match(profileHtml,/<title>Bob · Builders · Community/);assert.match(profileHtml,/I offer React accessibility reviews/);assert.doesNotMatch(profileHtml,/Need React accessibility advice|PRIVATE outsider/)
 await paginationEvidence({'community-suggested-connections.html':html,'community-member-profile.html':profileHtml})
 assert.notEqual((await b.get(base+'/'+bobId,stranger.cookie)).status,200)
 assert.equal((await b.get(base+'/'+bobId)).status,401)
 await b.groups.revoke(alice,group.id,'member',bobId)
 assert.notEqual((await b.get(base+'/'+bobId,owner.cookie)).status,200)
 assert.notEqual((await b.get(base,member.cookie)).status,200)
})

import { communityMatches } from '../mcp-server/community-matches.mjs'
test('matching excludes self, closed requests and same-kind pairs, and normalizes explicit topics',()=>{
 const rows=[{id:1,memberId:'a',title:'Need PostgreSQL queries',kind:'ask',status:'open'},
 {id:2,memberId:'b',title:'Can help with Postgres queries',kind:'offer',status:'open'},
 {id:3,memberId:'a',title:'Postgres queries',kind:'offer',status:'open'},
 {id:4,memberId:'c',title:'Postgres queries',kind:'offer',status:'done'},
 {id:5,memberId:'d',title:'Postgres queries',kind:'ask',status:'paused'}]
 const matches=communityMatches(rows,'a');assert.equal(matches.length,1);assert.equal(matches[0].memberId,'b');assert.deepEqual(matches[0].topics,['postgres','query'])
 assert.deepEqual(communityMatches(rows,'absent'),[])
})

test('matching keeps the best pair per member and direction with stable relevance ties',()=>{
 const entry=(id,memberId,kind,title)=>({id,memberId,kind,title,status:'open'})
 const rows=[entry('mine-1','me','ask','React accessibility'),entry('mine-2','me','ask','PostgreSQL queries'),
  entry('mine-3','me','offer','React accessibility'),entry('mine-4','me','ask','React accessibility'),
  entry('20','bob','offer','React accessibility'),entry('10','bob','offer','React accessibility'),
  entry('01','bob','offer','React'),entry('10','carol','offer','Postgres queries'),
  entry('10','dave','offer','React accessibility'),entry('05','bob','ask','React accessibility')]
 const matches=communityMatches(rows,'me',20)
 assert.deepEqual(matches.map(m=>[m.memberId,m.mine.id,m.other.id,m.topics]),[
  ['bob','mine-3','05',['accessibility','react']],
  ['bob','mine-1','10',['accessibility','react']],
  ['dave','mine-1','10',['accessibility','react']],
  ['carol','mine-2','10',['postgres','query']],
 ])
 assert.deepEqual(communityMatches(rows,'me',3),matches.slice(0,3))
 assert.deepEqual(communityMatches(rows,'me',0),[])
})

test('matching preserves pair order when a later ask improves an earlier member’s match',()=>{
 const rows=[
  {id:1,memberId:'me',kind:'ask',title:'React design'},
  {id:2,memberId:'me',kind:'ask',title:'Postgres design'},
  {id:3,memberId:'postgres',kind:'offer',title:'Postgres design'},
  {id:3,memberId:'react',kind:'offer',title:'React design'},
 ].map(e=>({...e,status:'open'}))
 assert.deepEqual(communityMatches(rows,'me').map(m=>[m.memberId,m.mine.id]),[['react',1],['postgres',2]])
})

test('matching bounds topic reads on a maximum 500-entry page', {timeout:10000},()=>{
 let titleReads=0,bodyReads=0
 const rows=Array.from({length:500},(_,i)=>({
  id:String(i).padStart(4,'0'),memberId:i<250?'me':'member-'+i,kind:i<250?'ask':'offer',status:'open',
  get title(){titleReads++;return 'Postgres queries'},get body(){bodyReads++;return 'React accessibility'},
 }))
 const matches=communityMatches(rows,'me')
 assert.equal(titleReads,500);assert.equal(bodyReads,500)
 assert.deepEqual(matches.map(m=>m.memberId),Array.from({length:6},(_,i)=>'member-'+(250+i)))
 assert.ok(matches.every(m=>m.mine===rows[0]&&m.topics.join(',')==='accessibility,postgres,query,react'))
})

test('native group chat is same-tab with a separate optional app and readable authenticated routes',async t=>{
 const b=await browser(t,{communityIntake:{group:async()=>({entries:[]})}}, {chatEnabled:true})
 const owner=await b.login('alice'),member=await b.login('bob'),outsider=await b.login('carol')
 const group=await b.groups.create(alice,'Boulder Tech Builders'),base='/groups/'+group.urlKey
 const flyer=await b.groups.createFlyer(alice,group.id,{capacity:20,approval:false})
 await b.groups.joinFlyer(bob,group.id,flyer.id,{name:'Bob',profileId:null,source:{}})
 const id=(await b.groups.detail(alice,group.id)).chatConversationId
 for(const path of [base,base+'/welcome',base+'/community']) {
  const r=await b.get(path,member.cookie);assert.equal(r.status,200);const html=await r.text()
  assert.match(html,new RegExp(`<a class="button" href="/messages/c/${id}">Message the group</a>`))
  assert.match(html,/Open separately in OpenChat/)
  assert.equal((await b.get(path)).status,401)
  assert.notEqual((await b.get(path,outsider.cookie)).status,200)
 }
 const memberPage=await (await b.get('/groups/'+group.id,member.cookie)).text()
 const leaveForm=/<form method="post" action="([^"]+\/leave)">([\s\S]*?)<\/form>/.exec(memberPage)
 assert.ok(leaveForm)
 assert.equal(leaveForm[1],base+'/leave')
 assert.match(leaveForm[2],/<button class="sm quiet" type="submit">Leave group<\/button>/)
 assert.match(leaveForm[2],new RegExp('name="csrf" value="'+member.csrf+'"'))
 assert.ok(memberPage.indexOf(leaveForm[0])>memberPage.indexOf('<h2>Shared lists</h2>'))
 assert.ok(memberPage.indexOf(leaveForm[0])>memberPage.indexOf('Message the group</a>'))
 assert.equal((await b.get(base+'/join/'+flyer.id)).status,200)
 assert.equal((await b.login('bob',base)).destination,base)
 assert.equal((await b.post(base+'/leave',member.cookie,{csrf:'wrong'})).status,400)
 assert.equal((await b.post(base+'/leave',member.cookie,{csrf:member.csrf})).status,303)
 assert.notEqual((await b.get(base,member.cookie)).status,200)
 const job=await b.store.chatJob(group.id);assert.equal(job.group.members.length,0)
 assert.equal((await b.get(base,owner.cookie)).status,200)
})

test('readable flyer sign-in and signup callbacks retain invitation and source before explicit join',async t=>{
 const b=await browser(t),g=await b.groups.create(alice,'Readable flyer'),f=await b.groups.createFlyer(alice,g.id,{capacity:10,approval:false})
 const path=`/groups/${g.urlKey}/join/${f.id}?src=paper&utm_campaign=builders`
 const preview=await b.get(path);assert.equal(preview.status,200)
 assert.match(await preview.text(),/Sign in|Continue|Join/)
 for(const who of ['bob','new-builder']) {
  const logged=await b.login(who,path)
  assert.equal(logged.destination,path)
  assert.equal((await b.store.get(g.id)).members.length,who==='bob'?0:1)
  assert.equal((await b.get(path,logged.cookie)).status,200)
  const joined=await b.post(path,logged.cookie,{csrf:logged.csrf,decision:'join'})
  assert.equal(joined.status,303)
  assert.equal(joined.headers.get('location'),`/groups/${g.id}`)
 }
 const stored=await b.store.get(g.id)
 assert.equal(stored.members.length,2)
 assert.deepEqual(stored.members.map(m=>m.flyer.inviteId),[f.id,f.id])
 assert.deepEqual(stored.members.map(m=>m.flyer.source),Array(2).fill({src:'paper',utm_campaign:'builders'}))
 const anonymous=await (await b.get(path)).text()
 assert.doesNotMatch(anonymous,/bob-user|new-builder-user/)
})

test('focused group ask form saves to the selected audience and shows the result without profile onboarding',async t=>{
 const saved=[]
 const client={save:async(actor,data)=>{saved.push(...data.entries.map((e,i)=>({...e,id:i+1,status:'open',memberId:'organizer',name:'Organizer'})));return{}},group:async()=>({entries:saved.filter(e=>e.audience==='group')}),list:async()=>({entries:saved})}
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice'),group=await b.groups.create(alice,'Builders'),base='/groups/'+group.id
 const response=await b.get(base+'/asks/new',owner.cookie),html=await response.text();assert.equal(response.status,200)
 assert.match(html,/<title>Add an ask/);assert.doesNotMatch(html,/name="about"|name="offer"|Review my introduction/)
 if(process.env.GROUP_UX_EVIDENCE_DIR)await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'ask.html'),html)
 const fields=htmlForm(html,base+'/asks/save');fields.set('title-0','Need a React reviewer');fields.set('body-0','A small prototype')
 assert.equal(fields.get('audience-0'),'group')
 const posted=await b.post(base+'/asks/save',owner.cookie,fields);assert.equal(posted.status,303)
 assert.equal(posted.headers.get('location'),'/groups/'+group.urlKey+'/community?saved=1')
 const board=await (await b.get(posted.headers.get('location'),owner.cookie)).text();assert.match(board,/Saved\. Your entry is shared/);assert.match(board,/Need a React reviewer/)
 if(process.env.GROUP_UX_EVIDENCE_DIR)await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'ask-group-saved.html'),board)
 const privateFields=htmlForm(await (await b.get(base+'/asks/new',owner.cookie)).text(),base+'/asks/save');privateFields.set('title-0','Private draft');privateFields.set('audience-0','only_me')
 const privateSave=await b.post(base+'/asks/save',owner.cookie,privateFields);assert.equal(privateSave.headers.get('location'),'/asks?saved=1')
 const privateResult=await (await b.get('/asks?saved=1',owner.cookie)).text()
 assert.match(privateResult,/Private draft/);assert.match(privateResult,/Only me/);assert.match(privateResult,/Saved\. You can see and edit your entry below/)
 if(process.env.GROUP_UX_EVIDENCE_DIR)await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'ask-private-saved.html'),privateResult)
 assert.doesNotMatch(await (await b.get(base+'/community',owner.cookie)).text(),/Private draft/)
 assert.match(await (await b.get(base+'/welcome',owner.cookie)).text(),/Import LinkedIn/)
})

test('HTTP focused asks and offers retain their draft and receipt after a transient Social failure',async t=>{
 const receipts=new Map(),calls=[]
 const partner=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const data=JSON.parse(raw)
  if(req.url.endsWith('/intake')) {
   calls.push(data)
   const receipt=receipts.get(data.requestId)
   if(receipt){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(receipt));return}
   receipts.set(data.requestId,{entries:data.entries.map(e=>({...e,id:receipts.size+1,status:'open',ownerKey:identityKey(data)}))})
   res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'temporary_failure'}));return
  }
  const entries=[...receipts.values()].flatMap(r=>r.entries)
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({entries:req.url.endsWith('/group')?entries.filter(e=>e.audience==='group'&&e.groupId===data.groupId):entries}))
 })
 await new Promise(resolve=>partner.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>partner.close(resolve)))
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),origin:`http://127.0.0.1:${partner.address().port}`,identityForOwner:async owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId})})
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice'),group=await b.groups.create(alice,'Builders')
 for(const [section,audience,personal] of [['asks','group'],['asks','only_me'],['offers','group'],['offers','only_me'],['asks','only_me',true]]) {
  const path=personal?'/asks':`/groups/${group.urlKey}/${section}`,kind=section==='offers'?'offer':'ask'
  const initial=await b.get(path+'/new',owner.cookie),initialHtml=await initial.text()
  assert.equal(initial.status,200)
  if(kind==='offer')assert.match(initialHtml,/placeholder="e.g. I can review your prototype"/)
  const fields=htmlForm(initialHtml,path+'/save')
  fields.set('title-0',`${kind} ${audience} ${personal?'personal':'group'}: "React" & <accessibility>`)
  fields.set('body-0','A prototype & its details\nKeep <this> and "that".')
  fields.set('audience-0',audience)
  const failed=await b.post(path+'/save',owner.cookie,fields),failedHtml=await failed.text()
  assert.equal(failed.status,503);assert.match(failed.headers.get('cache-control'),/no-store/)
  assert.match(failedHtml,new RegExp(`<title>Add an ${kind}`));assert.match(failedHtml,/role="alert"/)
  assert.doesNotMatch(failedHtml,/Review your profile draft|Save selected entries|name="about"/)
  if(!personal)assert.doesNotMatch(failedHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1],/value="public"/)
  const retry=htmlForm(failedHtml,path+'/save')
  assert.deepEqual([...retry],[...fields])
  const saved=await b.post(path+'/save',owner.cookie,retry);assert.equal(saved.status,303)
  assert.equal(saved.headers.get('location'),audience==='group'?`/groups/${group.urlKey}/community?saved=1`:'/asks?saved=1')
  assert.deepEqual(calls.at(-1),calls.at(-2))
  assert.equal(calls.at(-1).entries[0].kind,kind)
  assert.equal(calls.at(-1).entries[0].audience,audience)
  assert.equal(calls.at(-1).entries[0].groupId,audience==='group'?group.id:undefined)
  const shown=await b.get(saved.headers.get('location'),owner.cookie)
  assert.equal(shown.status,200);assert.ok(decodeForm(await shown.text()).includes(fields.get('title-0')))
 }
 assert.equal(calls.length,10);assert.equal(receipts.size,5)
 assert.equal([...receipts.values()].flatMap(r=>r.entries).length,5)
})

test('HTTP general review retries and entry editing retain explicit public sharing',async t=>{
 const writes=[],entry={...intakeEntry(7),audience:'public'}
 const client={list:async()=>({entries:[entry]}),save:async(actor,data)=>{writes.push(data);if(writes.length===1)throw Error('temporary failure');return {entries:data.entries}}}
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice')
 const preview=await b.post('/asks/preview',owner.cookie,{csrf:owner.csrf,source:'quick',about:'I build tools',ask:'Need a reviewer',offer:''})
 assert.equal(preview.status,200)
 const fields=htmlForm(await preview.text(),'/asks/save');fields.set('audience-0','public')
 const failed=await b.post('/asks/save',owner.cookie,fields),html=await failed.text()
 assert.equal(failed.status,503);assert.match(html,/<title>Review your profile draft/)
 const retry=htmlForm(html,'/asks/save');assert.deepEqual([...retry],[...fields])
 assert.equal((await b.post('/asks/save',owner.cookie,retry)).status,303)
 assert.deepEqual(writes[1],writes[0]);assert.equal(writes[1].entries[0].audience,'public')
 const edit=await b.get('/asks/7',owner.cookie);assert.equal(edit.status,200)
 assert.equal(editForm(await edit.text()).get('audience-0'),'public')
})

test('member roster links blank group profiles and opens verified direct chat; stale membership and forged fields cannot message',async t=>{
 const calls=[],targets=[]
 let blocked=false
 const b=await browser(t,{communityIntake:{group:async()=>({entries:[]})},createMessagingSession:async()=>({token:'fixture-session',user:{userId:'chat-alice'}}),resolveCardMessagingRecipient:async(owner)=>{targets.push(owner);return{id:'chat-'+owner.ownerId}},messagingOptions:{fetchImpl:async(url,opts)=>{calls.push({url,body:opts.body});return new Response(JSON.stringify(url.endsWith('/api/chat/conversations')?{id:'fixture-dm',type:'direct',participants:[]}:{count:0}),{status:200})}}},{blocked:async()=>blocked})
 const a=await b.login('alice'),bb=await b.login('bob'),c=await b.login('carol'),group=await b.groups.create(alice,'Builders'),flyer=await b.groups.createFlyer(alice,group.id,{capacity:100,approval:false})
 await b.groups.joinFlyer(bob,group.id,flyer.id,{name:'Bob Builder',profileId:null,source:{}})
 const seat=(await b.groups.roster(alice,group.id)).find(r=>r.actor.ownerId==='bob'),base='/groups/'+group.id,action=base+'/members/'+seat.id+'/message'
 const detail=await (await b.get(base,a.cookie)).text();assert.match(detail,new RegExp('/community/'+seat.id));assert.match(detail,/View profile/);assert.match(detail,/Message Bob Builder on OpenChat/);assert.match(detail,/href="\/groups"[^>]*>Groups/)
 const profile=await b.get(base+'/community/'+seat.id,a.cookie);assert.equal(profile.status,200);const profileHtml=await profile.text();if(process.env.GROUP_UX_EVIDENCE_DIR){await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'group.html'),detail);await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'profile.html'),profileHtml);await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'welcome.html'),await(await b.get(base+'/welcome',a.cookie)).text());await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'groups.html'),await(await b.get('/groups',a.cookie)).text())};assert.match(profileHtml,/Group profile/);assert.match(profileHtml,/No introduction shared/);assert.doesNotMatch(profileHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1],/Not on Unlinked|unclaimed/)
 assert.equal((await b.post(action,a.cookie,{csrf:a.csrf,ownerId:'carol'})).status,400)
 assert.equal((await b.post(action,c.cookie,{csrf:c.csrf})).status,404)
 assert.equal((await b.post(action,a.cookie,{csrf:a.csrf},'https://evil.invalid')).status,403)
 assert.equal((await b.post(action,a.cookie,{csrf:'wrong'})).status,400)
 assert.equal((await b.get(action,a.cookie)).status,404)
 blocked=true
 assert.equal((await b.post(action,a.cookie,{csrf:a.csrf})).status,404)
 assert.equal(targets.length,0)
 blocked=false
 const sent=await b.post(action,a.cookie,{csrf:a.csrf});assert.equal(sent.status,303);assert.equal(sent.headers.get('location'),'/messages/c/fixture-dm');assert.deepEqual(targets,[bob]);assert.equal(calls.filter(c=>c.url.endsWith('/api/chat/conversations')).length,1);assert.ok(!calls.some(c=>/\/messages$/.test(c.url)))
 assert.deepEqual(JSON.parse(calls.find(c=>c.url.endsWith('/api/chat/conversations')).body),{participantIds:['chat-bob'],type:'direct'})
 if(process.env.GROUP_UX_EVIDENCE_DIR)await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,'message-action.json'),JSON.stringify({action:'Message Bob Builder',response:{status:sent.status,location:sent.headers.get('location')},recipient:targets[0],openChatWrites:calls.filter(c=>c.body).map(c=>({path:new URL(c.url).pathname,body:JSON.parse(c.body)})),messageSends:calls.filter(c=>/\/messages$/.test(c.url)).length,blockedAttempt:{status:404,recipientResolutions:0}},null,2)+'\n')
 await b.groups.leave(bob,group.id)
 assert.equal((await b.post(action,a.cookie,{csrf:a.csrf})).status,404);assert.equal(targets.length,1)
 assert.equal((await b.get(base+'/community/'+seat.id,bb.cookie)).status,400)
})

test('groups in common expose only current mutual membership and honor blocks',async()=>{
 const store=createMemoryCollectiveGroupsStore();let blocked=false
 const groups=createCollectiveGroups({store,active:async()=>true,blocked:async()=>blocked})
 const shared=await groups.create(alice,'Shared'),privateGroup=await groups.create(bob,'Bob only')
 const invite=await groups.invite(alice,shared.id,bob,{id:'bob',name:'Bob'});await groups.respond(bob,shared.id,invite,'accept')
 assert.deepEqual((await groups.inCommon(alice,bob)).map(g=>g.id),[shared.id]);assert.ok(!(await groups.inCommon(alice,bob)).some(g=>g.id===privateGroup.id))
 blocked=true;assert.deepEqual(await groups.inCommon(alice,bob),[])
 blocked=false;await groups.leave(bob,shared.id);assert.deepEqual(await groups.inCommon(alice,bob),[])
})

test('HTTP shared groups are a signed-in intersection on group and public member profiles, never anonymous previews or APIs',async t=>{
 const b=await browser(t,{communityIntake:{group:async()=>({entries:[]})},readPublishedSnapshot:async()=>({state:'published',complete:true,revision:'member-fixture',profiles,connections:[],members:['alice','bob','carol']})})
 const a=await b.login('alice'),c=await b.login('carol')
 const shared=await b.groups.create(alice,'Mutual builders'),aliceOnly=await b.groups.create(alice,'Alice confidential group'),bobOnly=await b.groups.create(bob,'Bob confidential group')
 const invite=await b.groups.invite(alice,shared.id,bob,{id:'bob',name:'Bob'})
 await b.groups.respond(bob,shared.id,invite,'accept')
 const seat=(await b.groups.roster(alice,shared.id)).find(r=>r.actor.ownerId==='bob')
 for(const path of ['/groups/'+shared.urlKey+'/community/'+seat.id,'/people/bob']) {
  const response=await b.get(path,a.cookie);assert.equal(response.status,200,path)
  const html=await response.text()
  assert.match(html,/Groups in common/);assert.match(html,/Mutual builders/)
  for(const hidden of [aliceOnly,bobOnly]) {assert.ok(!html.includes(hidden.name));assert.ok(!html.includes(hidden.id))}
  if(process.env.GROUP_UX_EVIDENCE_DIR)await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,path==='/people/bob'?'member-public-signed-in.html':'member-groups-in-common.html'),html)
 }
 for(const [path,cookie] of [['/people/bob',undefined],['/people/bob',c.cookie],['/api/people/bob',a.cookie],['/api/people',a.cookie]]) {
  const response=await b.get(path,cookie);assert.equal(response.status,200,path)
  const output=await response.text()
  for(const hidden of [shared,aliceOnly,bobOnly]) {assert.ok(!output.includes(hidden.name));assert.ok(!output.includes(hidden.id))}
  assert.doesNotMatch(output,/Groups in common/)
 }
 await b.groups.leave(bob,shared.id)
 assert.doesNotMatch(await (await b.get('/people/bob',a.cookie)).text(),/Groups in common|Mutual builders/)
})

test('focused ask save rechecks live membership and CSRF before calling Social',async t=>{
 const writes=[]
 const client=createCommunityIntakeClient({secret:'fixture-secret-'.repeat(4),identityForOwner:async owner=>({issuer:'https://id.ideaflow.app/api/auth',subject:owner.userId}),fetchImpl:async(url,opts)=>{writes.push({url,body:JSON.parse(opts.body)});return Response.json({entries:[]})}})
 const b=await browser(t,{communityIntake:client}),a=await b.login('alice'),bb=await b.login('bob'),c=await b.login('carol')
 const group=await b.groups.create(alice,'Builders'),invite=await b.groups.invite(alice,group.id,bob,{id:'bob',name:'Bob'})
 await b.groups.respond(bob,group.id,invite,'accept')
 const base='/groups/'+group.urlKey+'/asks',fields=htmlForm(await (await b.get(base+'/new',bb.cookie)).text(),base+'/save')
 fields.set('title-0','Find a design reviewer');fields.set('body-0','One prototype screen')
 assert.equal((await b.post(base+'/save',bb.cookie,{...Object.fromEntries(fields),csrf:'wrong'})).status,400)
 assert.equal((await b.post(base+'/save',bb.cookie,fields,'https://evil.invalid')).status,403)
 assert.equal((await b.post(base+'/save',c.cookie,{...Object.fromEntries(fields),csrf:c.csrf})).status,400)
 assert.equal(writes.length,0)
 const saved=await b.post(base+'/save',bb.cookie,fields);assert.equal(saved.status,303)
 assert.deepEqual(writes[0].body.entries,[{title:'Find a design reviewer',body:'One prototype screen',kind:'ask',source:'manual',audience:'group',groupId:group.id}])
 assert.equal(writes[0].body.subject,'bob-user');assert.equal(writes[0].body.consent,true)
 assert.equal(saved.headers.get('location'),'/groups/'+group.urlKey+'/community?saved=1')
 await b.groups.leave(bob,group.id)
 assert.equal((await b.post(base+'/save',bb.cookie,fields)).status,400);assert.equal(writes.length,1)
 // Only-me drafts work independently of group membership and carry no group id.
 const personal=htmlForm(await (await b.get('/asks/new',a.cookie)).text(),'/asks/save')
 assert.equal(personal.get('audience-0'),'only_me');personal.set('title-0','Private draft')
 assert.equal((await b.post('/asks/save',a.cookie,personal)).headers.get('location'),'/asks?saved=1')
 assert.equal(writes[1].body.entries[0].audience,'only_me');assert.equal(writes[1].body.entries[0].groupId,undefined)
})

test('offers and quick introductions share visibly with the group while imported drafts stay private',async t=>{
 const saved=[],client={save:async(actor,data)=>{saved.push(...data.entries);return{}},group:async()=>({entries:[]})}
 const b=await browser(t,{communityIntake:client}),owner=await b.login('alice'),group=await b.groups.create(alice,'Builders'),base='/groups/'+group.urlKey
 for(const section of ['asks','offers'])assert.equal((await b.get(base+'/'+section,owner.cookie)).headers.get('location'),base+'/community')
 const formHtml=await(await b.get(base+'/offers/new',owner.cookie)).text(),fields=htmlForm(formHtml,base+'/offers/save');assert.equal(fields.get('kind-0'),'offer');assert.equal(fields.get('audience-0'),'group');assert.doesNotMatch(formHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1],/value="public"/)
 fields.set('title-0','I can review accessible React');assert.equal((await b.post(base+'/offers/save',owner.cookie,fields)).status,303);assert.equal(saved[0].kind,'offer')
 const quick=await b.post(base+'/welcome/preview',owner.cookie,{csrf:owner.csrf,source:'quick',about:'I build tools',ask:'Need a reviewer',offer:''});const q=htmlForm(await quick.text(),base+'/welcome/save');assert.equal(q.get('audience-0'),'group');assert.equal(q.get('audience-1'),'group')
 const imported=await b.post(base+'/welcome/preview',owner.cookie,{csrf:owner.csrf,source:'ideas',text:'Personal project notes'});assert.equal(htmlForm(await imported.text(),base+'/welcome/save').get('audience-0'),'only_me')
 const welcome=await(await b.get(base+'/welcome',owner.cookie)).text();assert.ok(welcome.indexOf('You’ve joined the group')<welcome.indexOf('Import LinkedIn'));assert.ok(welcome.indexOf('Review my introduction')<welcome.indexOf('Import LinkedIn'))
})

test('group detail keeps core actions before a five-member preview and offers the full roster',async t=>{
 const b=await browser(t,{}, {active:async()=>true}),owner=await b.login('alice'),group=await b.groups.create(alice,'Builders'),flyer=await b.groups.createFlyer(alice,group.id,{capacity:100,approval:false})
 for(let i=0;i<6;i++)await b.groups.joinFlyer(account('extra'+i),group.id,flyer.id,{name:'Builder '+i,profileId:null,source:{}})
 const body=await(await b.get('/groups/'+group.urlKey,owner.cookie)).text(),roster=body.match(/<ul class="group-members">([\s\S]*?)<\/ul>/)[1]
 assert.equal([...roster.matchAll(/class="group-member"/g)].length,5);assert.match(body,/See all 7 members/);assert.match(body,/community#members/);assert.ok(body.indexOf('Add an ask')<body.indexOf('class="group-members"'));assert.doesNotMatch(body,/<h2>Your community<\/h2>/)
 assert.match(roster,/<div class="group-member-main"><a href="\/groups\/[^\"]+\/community\/[^\"]+">Builder 0<\/a>/)
})

test('fresh signup retains a private messageable group profile when Social is disabled or unavailable',async t=>{
 for(const mode of ['disabled','unavailable']) {
  const resolutions=[],writes=[]
  const communityIntake=mode==='disabled'?undefined:{group:async()=>{throw Error('synthetic Social outage')}}
  const b=await browser(t,{communityIntake,
   createMessagingSession:async()=>({token:'fixture-session',user:{userId:'chat-alice'}}),
   resolveCardMessagingRecipient:async owner=>{resolutions.push(owner);return{id:'chat-'+owner.ownerId}},
   messagingOptions:{fetchImpl:async(url,options)=>{if(options.body)writes.push({path:new URL(url).pathname,body:JSON.parse(options.body)});return Response.json(url.endsWith('/api/chat/conversations')?{id:'fresh-member-dm',type:'direct',participants:[]}:{count:0})}},
  })
  const organizer=await b.login('alice'),outsider=await b.login('carol')
  const group=await b.groups.create(alice,'New builders '+mode),flyer=await b.groups.createFlyer(alice,group.id,{capacity:100,approval:false})
  const invite=`/groups/${group.urlKey}/join/${flyer.id}`,name='fresh-'+mode,member=await b.login(name,invite)
  assert.equal(member.destination,invite)
  assert.equal((await b.store.get(group.id)).members.length,0,'signup alone never joins a group')
  assert.equal(writes.length,0)
  const joined=await b.post(invite,member.cookie,{csrf:member.csrf,decision:'join'})
  assert.equal(joined.status,303)
  assert.equal(joined.headers.get('location'),`/groups/${group.id}`+(communityIntake?'/welcome':''))
  const seat=(await b.groups.roster(alice,group.id)).find(row=>row.actor.ownerId===name)
  assert.ok(seat);assert.equal(seat.profileId,null,'joining does not publish a public profile')
  const path=`/groups/${group.urlKey}/community/${seat.id}`
  const board=await b.get(`/groups/${group.urlKey}/community`,member.cookie)
  assert.equal(board.status,200);assert.ok((await board.text()).includes(path))
  const profile=await b.get(path,organizer.cookie),html=await profile.text()
  assert.equal(profile.status,200);assert.match(profile.headers.get('cache-control'),/no-store/)
  assert.ok(html.includes(`<title>${name} · New builders ${mode} · Community · Unlinked</title>`))
  assert.match(html,/Group profile · Shared with/);assert.match(html,/Only group members can see this profile/)
  assert.match(html,/Shared entries could not be loaded/);assert.ok(html.includes(`Message ${name} on OpenChat`))
  assert.doesNotMatch(html.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1],/unclaimed|Not on Unlinked|Public profile ↗/)
  assert.equal((await b.get(path)).status,401)
  assert.notEqual((await b.get(path,outsider.cookie)).status,200)
  assert.equal((await b.get('/people/'+name)).status,404)
  assert.equal((await b.get('/api/people/'+name)).status,404)
  assert.deepEqual(resolutions,[]);assert.deepEqual(writes,[],'viewing never starts a conversation or sends a message')
  const opened=await b.post(`/groups/${group.urlKey}/members/${seat.id}/message`,organizer.cookie,{csrf:organizer.csrf})
  assert.equal(opened.status,303);assert.equal(opened.headers.get('location'),'/messages/c/fresh-member-dm')
  assert.deepEqual(resolutions,[account(name)])
  assert.deepEqual(writes,[{path:'/api/chat/conversations',body:{participantIds:['chat-'+name],type:'direct'}}])
  if(process.env.GROUP_UX_EVIDENCE_DIR) {
   await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,`fresh-member-social-${mode}.html`),html)
   await writeFile(join(process.env.GROUP_UX_EVIDENCE_DIR,`fresh-member-social-${mode}.json`),JSON.stringify({fixture:'Synthetic verified signup, no imported or published profile',social:mode,join:{status:joined.status,location:joined.headers.get('location')},privateProfile:{path,status:profile.status},publicProfileStatus:404,anonymousGroupProfileStatus:401,explicitMessage:{status:opened.status,location:opened.headers.get('location'),writes},messageSends:0},null,2)+'\n')
  }
 }
})
