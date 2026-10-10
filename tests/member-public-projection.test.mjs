import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
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
 publicPeople:{read:async dataset=>{if(dataset===ENRICHMENT_DATASET)return null;assert.equal(dataset,'public-import-'+id);return cached},publish:async()=>{throw Error('immutable cache must replay without write')}},})
 const before=await read();assert.equal(before.profiles.length,3);assert.equal(reads,1)
 items=[];const after=await read();assert.deepEqual(after.profiles,legacy.profiles);assert.notEqual(before.revision,after.revision)
})

test('delayed source removal fails the final shared publication read fence',async()=>{
 let calls=0
 const read=createMemberPublicIndex({readLegacy:async()=>legacy,discover:async()=>++calls===1?[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}]:[],
 getBackend:async()=>({readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job})}),publicPeople:{read:async dataset=>dataset===ENRICHMENT_DATASET?null:projectPublicMemberImport({job,assertions})}})
 await assert.rejects(read(),/public_member_source_changed/)
})

test('legacy upgrade during final asynchronous reads rejects the retired signup projection and rebuilds', async t => {
  for (const stage of ['members', 'invitations', 'decisions', 'decisions-without-members']) {
    await t.test(stage, async () => {
      const signupSource = { owner: { ownerId: 'bound-owner', userId: 'bound-user' }, receiptId: 'signup-receipt',
        profile: { id: 'member-signup-test', name: 'Signup Person', positions: [], education: [], skills: [] } }
      let retired = false, claimed = [], paused = false, enter, release
      const entered = new Promise(resolve => { enter = resolve })
      const resumed = new Promise(resolve => { release = resolve })
      const pause = async phase => {
        if (phase !== stage || paused) return
        paused = true
        enter()
        await resumed
      }
      const read = createMemberPublicIndex({
        readLegacy: async () => legacy, discover: async () => [],
        publicPeople: { read: async () => null },
        readSignupProfiles: async () => retired ? [] : [signupSource],
        readMembers: stage === 'decisions-without-members' ? undefined : async () => { await pause('members'); return claimed },
        readInviteEdges: async () => { await pause('invitations'); return [] },
        readDecisions: async () => { await pause(stage === 'decisions-without-members' ? stage : 'decisions'); return [] },
      })
      const pending = read()
      const rejected = assert.rejects(pending, /public_member_source_changed/)
      await entered
      retired = true
      claimed = ['legacy']
      release()
      await rejected
      const rebuilt = await read()
      assert.deepEqual(rebuilt.profiles, legacy.profiles)
      assert.ok(!rebuilt.profiles.some(row => row.id === signupSource.profile.id))
      if (stage !== 'decisions-without-members') assert.deepEqual(rebuilt.members, ['legacy'])
      assert.equal(signupSource.receiptId, 'signup-receipt')
    })
  }
})

test('confirmed legacy member reuses existing profile; latest uploaded profile overlays only live read, revoke removes overlay',async()=>{
 const sourceSha='e'.repeat(64), recovered={...legacy,profiles:legacy.profiles.map(profile=>({...profile,linkedinUrl:'https://www.linkedin.com/in/legacy-person'})),revision:'legacy-public-v1:'+sourceSha}, link={profileId:'legacy',sourceSha256:sourceSha,receiptId:'link-receipt',revision:'legacy-public-v1:'+sourceSha}
 let active=true
 const cached=projectPublicMemberImport({job,assertions})
 const read=createMemberPublicIndex({readLegacy:async()=>recovered,discover:async()=>[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}],getBackend:async()=>({readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job}),readLegacyProfile:async()=>active?link:null}),publicPeople:{read:async dataset=>dataset===ENRICHMENT_DATASET?null:cached}})
 const before=await read();assert.equal(before.profiles.length,2);assert.equal(before.profiles.find(p=>p.id==='legacy').name,'Test Member');assert.equal(before.profiles.find(p=>p.id==='legacy').linkedinUrl,'https://www.linkedin.com/in/legacy-person');assert.equal(before.connections[0].fromId,'legacy');assert.equal(cached.profiles[0].id,'member-import-'+id);assert.equal(recovered.profiles[0].name,'Legacy Person')
 active=false;const after=await read();assert.equal(after.profiles.find(p=>p.id==='legacy').name,'Legacy Person');assert.notEqual(before.revision,after.revision)
})

