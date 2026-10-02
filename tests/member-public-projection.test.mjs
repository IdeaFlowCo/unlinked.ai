import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberPublicIndex, projectPublicMemberImport } from '../src/utils/public-people/member-projection.mjs'
import { PUBLIC_UPLOAD_CONSENT, COMBINED_UPLOAD_CONSENT, hasCombinedUploadConsent } from '../src/utils/private-import/consent.mjs'
const id='a'.repeat(64), other='b'.repeat(64), source='c'.repeat(64)
const job={id,ownerId:'bound-owner',archiveSha256:source,consent:PUBLIC_UPLOAD_CONSENT,status:'indexed',counts:{accepted:2,indexed:2}}
const assertions=[{id:other,importId:id,ownerId:'bound-owner',category:'profile',fields:{'first name':'Test','last name':'Member',email:'private@test.invalid',phone:'private'}},{id:'d'.repeat(64),importId:id,ownerId:'bound-owner',category:'connections',fields:{'first name':'Test','last name':'Person',company:'Example',position:'Engineer',email:'secret@test.invalid',phone:'private',url:'https://www.linkedin.com/in/test'}}]
const legacy={state:'published',complete:true,revision:'legacy-v1',profiles:[{id:'legacy',name:'Legacy Person',positions:[],education:[],skills:[]}],connections:[]}

test('new upload action publishes professional rows only; old private consent and wrong owner/counts cannot publish',()=>{
 const result=projectPublicMemberImport({job,assertions})
 assert.equal(result.profiles.length,2);assert.equal(result.connections.length,1)
 assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('linkedin.com'))
 assert.equal(hasCombinedUploadConsent(PUBLIC_UPLOAD_CONSENT),true);assert.equal(hasCombinedUploadConsent(COMBINED_UPLOAD_CONSENT),true)
 for(const value of [{...job,consent:COMBINED_UPLOAD_CONSENT},{...job,status:'indexing'},{...job,counts:{accepted:3,indexed:2}}]) assert.throws(()=>projectPublicMemberImport({job:value,assertions}))
 assert.throws(()=>projectPublicMemberImport({job,assertions:[{...assertions[0],ownerId:'other'},assertions[1]]}))
})

test('public union uses only active exact-owner sources and drops retained cached chunks after tombstone/owner revocation',async()=>{
 let items=[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}],reads=0
 const cached=projectPublicMemberImport({job,assertions})
 const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>items,
 getBackend:async owner=>{assert.deepEqual(owner,items[0].owner);reads++;return{readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job})}},
 publicPeople:{read:async dataset=>{assert.equal(dataset,'public-import-'+id);return cached},publish:async()=>{throw Error('immutable cache must replay without write')}},})
 const before=await read();assert.equal(before.profiles.length,3);assert.equal(reads,1)
 items=[];const after=await read();assert.deepEqual(after.profiles,legacy.profiles);assert.notEqual(before.revision,after.revision)
})

test('delayed source removal fails the final shared publication read fence',async()=>{
 let calls=0
 const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>++calls===1?[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}]:[],
 getBackend:async()=>({readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job})}),publicPeople:{read:async()=>projectPublicMemberImport({job,assertions})}})
 await assert.rejects(read(),/public_member_source_changed/)
})

test('confirmed legacy member reuses existing profile; latest uploaded profile overlays only live read, revoke removes overlay',async()=>{
 const sourceSha='e'.repeat(64), recovered={...legacy,revision:'legacy-public-v1:'+sourceSha}, link={profileId:'legacy',sourceSha256:sourceSha,receiptId:'link-receipt',revision:'legacy-public-v1:'+sourceSha}
 let active=true
 const cached=projectPublicMemberImport({job,assertions})
 const read=createMemberPublicIndex({readLegacy:async()=>recovered,discover:async()=>[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}],getBackend:async()=>({readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job}),readLegacyProfile:async()=>active?link:null}),publicPeople:{read:async()=>cached}})
 const before=await read();assert.equal(before.profiles.length,2);assert.equal(before.profiles.find(p=>p.id==='legacy').name,'Test Member');assert.equal(before.connections[0].fromId,'legacy');assert.equal(cached.profiles[0].id,'member-import-'+id);assert.equal(recovered.profiles[0].name,'Legacy Person')
 active=false;const after=await read();assert.equal(after.profiles.find(p=>p.id==='legacy').name,'Legacy Person');assert.notEqual(before.revision,after.revision)
})
