import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createAssertionVerifier, createIdeaflowConnectorHandler } from '../mcp-server/ideaflow-connector.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createConnectionRequests, createMemoryConnectionStore } from '../mcp-server/member-connections.mjs'
import { createNotifications, createMemoryNotificationStore } from '../mcp-server/member-notifications.mjs'
import { coordinatorFor } from '../mcp-server/owner-coordination.mjs'
const secret = 'test-only-connector-secret-32-bytes-minimum'
const owner = { ownerId:'exact-owner', userId:'exact-local-user' }
function signed(body, changes = {}, key = secret) {
  const now = Math.floor(Date.now()/1000)
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')
  const payload = Buffer.from(JSON.stringify({iss:'https://id.ideaflow.app/connector',aud:'https://www.unlinked.ai/mcp',identity_issuer:'https://id.ideaflow.app/api/auth',sub:'opaque-subject',scope:'unlinked:read',iat:now,exp:now+60,jti:randomUUID(),body_sha256:createHash('sha256').update(body).digest('hex'),...changes})).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256',key).update(`${header}.${payload}`).digest('base64url')}`
}
test('assertions bind exact bytes, identity, audience, limited lifetime, scopes and one use', () => {
  const verify = createAssertionVerifier(secret), body = Buffer.from('{}'), token = signed(body)
  assert.equal(verify(token,body).sub,'opaque-subject'); assert.equal(verify(token,body),null)
  for(const changes of [{aud:'https://other.test/mcp'},{identity_issuer:'https://other.test'},{scope:'unlinked:write'},{scope:'unlinked:read vision:write'},{sub:''},{exp:0},{exp:Math.floor(Date.now()/1000)+70}]) assert.equal(verify(signed(body,changes),body),null)
  assert.equal(verify(signed(body,{},'wrong'),body),null)
  assert.equal(verify(signed(body),Buffer.from('{ }')),null)
  assert.equal(createAssertionVerifier('')(signed(body),body),null)
})