test('curated enrichment refreshes legacy rows by id, never adds people, and a linked member upload still wins',async()=>{
 const sourceSha='e'.repeat(64), recovered={state:'published',complete:true,revision:'legacy-public-v1:'+sourceSha,profiles:[{id:'legacy',name:'Legacy Person',headline:'Stale headline',positions:[],education:[],skills:[]},{id:'bare',name:'Bare Person',positions:[],education:[],skills:[]}],connections:[]}
 const fresh={id:'legacy',name:'Legacy Person',headline:'Fresh headline',positions:[{title:'CEO',company:'Example'}],education:[],skills:['Sailing']}
 let enrichment={state:'published',complete:true,revision:ENRICHMENT_DATASET+':'+'f'.repeat(64),profiles:[fresh,{id:'unknown',name:'Not In Legacy',positions:[],education:[],skills:[]}],connections:[]}
 const read=createMemberPublicIndex({readLegacy:async()=>recovered,discover:async()=>[],getBackend:async()=>{throw Error('unused')},publicPeople:{read:async dataset=>dataset===ENRICHMENT_DATASET?enrichment:null}})
 const value=await read()
 assert.equal(value.profiles.length,2)
 assert.deepEqual(value.profiles.find(p=>p.id==='legacy'),fresh)
 assert.equal(value.profiles.find(p=>p.id==='bare').name,'Bare Person')
 assert.ok(!value.profiles.some(p=>p.id==='unknown'))
 enrichment=null;const without=await read();assert.equal(without.profiles.find(p=>p.id==='legacy').headline,'Stale headline');assert.notEqual(value.revision,without.revision)
 // A linked member's own upload overlays the enriched row.
 enrichment={state:'published',complete:true,revision:ENRICHMENT_DATASET+':'+'f'.repeat(64),profiles:[fresh],connections:[]}
 const link={profileId:'legacy',sourceSha256:sourceSha,receiptId:'link-receipt',revision:'legacy-public-v1:'+sourceSha}
 const cached=projectPublicMemberImport({job,assertions})
 const linked=createMemberPublicIndex({readLegacy:async()=>recovered,discover:async()=>[{id,owner:{ownerId:'bound-owner',userId:'bound-user'},revision:4}],getBackend:async()=>({readResource:async()=>({sourceId:id,sourceOwnerId:'bound-owner',sourceRevision:4,payload:job}),readLegacyProfile:async()=>link}),publicPeople:{read:async dataset=>dataset===ENRICHMENT_DATASET?enrichment:cached}})
 const overlaid=await linked();assert.equal(overlaid.profiles.find(p=>p.id==='legacy').name,'Test Member')
 for(const broken of [{...enrichment,connections:[{fromId:'legacy',toId:'legacy'}]},{...enrichment,revision:'other-dataset-v1:'+'f'.repeat(64)},{...enrichment,state:'staging'}]) {
  const bad=createMemberPublicIndex({readLegacy:async()=>recovered,discover:async()=>[],getBackend:async()=>{throw Error('unused')},publicPeople:{read:async dataset=>dataset===ENRICHMENT_DATASET?broken:null}})
  await assert.rejects(bad(),/public_enrichment_invalid/)
 }
})

test('an account that published several imports keeps one member profile: the newest, with the older ones folded in', async () => {
  const older = 'e'.repeat(64), newer = 'f'.repeat(64), other = '1'.repeat(64)
  const job = (jobId, owner, createdAt) => ({ id: jobId, ownerId: owner, archiveSha256: source, consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: 2, indexed: 2 }, createdAt })
  const rows = (jobId, owner, connectionId) => [{ id: other.slice(0, 63) + jobId[0], importId: jobId, ownerId: owner, category: 'profile', fields: { 'first name': 'Efe', 'last name': 'Zaladin' } }, { id: connectionId, importId: jobId, ownerId: owner, category: 'connections', fields: { 'first name': 'Test', 'last name': 'Person' } }]
  const jobs = { [older]: job(older, 'efe-owner', 1), [newer]: job(newer, 'efe-owner', 2), [other]: job(other, 'someone', 3) }
  const snapshots = { [older]: projectPublicMemberImport({ job: jobs[older], assertions: rows(older, 'efe-owner', 'a'.repeat(64)) }), [newer]: projectPublicMemberImport({ job: jobs[newer], assertions: rows(newer, 'efe-owner', 'b'.repeat(64)) }), [other]: projectPublicMemberImport({ job: jobs[other], assertions: rows(other, 'someone', 'c'.repeat(64)) }) }
  const items = [older, newer, other].map(jobId => ({ id: jobId, owner: { ownerId: jobs[jobId].ownerId, userId: jobs[jobId].ownerId + '-user' }, revision: 1 }))
  const read = createMemberPublicIndex({ readLegacy: async () => legacy, discover: async () => items, readMembers: async () => [],
    getBackend: async owner => ({ readResource: async (type, jobId) => ({ sourceId: jobId, sourceOwnerId: owner.ownerId, sourceRevision: 1, payload: jobs[jobId] }) }),
    publicPeople: { read: async dataset => dataset === ENRICHMENT_DATASET ? null : snapshots[dataset.slice('public-import-'.length)], publish: async () => { throw Error('cached') } } })
  const result = await read()
  assert.deepEqual(result.members, ['member-import-' + other, 'member-import-' + newer])
  assert.deepEqual(result.aliases, { ['member-import-' + older]: 'member-import-' + newer })
  assert.ok(!result.profiles.some(value => value.id === 'member-import-' + older))
  // The older import's connection now hangs off the account's one profile.
  assert.ok(result.connections.some(edge => edge.fromId === 'member-import-' + newer && edge.toId === 'public-' + 'a'.repeat(64)))
})

