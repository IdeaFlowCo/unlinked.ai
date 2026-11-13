import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { decode, exportGraph, exportSharedGraph, importGraph, verifyGraph, rollbackGraph } from '../deploy/private-pilot/graph-migration.mjs'

const enabled=process.env.UNLINKED_COMMUNITY_RECOVERY_TEST==='ephemeral-neo4j'
const exec=promisify(execFile)
const docker=(...args)=>exec('sudo',['docker',...args],{timeout:30000})
async function query(driver,cypher,params={}) {const s=driver.session();try{return await s.run(cypher,params)}finally{await s.close()}}
async function fixtures(t) {
 const neo4j=createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER),drivers=[],names=[]
 t.after(async()=>{
  await Promise.all(drivers.map(d=>d.close()))
  await Promise.all(names.map(name=>docker('rm','-f',name)))
 })
 for(const role of ['source','target']) {
  const name='unlinked-community-recovery-'+role+'-'+randomUUID();names.push(name)
  await docker('run','--rm','--pull=never','-d','--name',name,'--label','task.owner=native-community-chat-review',
   '--tmpfs','/data','--tmpfs','/logs','-p','127.0.0.1::7687',
   '-e','NEO4J_AUTH=neo4j/synthetic-community-test','-e','NEO4J_server_memory_heap_initial__size=128m',
   '-e','NEO4J_server_memory_heap_max__size=256m','-e','NEO4J_server_memory_pagecache_size=64m','neo4j:5.26.0')
  const port=(await docker('port',name,'7687/tcp')).stdout.trim().split(':').at(-1)
  const d=neo4j.driver('bolt://127.0.0.1:'+port,neo4j.auth.basic('neo4j','synthetic-community-test'),{connectionTimeout:1000,maxTransactionRetryTime:1000});drivers.push(d)
  const deadline=Date.now()+60000
  for(;;) {try{await d.verifyConnectivity();break}catch(error){if(Date.now()>deadline)throw error;await pause(500)}}
 }
 return {source:drivers[0],target:drivers[1],neo4j}
}

test('community outbox pending snapshots and minimal receipts survive actual shared recovery', {skip:!enabled,timeout:180000},async t=>{
 const {source,target,neo4j}=await fixtures(t)
 const {createNeo4jCollectiveGroupsStore}=await import('../mcp-server/collective-groups-store.mjs')
 const store=createNeo4jCollectiveGroupsStore(source)
 await store.initialize()
 const actor={ownerId:'synthetic-community-owner',userId:'synthetic-community-user'},id='dce52df1-421d-4a12-a4e7-ed4bf740e012'
 await store.create({id,name:'Recovery fixture',chatManaged:true,organizer:actor,members:[],invites:[],shares:[]})
 const snapshot={groupId:id,revision:1,name:'Recovery fixture',organizer:{issuer:'https://id.ideaflow.app/api/auth',subject:'fixture-subject',name:'Organizer'},members:[],deleted:false}
 await store.chatPrepare(id,1,snapshot,'pending-fingerprint')
 const original=JSON.parse(JSON.stringify(await exportGraph(source,neo4j)))
 assert.ok(original.schema.some(s=>s.labelsOrTypes[0]==='UnlinkedGroupChatJob'&&s.type==='UNIQUENESS'&&s.properties[0]==='id'))
 await importGraph(target,neo4j,original,'fixture-community-outbox')
 await verifyGraph(target,neo4j,original,'fixture-community-outbox')
 const recovered=createNeo4jCollectiveGroupsStore(target)
 assert.deepEqual((await recovered.chatJob(id)).lastSnapshot,snapshot)
 await recovered.chatFinish(id,1,{done:true})
 await recovered.change(id,()=>null)
 const tombstone=await recovered.chatJob(id)
 assert.deepEqual(tombstone.group,{id,name:'Deleted community'})
 const deletion={...snapshot,revision:2,name:'Deleted community',deleted:true}
 await recovered.chatPrepare(id,2,deletion,'deleted-fingerprint')
 await recovered.chatFinish(id,2,{done:true})
 const shared=JSON.parse(JSON.stringify(await exportSharedGraph(target,neo4j,'fixture-community-outbox')))
 const restored=decode(shared.nodes.find(n=>n.label==='UnlinkedGroupChatJob').properties,neo4j)
 assert.deepEqual(Object.keys(restored).sort(),['done','id','revision'])
 await assert.rejects(rollbackGraph(target,neo4j,original,'fixture-community-outbox'),/rollback_later_edit/)
 await query(source,'MATCH (n) DETACH DELETE n')
 await importGraph(source,neo4j,shared,'fixture-community-restored')
 await verifyGraph(source,neo4j,shared,'fixture-community-restored')
 const finalReceipt=await createNeo4jCollectiveGroupsStore(source).chatJob(id)
 assert.equal(finalReceipt.revision,2);assert.equal(finalReceipt.done,true)
 assert.equal(finalReceipt.group,undefined);assert.equal(finalReceipt.organizer,undefined)
})
