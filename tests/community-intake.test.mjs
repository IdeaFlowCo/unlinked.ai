import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
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

async function browser(t, extra = {}) {
  const store = createMemoryCollectiveGroupsStore()
  const registered = new Set(['alice', 'bob', 'carol'])
  const savedSearchLists = createMemorySavedSearchLists()
  const saved = await savedSearchLists.create(alice, { name: 'Reviewed set', queryUrl: '/network?q=private-query', refs: ['public:public-a', 'contact:private-contact'] })
  await savedSearchLists.create(alice, { name: 'Unselected set', queryUrl: '/network?q=unselected', refs: ['public:public-b'] })
  const foreign = await savedSearchLists.create(carol, { name: 'Carol private list', queryUrl: '/network', refs: ['public:public-b'] })
  let now = 1000
  const active = actor => registered.has(actor.ownerId) && actor.userId === account(actor.ownerId).userId
  const collectiveGroups = createCollectiveGroups({ store, now: () => now, active })
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
  return { get, post, login, saved, foreign, store, expire: () => { now += GROUP_LIMITS.inviteMs },
    restart: () => { handler = createPrivateBrowserHandler({ ...options, baseUrl }) },
    exchanges: () => exchanges,
  }
}
const token = html => html.match(/name="csrf" value="([^"]+)"/)?.[1]
import { draftContext, createCommunityIntakeClient } from '../mcp-server/community-intake.mjs'

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
test('one flyer signup reaches introduction, review saves only selections and group removal revokes read access',async t=>{
 const saved=[]
 const client={list:async()=>({entries:saved}),save:async(owner,body)=>{saved.push(...body.entries.map((e,i)=>({...e,id:i+1,name:'Member',status:'open',revision:1})));return {entries:saved}},group:async()=>saved,update:async()=>{}}
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
