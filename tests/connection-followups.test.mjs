import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createAccountGrantService, ACCOUNT_GRANT_TOOL_VERSIONS, CURRENT_ACCOUNT_GRANT_VERSION, ACCOUNT_WRITE_SCOPE, missingAccountGrantTools } from '../mcp-server/account-grants.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createConnectionRequests, createMemoryConnectionStore } from '../mcp-server/member-connections.mjs'
import { createMemberInvitations, createMemoryInvitationStore } from '../mcp-server/member-invitations.mjs'
import { createConnectionActions } from '../mcp-server/connection-actions.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createAccountAgentApiHandler } from '../mcp-server/account-api.mjs'
import { renderPeople, renderSettings } from '../mcp-server/private-onboarding-views.mjs'
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const a = { ownerId: 'a-owner', userId: 'a-user' }, b = { ownerId: 'b-owner', userId: 'b-user' }, c = { ownerId: 'c-owner', userId: 'c-user' }
const profiles = ['a', 'b', 'c', 'shadow'].map(id => ({ id, name: `Person ${id}`, positions: [], education: [], skills: [] }))
const csrf = text => text.match(/name="csrf" value="([^"]+)"/)[1]
async function site(t, limits) {
  const resources = new Map(), store = createMemoryConnectionStore(), connections = createConnectionRequests({ store })
  const invitations = createMemberInvitations({ store: createMemoryInvitationStore() })
  const accounts = { a, b, c }
  const getBackend = async owner => ({ adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [],
    listAccountGrantIds: async () => [...resources.values()].filter(x => !x.deleted && x.sourceOwnerId === owner.ownerId).map(x => x.sourceId),
    readResource: async (_, id) => { const r = resources.get(id); return r?.sourceOwnerId === owner.ownerId ? structuredClone(r) : null },
    writeResource: async r => { const previous = resources.get(r.sourceId); if (previous && previous.sourceRevision !== r.expectedRevision) throw Error('cas'); resources.set(r.sourceId, structuredClone(r)) },
    readMemberConnections: async () => (await connections.connections(owner)).map(x => ({ ...x, publicProfileId: Object.keys(accounts).find(id => accounts[id].ownerId === x.other.ownerId) })),
  })
  const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'fixture', profiles, members: ['a','b','c'], connections: [{ fromId: 'a', toId: 'shadow' }, { fromId: 'c', toId: 'a' }, ...(await connections.accepted()).map(x => ({ fromId: Object.keys(accounts).find(id => accounts[id].ownerId === x.sender.ownerId), toId: Object.keys(accounts).find(id => accounts[id].ownerId === x.recipient.ownerId) }))] })
  const accountForProfile = async id => accounts[id], ownProfileId = async owner => Object.keys(accounts).find(id => accounts[id].ownerId === owner.ownerId)
  let handler, mcp, api, subject = 'a'
  const server = createServer((req,res) => void (req.url.startsWith('/api/agent/') ? api(req,res) : req.url === '/mcp' ? mcp(req,res) : handler(req,res)))
  await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => server.close(r)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, origin = endpoint.replace('http:', 'https:')
  const grants = createAccountGrantService({ issuer: origin, signingKey: randomBytes(32), getBackend, publicSearchEnabled: true })
  const service = createAccountToolService({ getBackend, readPublishedSnapshot, memberConnections: connections, accountForProfile, ownProfileId, limits })
  mcp = createAccountHostedHandler({ authenticateGrant: grants.authenticateGrant, getBackend, complete: async () => ({ matches: [] }), readPublishedSnapshot, origin, service })
  api = createAccountAgentApiHandler({ authenticateGrantDetailed: grants.authenticateGrantDetailed, authenticateGrant: grants.authenticateGrant, service, origin })
  handler = createPrivateBrowserHandler({ baseUrl: origin, dataMode: 'private_live', signup: async () => accounts[subject], resolveOwner: async () => accounts[subject],
    login: { begin: async () => ({ location: 'https://idp.invalid/', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject, displayName: `Person ${subject}` }) },
    getBackend, readPublishedSnapshot, memberConnections: connections, memberInvitations: invitations, accountForProfile, ownProfileId,
    ensureAccountGrant: grants.ensureGrant, issueAccountGrant: grants.issueGrant, listAccountGrants: grants.listGrants, revokeAccountGrant: grants.revoke, mcpEndpoint: origin + '/mcp' })
  const go = (path, opts = {}) => fetch(endpoint+path,{ redirect:'manual',...opts })
  const signIn = async id => { subject=id; const login = await go('/login'); const cb = await go('/auth/callback/ideaflow?state=state&code=x',{headers:{Cookie:login.headers.getSetCookie()[0].split(';')[0]}}); const cookie=cb.headers.getSetCookie().find(x=>x.startsWith('__Host-ul-session=')).split(';')[0]; const text=await (await go('/settings',{headers:{Cookie:cookie}})).text(); return {cookie,csrf:csrf(text),text} }
  const post = (session,path,fields) => go(path,{method:'POST',headers:{Cookie:session.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:session.csrf,...fields})})
  const agent = (token,path,body) => go('/api/agent/v1/'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  return {go,post,signIn,agent,grants,service,connections,resources,endpoint}
}