for (const pauseAt of ['identity', 'owner-lock']) {
  test(`connector mutation paused at ${pauseAt} cannot cross account deletion`, async t => {
    const coordination = coordinatorFor({}), recipient = { ownerId: 'recipient-owner', userId: 'recipient-user' }
    const notifications = createNotifications({ store: createMemoryNotificationStore() })
    const connections = createConnectionRequests({ store: createMemoryConnectionStore(), notifications, coordination, validateParticipant: async () => {} })
    const readPublishedSnapshot = async () => ({ state: 'published', complete: true, revision: 'connector-race', profiles: [{ id: 'recipient', name: 'Recipient', positions: [], education: [], skills: [] }], members: ['recipient'], connections: [] })
    const getBackend = async () => ({})
    const service = createAccountToolService({ getBackend, complete: async () => ({ matches: [] }), readPublishedSnapshot, coordination, memberConnections: connections, accountForProfile: async id => id === 'recipient' ? recipient : null })
    let entered, resume, pause = pauseAt === 'identity'
    const waiting = new Promise(resolve => { entered = resolve }), proceed = new Promise(resolve => { resume = resolve })
    const resolveOwner = async () => { if (pause) { pause = false; entered(); await proceed } return owner }
    if (pauseAt === 'owner-lock') {
      const run = coordination.run
      coordination.run = (...args) => { entered(); return run(...args) }
    }
    let handler
    const server = createServer((req, res) => void handler(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const host = `127.0.0.1:${server.address().port}`
    handler = createIdeaflowConnectorHandler({ secret, origin: `https://${host}`, resolveOwner, getBackend, complete: async () => ({}), readPublishedSnapshot, service, coordination })
    const request = async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unlinked_send_connection_request', arguments: { profileId: 'recipient' } } })
      const response = await fetch(`http://${host}/api/connector/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${signed(body, { scope: 'unlinked:read unlinked:write' })}` }, body })
      return response.json()
    }
    const release = await coordination.acquire('owner:' + owner.ownerId, true)
    const stale = request()
    await waiting
    coordination.deleted(owner.ownerId)
    release()
    if (pauseAt === 'identity') resume()
    const rejected = await stale
    assert.equal(rejected.result.isError, true)
    assert.equal(JSON.parse(rejected.result.content[0].text).error.code, 'grant_revoked')
    assert.deepEqual(await connections.received(recipient), [])
    assert.deepEqual(await notifications.list(recipient), [])
    const fresh = await request()
    assert.notEqual(fresh.result.isError, true)
    assert.equal((await connections.received(recipient)).length, 1)
    assert.equal((await notifications.list(recipient)).length, 1)
  })
}
test('hosted MCP reuses scoped tool catalog and exact live account binding without minting credentials', async t => {
  let linked = true, broken = false, resolved = [], calls = []
  const service = { call: async x => { calls.push(x); await x.revalidate(); return {text:JSON.stringify({ownerId:x.grant.ownerId})} } }
  let handler
  const server = createServer((req,res) => { Promise.resolve(handler(req,res)).catch(() => {res.writeHead(503).end()}) })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const host = `127.0.0.1:${server.address().port}`
  handler = createIdeaflowConnectorHandler({secret,origin:`https://${host}`,resolveOwner:async identity => { resolved.push(identity); if (broken) throw new Error('database-password-private'); return linked ? owner : null },getBackend:async()=>({}),complete:async()=>({}),readPublishedSnapshot:async()=>({people:[]}),service})
  const request = async (method,params,changes={},key=secret) => {
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method,...(params ? {params}: {})})
    const res=await fetch(`http://${host}/api/connector/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${signed(body,changes,key)}`},body})
    return {status:res.status,body:await res.json()}
  }
  const list=await request('tools/list'); assert.equal(list.status,200)
  assert.ok(list.body.result.tools.some(x=>x.name==='unlinked_whoami'))
  assert.ok(!list.body.result.tools.some(x=>x.name==='unlinked_send_connection_request'))
  assert.deepEqual(resolved[0],{issuer:'https://id.ideaflow.app/api/auth',subject:'opaque-subject'})
  const denied=await request('tools/call',{name:'unlinked_send_connection_request',arguments:{}})
  assert.ok(denied.body.error || denied.body.result?.isError); assert.equal(calls.length,0)
  const who=await request('tools/call',{name:'unlinked_whoami',arguments:{}})
  assert.equal(JSON.parse(who.body.result.content[0].text).ownerId,'exact-owner')
  const write=await request('tools/list',undefined,{scope:'unlinked:read unlinked:write'})
  assert.ok(write.body.result.tools.some(x=>x.name==='unlinked_send_connection_request'))
  assert.ok(!write.body.result.tools.some(x=>x.name==='unlinked_stage_investor_csv'))
  const privateList=await request('tools/list',undefined,{scope:'unlinked:read unlinked:private_notes'})
  assert.ok(privateList.body.result.tools.some(x=>x.name==='unlinked_stage_investor_csv'))
  assert.ok(!privateList.body.result.tools.some(x=>x.name==='unlinked_send_connection_request'))
  const privateCall=await request('tools/call',{name:'unlinked_stage_investor_csv',arguments:{csv:'Name\nMaya',mapping:{name:'Name'},listName:'Investors'}},{scope:'unlinked:read unlinked:private_notes'})
  assert.equal(privateCall.body.result.isError,undefined)
  assert.equal(calls.at(-1).name,'unlinked_stage_investor_csv')
  assert.equal((await request('tools/list',undefined,{},'wrong')).status,401)
  const sent=await request('tools/call',{name:'unlinked_send_connection_request',arguments:{profileId:'published-member'}},{scope:'unlinked:read unlinked:write'}); assert.equal(sent.body.result.isError,undefined); assert.equal(calls.at(-1).name,'unlinked_send_connection_request')
  linked=false; const unmapped=await request('tools/list'); assert.equal(unmapped.status,409); assert.equal(unmapped.body.error.message,'account_link_required')
  broken=true; const unavailable=await request('tools/list'); assert.equal(unavailable.status,503); assert.ok(!JSON.stringify(unavailable).includes('database-password-private'))
})
