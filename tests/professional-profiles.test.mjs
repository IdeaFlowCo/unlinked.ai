import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFESSIONAL_PEOPLE_DATASET, professionalProfileId, prepareProfessionalSnapshot } from '../src/utils/public-people/professional-profiles.mjs'
import { mergeProfessionalPublication } from '../mcp-server/publish-professional-people.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
const person = slug => ({id:professionalProfileId('https://www.linkedin.com/in/'+slug),name:'Public Person',linkedinUrl:'https://www.linkedin.com/in/'+slug,about:'Public biography',positions:[],education:[],skills:[]})
const prepare = rows => prepareProfessionalSnapshot(Buffer.from(JSON.stringify(rows)))
const legacy = {state:'published',complete:true,revision:'legacy:test',profiles:[],connections:[]}
test('offline professional publication rejects contact/private fields, guessed IDs and duplicate addresses',()=>{
 const valid=person('test-person');assert.equal(prepare([valid]).profiles[0].linkedinUrl,valid.linkedinUrl)
 for(const bad of [{...valid,email:'private@example.com'},{...valid,sourceRecords:[]},{...valid,ownerId:'owner'},{...valid,mentorList:'private'}, {...valid,id:'arbitrary'}, {...valid,linkedinUrl:'https://example.com/person'}, {...valid,positions:[{title:'Engineer',company:'Example',email:'private'}]}])assert.throws(()=>prepare([bad]))
 assert.throws(()=>prepare([valid,valid]))
})
test('batches append with stable IDs and replay without losing prior people',()=>{
 const a=prepare([person('one')]),b=prepare([person('two')]);const all=mergeProfessionalPublication(a,b)
 assert.equal(all.profiles.length,2);assert.deepEqual(all.connections,[])
 assert.deepEqual(mergeProfessionalPublication(all,b),all)
 assert.equal(mergeProfessionalPublication(all,prepare([{...person('two'),about:'Updated public biography'}])).profiles.length,2)
})
test('professional source creates anonymously readable profiles with no member identity or relationships',async()=>{
 const publication=prepare([person('new-person')]);
 const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>[],getBackend:async()=>{throw Error('no account reads')},professionalProfiles:true,publicPeople:{read:async dataset=>dataset===PROFESSIONAL_PEOPLE_DATASET?publication:null}})
 const snapshot=await read();assert.equal(snapshot.profiles.length,1);assert.deepEqual(snapshot.connections,[]);assert.deepEqual(snapshot.members??[],[])
 const reader=createPublicPeopleReader({readPublishedSnapshot:read});const result=await reader.lookup({ids:[person('new-person').id],details:true})
 assert.equal(result.get(person('new-person').id).about,'Public biography')
 assert.equal(snapshot.profiles[0].enrichmentStatus,'enriched')
})
test('revocation invalidates kept index and removes the professional profile',async()=>{
 let publication=prepare([person('revokable')]);let now=0
 const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>[],professionalProfiles:true,publicPeople:{read:async dataset=>dataset===PROFESSIONAL_PEOPLE_DATASET?publication:null},freshMs:10,now:()=>now})
 const before=await read();assert.equal(before.profiles.length,1);publication=null;now=11;const after=await read();assert.equal(after.profiles.length,0);assert.notEqual(before.revision,after.revision)
})
test('malformed or relationship-bearing source fails instead of exposing it',async()=>{
 for(const publication of [{...prepare([person('bad')]),connections:[{fromId:'private-list',toId:'person'}]},{...prepare([person('bad')]),revision:'unverified'}]){
  const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>[],professionalProfiles:true,publicPeople:{read:async dataset=>dataset===PROFESSIONAL_PEOPLE_DATASET?publication:null}})
  await assert.rejects(read(),/professional_snapshot_invalid/)
 }
})
test('same-address existing member remains the survivor and keeps their self-provided biography',async()=>{
 const member={...person('same-person'),id:'existing-member',about:'Member biography'}
 const read=createMemberPublicIndex({readLegacy:async()=>({...legacy,profiles:[member]}),readMembers:async()=>['existing-member'],readLegacyMembers:async()=>['existing-member'],discover:async()=>[],professionalProfiles:true,mergeSameLinkedin:true,publicPeople:{read:async dataset=>dataset===PROFESSIONAL_PEOPLE_DATASET?prepare([person('same-person')]):null}})
 const snapshot=await read();assert.equal(snapshot.profiles.length,1);assert.equal(snapshot.profiles[0].id,'existing-member');assert.equal(snapshot.profiles[0].about,'Member biography')
})
