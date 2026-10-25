import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { createMemberBlocks, createMemoryBlockStore } from '../mcp-server/member-blocks.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const viewer = { ownerId: 'viewer', userId: 'viewer-user' }
const issuer = 'https://id.ideaflow.app/api/auth'
function fixture(blocks) {
  const owners = new Map(['ada','other-ada','removed','blocked','unclaimed'].map(id => [id, {ownerId:id,userId:id+'-user'}]))
  const state = { accepted: ['ada','other-ada','removed','blocked'], blocked: new Set(['blocked']), inactive: new Set(), hiddenProfiles: new Set(), rows: [] }
  state.rows = ['ada','other-ada','removed','blocked','unclaimed'].map(key => ({ id:hash(key),ownerId:viewer.ownerId,importId:hash('source'),sourceId:hash('source'),rowId:key,
    category:'connections',subject:'person:'+key,fields:{'first name':'Ada','last name':'Lovelace'},provenance:{source:'unlinked-connection',toId:key},connectedAt:1 }))
  const service = createAccountToolService({
    getBackend: async owner => {assert.deepEqual(owner,viewer);return {listImportIds:async()=>[],readLegacyObservations:async()=>({assertions:state.rows}),readLegacyProfile:async()=>null}},
    readPublishedSnapshot: async()=>({state:'published',complete:true,revision:'fixture',profiles:[...owners.keys()].map(id=>({id,name:'Ada Lovelace',positions:[],education:[],skills:[]})),connections:[]}),
    accountForProfile: async id => id==='unclaimed'?null:owners.get(id),
    memberConnections: {connections:async()=>state.accepted.map(id=>({other:owners.get(id)}))},
    memberBlocks: blocks ?? {hidden:async()=>({profiles:state.hiddenProfiles,users:new Set()}),between:async(a,b)=>{assert.deepEqual(a,viewer);return state.blocked.has(b.ownerId)}},
    connectionIdentityForOwner:async owner=>state.inactive.has(owner.ownerId)?null:{issuer,subject:owner.ownerId+'-subject'},
  })
  const grant={...viewer,scope:'owner_network',version:CURRENT_ACCOUNT_GRANT_VERSION,tools:[...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION,'owner_network')]}
  const read = async extra => (await service.call({grant,name:'unlinked_list_person_targets',input:{q:'Ada'},...extra})).result
  return {state,read,grant,service}
}
test('same names stay distinct through active exact ownership; blocks/unclaimed targets and private fields stay out',async()=>{
  const {read}=fixture(), result=await read()
  assert.deepEqual(result.people.map(p=>p.profileId).sort(),['ada','other-ada','removed'])
  assert.equal(new Set(result.people.map(p=>p.identity.subject)).size,3)
  for(const p of result.people) {assert.deepEqual(Object.keys(p).sort(),['connected','displayName','identity','profileId']);assert.equal(p.connected,true);assert.equal(p.identity.issuer,issuer)}
  assert.doesNotMatch(JSON.stringify(result), /email|phone|message|ownerId|userId/)
})
test('current removal and inactive ownership override stale accepted/import projections',async()=>{
  const {state,read}=fixture()
  state.accepted=state.accepted.filter(id=>id!=='removed');state.inactive.add('other-ada')
  assert.deepEqual((await read()).people.map(p=>p.profileId),['ada'])
  state.blocked.add('ada')
  assert.deepEqual((await read()).people,[])
})
test('owner scope, strict input, and read revalidation cannot be bypassed',async()=>{
  const {read,grant,service}=fixture()
  await assert.rejects(service.call({grant:{...grant,tools:[]},name:'unlinked_list_person_targets',input:{}}),{code:'scope_not_granted'})
  await assert.rejects(service.call({grant,name:'unlinked_list_person_targets',input:{ownerId:'other'}}),{code:'invalid_input'})
  let checks=0
  await assert.rejects(read({revalidate:async()=>{if(++checks===2)throw Error('revoked');return grant}}),/revoked/)
  assert.equal(checks,2)
})

test('profile-only blocks survive discovery of an account or a changed profile owner',async()=>{
  const blocks=createMemberBlocks({store:createMemoryBlockStore()})
  await blocks.block(viewer,{profileId:'ada',openChatUserId:'previously-unbound-inbox'})
  await blocks.block(viewer,{profileId:'other-ada',openChatUserId:'changed-owner-inbox'})
  await blocks.block(viewer,{profileId:'removed',openChatUserId:'other-inbox'})
  await blocks.block(viewer,{blocked:{ownerId:'blocked',userId:'blocked-user'},profileId:'blocked'})
  const {read}=fixture(blocks)
  assert.deepEqual((await read()).people,[])
})