test('catalog 1–3 retains main semantics; v4 is a sibling and defaults are read-only', async t => {
  const baseline = execFileSync('git',['show','origin/main:mcp-server/account-grants.mjs'],{encoding:'utf8'})
  // Execute the catalog declaration from the baseline as a semantic compatibility contract.
  const declaration = baseline.slice(baseline.indexOf('export const ACCOUNT_GRANT_TOOL_VERSIONS'), baseline.indexOf('export const CURRENT_ACCOUNT_GRANT_VERSION'))
  const prior = (await import('data:text/javascript,' + encodeURIComponent(declaration))).ACCOUNT_GRANT_TOOL_VERSIONS
  for (const version of [1,2,3]) assert.deepEqual(ACCOUNT_GRANT_TOOL_VERSIONS[version], prior[version])
  assert.equal(CURRENT_ACCOUNT_GRANT_VERSION,4)
  assert.ok(ACCOUNT_GRANT_TOOL_VERSIONS[4][ACCOUNT_WRITE_SCOPE])
  const p=await site(t), issued=await p.grants.issueGrant(a)
  assert.ok(!issued.tools.some(x=>/unlinked_(send|accept|ignore|withdraw)_/.test(x)))
  assert.deepEqual(missingAccountGrantTools(null),[])
  assert.deepEqual(missingAccountGrantTools({version:3,scope:issued.scope,tools:issued.tools}),[])
})