test('a fresh index serves page views without re-reading sources; expiry, revocation and empty builds restore live reads', async () => {
  let clock = 0, discovers = 0, items = [{ id, owner: { ownerId: 'bound-owner', userId: 'bound-user' }, revision: 4 }]
  let legacySnapshot = legacy
  const cached = projectPublicMemberImport({ job, assertions })
  const read = createMemberPublicIndex({ freshMs: 20000, now: () => clock,
    readLegacy: async () => legacySnapshot, discover: async () => { discovers++; return items },
    getBackend: async () => ({ readResource: async () => ({ sourceId: id, sourceOwnerId: 'bound-owner', sourceRevision: 4, payload: job }) }),
    publicPeople: { read: async dataset => dataset === ENRICHMENT_DATASET ? null : cached } })
  const first = await read()
  assert.equal(first.profiles.length, 3); assert.equal(discovers, 2)
  // Every page view inside the window reuses the kept build and reads nothing.
  items = []
  const held = await read()
  assert.equal(held, first); assert.equal(discovers, 2)
  // Expiry makes the revocation visible on the next read.
  clock = 20000
  const rebuilt = await read()
  assert.deepEqual(rebuilt.profiles, legacy.profiles); assert.equal(discovers, 4)
  // An empty build is not kept, and it drops the kept one: a revoked legacy
  // publication never serves from the window.
  clock = 40000
  legacySnapshot = null
  assert.equal(await read(), null)
  legacySnapshot = legacy
  assert.notEqual(await read(), null); assert.equal(discovers, 6)
  // Reads that overlap a build still share it.
  clock = 80000
  const [one, two] = await Promise.all([read(), read()])
  assert.equal(one, two); assert.equal(discovers, 8)
  for (const freshMs of [-1, 0.5, 300001]) assert.throws(() => createMemberPublicIndex({ freshMs, readLegacy: async () => legacy, discover: async () => [], publicPeople: { read: async () => null } }), /public_member_index_freshness_invalid/)
})

test('inside the stale window the kept index answers while one refresh runs behind it; a failed refresh fails closed', async () => {
  let clock = 0, discovers = 0, failRefresh = false
  let items = [{ id, owner: { ownerId: 'bound-owner', userId: 'bound-user' }, revision: 4 }]
  const cached = projectPublicMemberImport({ job, assertions })
  const read = createMemberPublicIndex({ freshMs: 1000, staleMs: 10000, now: () => clock,
    readLegacy: async () => legacy, discover: async () => { if (failRefresh) throw Error('refresh_failed'); discovers++; return items },
    getBackend: async () => ({ readResource: async () => ({ sourceId: id, sourceOwnerId: 'bound-owner', sourceRevision: 4, payload: job }) }),
    publicPeople: { read: async dataset => dataset === ENRICHMENT_DATASET ? null : cached } })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const first = await read()
  assert.equal(first.profiles.length, 3); assert.equal(discovers, 2)
  // Stale: answered from the kept build, one refresh behind it.
  clock = 5000
  items = []
  const stale = await read()
  assert.equal(stale, first)
  await settle()
  assert.equal(discovers, 4)
  // The refresh result serves the next read without another build.
  const refreshed = await read()
  assert.deepEqual(refreshed.profiles, legacy.profiles); assert.equal(discovers, 4)
  // Past the stale window a read waits for the rebuild.
  clock = 20000
  const blocked = await read()
  assert.deepEqual(blocked.profiles, legacy.profiles); assert.equal(discovers, 6)
  // A failed refresh serves the kept build once, then fails closed.
  clock = 26000
  failRefresh = true
  assert.equal(await read(), blocked)
  await settle()
  failRefresh = false
  const rebuilt = await read()
  assert.notEqual(rebuilt, blocked); assert.equal(discovers, 8)
  for (const staleMs of [-1, 0.5, 600001, 500]) assert.throws(() => createMemberPublicIndex({ freshMs: 1000, staleMs, readLegacy: async () => legacy, discover: async () => [], publicPeople: { read: async () => null } }), /public_member_index_freshness_invalid/)
})
