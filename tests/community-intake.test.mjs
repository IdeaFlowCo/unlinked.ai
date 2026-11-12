import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySavedSearchLists } from '../mcp-server/saved-search-lists.mjs'
import { createCollectiveGroups, GROUP_LIMITS } from '../mcp-server/collective-groups.mjs'
import { createCollectiveListProjection } from '../mcp-server/collective-group-lists.mjs'
import { createMemoryCollectiveGroupsStore } from '../mcp-server/collective-groups-store.mjs'

const account = id => ({ ownerId: id, userId: id + '-user' })
const alice = account('alice'), bob = account('bob'), carol = account('carol')
const profiles = ['alice', 'bob', 'carol', 'public-a', 'public-b'].map(id => ({ id, name: id, headline: 'Public bio', positions: [], education: [], skills: [] }))
const recipient = { id: 'bob', name: 'Bob' }
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
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'v1', profiles, connections: [] }),
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
 const roster=Array.from({length:500},(_,i)=>({actor:account('member-'+i)})),calls=[]
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
 assert.deepEqual(await client.group(alice,randomUUID(),roster),{entries:[{title:'Visible ask'}],nextCursor:undefined})
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
 for(let i=0;i<3;i++)assert.equal(form.get('audience-'+i),'only_me')
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
 transcript.push({step:'Only the selected ask is stored under the verified identity; Only me stays out of community until explicitly shared',saved:entries.map(({ownerKey,...entry})=>entry),partnerRequests:calls.map(c=>({path:c.path,issuer:c.data.issuer,subject:c.data.subject,groupId:c.data.groupId,entry:c.data.entry}))})
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