test('HTTP and MCP write access requires opt-in; state machine, authorization, daily and separate minute budgets', async t => {
  const p=await site(t,{writePerMinute:12,deterministicPerMinute:1})
  const read=await p.grants.issueGrant(a), write=await p.grants.issueGrant(a,undefined,{scope:ACCOUNT_WRITE_SCOPE}), other=await p.grants.issueGrant(b,undefined,{scope:ACCOUNT_WRITE_SCOPE}), stranger=await p.grants.issueGrant(c,undefined,{scope:ACCOUNT_WRITE_SCOPE})
  const call=async(token,action,body)=>{ const r=await p.agent(token,'connection-requests/'+action,body);return {status:r.status,body:await r.json()} }
  assert.equal((await call(read.accessToken,'send',{profileId:'b'})).status,403)
  await assert.rejects(p.service.call({grant:{...write,ownerId:a.ownerId,userId:a.userId,scope:read.scope},name:'unlinked_send_connection_request',input:{profileId:'b'}}),{code:'scope_not_granted'})
  for(const issued of [read,write]) {const client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(p.endpoint+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${issued.accessToken}`}}}));const tools=(await client.listTools()).tools;assert.equal(tools.some(x=>x.name==='unlinked_send_connection_request'),issued===write);if(issued===write){assert.equal(tools.find(x=>x.name==='unlinked_send_connection_request').annotations.readOnlyHint,false);const failure=await client.callTool({name:'unlinked_send_connection_request',arguments:{profileId:'shadow'}});assert.equal(failure.isError,true);assert.equal(JSON.parse(failure.content[0].text).error.code,'not_a_member')}await client.close()}
  assert.equal((await call(write.accessToken,'send',{profileId:'shadow'})).body.error.code,'not_a_member')
  assert.equal((await call(write.accessToken,'send',{profileId:'a'})).body.error.code,'invalid_input')
  assert.equal((await call(write.accessToken,'send',{profileId:'c'})).body.error.code,'already_connected')
  assert.equal((await call(write.accessToken,'send',{profileId:'b',note:'x\u0000y'})).body.error.code,'invalid_input')
  const sent=await call(write.accessToken,'send',{profileId:'b'});assert.equal(sent.status,200);assert.equal(sent.body.status,'sent')
  assert.equal((await call(write.accessToken,'send',{profileId:'b'})).body.error.code,'request_pending')
  assert.equal((await call(stranger.accessToken,'accept',{id:sent.body.id})).status,404)
  assert.equal((await call(write.accessToken,'accept',{id:sent.body.id})).status,404)
  assert.equal((await call(other.accessToken,'ignore',{id:sent.body.id})).body.status,'ignored')
  assert.equal((await p.connections.between(a,b)).state,'outgoing')
  assert.equal((await call(other.accessToken,'send',{profileId:'a'})).body.status,'accepted')
  await p.connections.remove(b,sent.body.id)
  const again=await call(write.accessToken,'send',{profileId:'b'});assert.equal(again.body.status,'sent')
  assert.equal((await call(write.accessToken,'withdraw',{id:again.body.id})).body.status,'withdrawn')
  assert.equal((await call(write.accessToken,'send',{profileId:'b'})).body.error.code,'cooldown_active')
  await p.agent(write.accessToken,'whoami');assert.equal((await p.agent(write.accessToken,'whoami')).status,429)
  for(let i=0;i<3;i++) await call(write.accessToken,'send',{profileId:'shadow'})
  assert.equal((await call(write.accessToken,'send',{profileId:'shadow'})).body.error.code,'rate_limited')
  await p.grants.revoke(a,write.grantId);assert.equal((await call(write.accessToken,'send',{profileId:'b'})).status,401)
})

test('browser rows and member-only filter count both graph directions; removal is bilateral and reconnectable; imported evidence survives', async t => {
  const p=await site(t), sa=await p.signIn('a'), sb=await p.signIn('b'), sc=await p.signIn('c')
  const page=async s=>await(await p.go('/network',{headers:{Cookie:s.cookie}})).text()
  assert.match(await page(sa),/action="\/connections\/request"/)
  assert.match(await page(sa),/href="\/invites">Invite to Unlinked<\/a>/)
  const sent=await p.post(sa,'/connections/request',{profileId:'b',next:'/network?presence=member'});assert.equal(sent.headers.get('location'),'/network?presence=member&notice=sent')
  assert.match(await page(sa),/Pending.*?Withdraw/s);assert.match(await page(sb),/Accept invitation.*?Ignore/s)
  const id=(await p.connections.received(b))[0].id
  await p.post(sb,'/connections/respond',{id,action:'accept'})
  assert.match(await page(sa),/Remove connection…/)
  const filtered=await(await p.go('/network?connected=1&presence=member',{headers:{Cookie:sa.cookie}})).text()
  assert.match(filtered,/My connections on Unlinked \(2\)/);assert.match(filtered,/Person b/);assert.match(filtered,/Person c/);assert.doesNotMatch(filtered,/>Person shadow</)
  assert.equal((await p.post(sc,'/connections/remove',{id})).headers.get('location'),'/invitations?notice=connection_not_found')
  const bad=await p.go('/connections/remove',{method:'POST',headers:{Cookie:sa.cookie,Origin:'https://evil.invalid'},body:new URLSearchParams({csrf:sa.csrf,id})});assert.equal(bad.status,403)
  await p.post(sa,'/connections/remove',{id,next:'/people/b'})
  assert.deepEqual(await p.connections.connections(a),[]);assert.deepEqual(await p.connections.connections(b),[])
  assert.equal((await p.connections.between(b,a)).state,'none')
  const remaining=await(await p.go('/network?connected=1&presence=member',{headers:{Cookie:sa.cookie}})).text();assert.match(remaining,/My connections on Unlinked \(1\)/);assert.doesNotMatch(remaining,/>Person b</);assert.match(remaining,/Person c/)
  await p.post(sb,'/connections/request',{profileId:'a'});assert.equal((await p.connections.between(a,b)).state,'incoming')
  await p.post(sa,'/connections/respond',{id:(await p.connections.received(a))[0].id,action:'accept'})
  await p.post(sb,'/connections/remove',{id:(await p.connections.connections(b))[0].requestId})
  assert.equal((await p.connections.between(a,b)).state,'none')
})

test('Settings explicit choice is server validated, current grants get no nudge, missing records do not throw, and old grants do', async t => {
  const p=await site(t), s=await p.signIn('a')
  assert.match(s.text,/<input type="checkbox" name="access" value="connections">/);assert.doesNotMatch(s.text,/missing newer tools/)
  assert.equal((await p.post(s,'/setup-account',{access:'surprise'})).status,400)
  assert.equal((await p.post(s,'/setup-account',{write_scope:'yes'})).status,400)
  const enabled=await p.post(s,'/setup-account',{access:'connections'});assert.equal(enabled.status,200);assert.match(await enabled.text(),/connection actions enabled/)
  const issued=await p.grants.ensureGrant(a);assert.equal(issued.scope,ACCOUNT_WRITE_SCOPE)
  await p.post(s,'/setup-account',{});assert.equal((await p.grants.ensureGrant(a)).scope,'owner_network_and_public')
  const current=await p.grants.ensureGrant(a), record=p.resources.get(current.grantId);record.payload.version=2;record.payload.tools=[...ACCOUNT_GRANT_TOOL_VERSIONS[2].owner_network_and_public]
  const outdated=await(await p.go('/settings',{headers:{Cookie:s.cookie}})).text();assert.match(outdated,/missing newer tools/)
  const who=await(await p.agent(current.accessToken,'whoami')).json();assert.equal(who.grant.update.currentVersion,4);assert.ok(who.grant.update.missingTools.includes('unlinked_list_notifications'))
  assert.doesNotThrow(()=>renderSettings({agentAccess:undefined,grants:[]}))
  assert.doesNotMatch(renderPeople({everyone:profiles}).content,/ style=/)
})


test('accepted invite removal authorizes either participant, clears both accounts and allows a fresh request', async () => {
  const invites=createMemberInvitations({store:createMemoryInvitationStore()}), requests=createConnectionRequests({store:createMemoryConnectionStore()})
  const created=await invites.create({inviter:a,inviterName:'A',inviteeName:'B'})
  await invites.respond(created.token,b,'accept','B')
  const actions=createConnectionActions({memberConnections:requests,memberInvitations:invites,accountForProfile:async id=>id==='b'?b:a,readPublishedSnapshot:async()=>({state:'published',complete:true,revision:'r',profiles:profiles.slice(0,2),members:['a','b'],connections:[]})})
  const relation=await actions.relationTo(a,'b');assert.equal(relation.requestId,'invite:'+created.invitation.id)
  await assert.rejects(actions.remove(c,relation.requestId),{code:'connection_not_found'})
  await actions.remove(b,relation.requestId)
  assert.deepEqual(await invites.connections(a),[]);assert.deepEqual(await invites.connections(b),[])
  assert.equal((await invites.open(created.token)).status,'revoked')
  assert.equal((await actions.send(a,{profileId:'b'})).code,'sent')
})

test('web and agent requests share the daily budget, while reads use an independent budget', async t => {
  const p=await site(t), issued=await p.grants.issueGrant(b,undefined,{scope:ACCOUNT_WRITE_SCOPE})
  for(let i=0;i<50;i++) await p.connections.send({sender:b,recipient:{ownerId:'other-'+i,userId:'other-'+i},recipientName:'Other'})
  const denied=await p.agent(issued.accessToken,'connection-requests/send',{profileId:'a'})
  assert.equal(denied.status,429);assert.equal((await denied.json()).error.code,'rate_limited')
  assert.equal((await p.agent(issued.accessToken,'whoami')).status,200)
})


test('write relationship checks fail closed when imported graph or invite evidence cannot be read', async () => {
  const requests=createConnectionRequests({store:createMemoryConnectionStore()})
  const actions=createConnectionActions({memberConnections:requests,accountForProfile:async()=>b,ownProfileId:async()=> 'a',memberInvitations:{connections:async()=>{throw Error('invite_unavailable')}},readPublishedSnapshot:async()=>({state:'published',complete:true,revision:'r',profiles:profiles.slice(0,2),members:['a','b'],connections:[]})})
  await assert.rejects(actions.send(a,{profileId:'b'}),/invite_unavailable/)
  assert.equal((await requests.sent(a)).length,0)
})


test('removing either agreement kind ends all accepted agreements for only that pair', async () => {
  for (const selectedKind of ['invite', 'request']) {
    const invites = createMemberInvitations({ store: createMemoryInvitationStore() })
    const requests = createConnectionRequests({ store: createMemoryConnectionStore() })
    const sent = await requests.send({ sender: a, recipient: b })
    await requests.respond(b, sent.request.id, 'accept')
    const links = []
    for (const [inviter, invitee] of [[a, b], [b, a], [a, c]]) {
      const link = await invites.create({ inviter, inviterName: 'Member', inviteeName: 'Other' })
      await invites.respond(link.token, invitee, 'accept', 'Other')
      links.push(link)
    }
    const actions = createConnectionActions({ memberConnections: requests, memberInvitations: invites,
      accountForProfile: async id => ({ a, b, c })[id],
      readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'r', profiles: profiles.slice(0, 3), members: ['a', 'b', 'c'], connections: [] }) })
    const id = selectedKind === 'invite' ? `invite:${links[0].invitation.id}` : sent.request.id
    await assert.rejects(actions.remove(c, id), { code: 'connection_not_found' })
    assert.equal((await requests.between(a, b)).state, 'connected')
    assert.equal((await invites.connections(b)).length, 2)
    await actions.remove(b, id)
    assert.deepEqual(await requests.connections(a), [])
    assert.deepEqual(await requests.connections(b), [])
    assert.deepEqual(await invites.connections(b), [])
    assert.deepEqual((await invites.connections(a)).map(value => value.other), [c])
    assert.equal((await invites.open(links[0].token)).status, 'revoked')
    assert.equal((await invites.open(links[1].token)).status, 'revoked')
    assert.equal((await invites.open(links[2].token)).status, 'accepted')
    assert.equal((await actions.relationTo(a, 'b')).state, 'none')
    assert.equal((await actions.relationTo(b, 'a')).state, 'none')
    const reconnected = await actions.send(b, { profileId: 'a' })
    assert.equal(reconnected.code, 'sent')
    assert.notEqual(reconnected.request.id, sent.request.id)
  }
})

test('connected directory navigation retains its filter through modes, clear and pagination', () => {
  for (const mode of ['best', 'exact']) {
    const output = renderPeople({ connectedView: { rows: [], total: 0, nextPage: 2 }, presence: 'member', query: 'Alice', mode }).content
    const links = [...output.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(Best match|Exact words|Clear search|Show more)<\/a>/g)]
    assert.equal(links.length, 3)
    for (const [, href, label] of links) {
      const url = new URL(href.replaceAll('&amp;', '&'), 'https://unlinked.invalid')
      assert.equal(url.searchParams.get('connected'), '1', label)
      assert.equal(url.searchParams.get('presence'), 'member', label)
      assert.equal(url.searchParams.get('q'), label === 'Clear search' ? null : 'Alice', label)
      if (label === 'Exact words') assert.equal(url.searchParams.get('mode'), 'exact')
      if (label === 'Best match') assert.equal(url.searchParams.get('mode'), null)
    }
  }
  const output = renderPeople({ connectedView: { rows: [], total: 0, nextPage: 2 } }).content
  const href = output.match(/href="([^"]+)">Show more/)[1]
  assert.equal(new URL(href.replaceAll('&amp;', '&'), 'https://unlinked.invalid').searchParams.get('connected'), '1')
})
