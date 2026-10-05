import test from 'node:test'
import assert from 'node:assert/strict'
import { publicLinkedinUrl, linkedinUrlFromSlug, publicWebsite, withLegacyProfileDetails } from '../src/utils/public-people/profile-links.mjs'
import { createMemberPublicIndex, projectPublicMemberImport } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { applyProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { renderPerson, renderCompany, renderOwnProfile } from '../mcp-server/private-onboarding-views.mjs'

const person = { id: 'legacy', name: 'Test Person', positions: [], education: [], skills: [] }
const sha = 'c'.repeat(64)
const legacy = { state:'published', complete:true, revision:'legacy-public-v1:'+sha, profiles:[person], connections:[] }

test('exact legacy manifest projects LinkedIn and industry without account metadata; mismatches cannot enrich', () => {
  const manifest = {sourceSha256:sha, profiles:[{legacyId:'legacy',linkedinSlug:'test-person',industry:'Research',legacyUserId:'private-user',email:'private-email'}]}
  const result = withLegacyProfileDetails(legacy,manifest)
  assert.equal(result.profiles[0].linkedinUrl,'https://www.linkedin.com/in/test-person')
  assert.equal(result.profiles[0].industry,'Research')
  assert.doesNotMatch(JSON.stringify(result),/private-user|private-email/)
  assert.equal(withLegacyProfileDetails(legacy,{...manifest,sourceSha256:'d'.repeat(64)}),legacy)
  assert.equal(legacy.profiles[0].linkedinUrl,undefined)
})

test('links require the professional URL grammar and credential-free HTTPS, and unsafe values never become anchors', async () => {
  assert.equal(publicLinkedinUrl('https://linkedin.com/in/test-person/'),'https://www.linkedin.com/in/test-person')
  assert.equal(linkedinUrlFromSlug('test-person'),'https://www.linkedin.com/in/test-person')
  for (const value of ['javascript:alert(1)','https://linkedin.com.evil.test/in/foo','https://www.linkedin.com/company/foo','https://u:p@www.linkedin.com/in/foo','https://www.linkedin.com/in/foo?email=private']) assert.equal(publicLinkedinUrl(value),null)
  for (const value of ['bad/slug','bad?slug','bad#slug',' bad']) assert.equal(linkedinUrlFromSlug(value),null)
  for (const value of ['javascript:alert(1)','http://example.test','https://u:p@example.test']) assert.equal(publicWebsite(value),null)
  const profile = {...person,linkedinUrl:'javascript:alert(1)',website:'https://u:p@example.test'}
  const reader = createPublicPeopleReader({readPublishedSnapshot:async()=>({...legacy,profiles:[profile]})})
  const detail = (await reader.profile({id:'legacy'})).profile
  assert.equal(detail.linkedinUrl,undefined); assert.equal(detail.website,undefined)
  assert.doesNotMatch(renderPerson({profile}).content,/href="javascript:|href="https:\/\/u:p/)
})

test('anonymous, member and own headers show links, company and other professional details; company links precede its About', async () => {
  const profile = {...person,linkedinUrl:'https://www.linkedin.com/in/test-person',website:'https://example.test',company:'Example Co',industry:'Research',email:'PRIVATE_EMAIL',phone:'PRIVATE_PHONE',about:'Public biography',education:[{institution:'Test School',degree:'Test Degree'}]}
  const reader = createPublicPeopleReader({readPublishedSnapshot:async()=>({...legacy,profiles:[profile]})})
  const detail = (await reader.profile({id:'legacy'})).profile
  assert.equal(detail.company,'Example Co'); assert.equal(detail.industry,'Research')
  assert.equal(detail.linkedinUrl,profile.linkedinUrl); assert.equal(detail.website,'https://example.test/')
  assert.doesNotMatch(JSON.stringify(detail),/PRIVATE_EMAIL|PRIVATE_PHONE/)
  for (const view of [renderPerson({profile:detail}),renderPerson({profile:detail,csrf:'test'}),renderOwnProfile({profile:detail,csrf:'test'})]) {
    assert.match(view.content,/href="https:\/\/www.linkedin.com\/in\/test-person" target="_blank" rel="noopener noreferrer"/)
    assert.match(view.content,/href="\/companies\/Example%20Co"/)
    assert.ok(view.content.indexOf('LinkedIn profile ↗')<view.content.indexOf('<h3>About'))
    assert.match(view.content,/Test School<\/b><br>Test Degree/)
  }
  const company = renderCompany({name:'Example Co',facts:{website:'https://example.test',linkedinUrl:'https://www.linkedin.com/company/example',description:'Public description'}}).content
  assert.ok(company.indexOf('Website ↗')<company.indexOf('<h3>About'))
  assert.ok(company.indexOf('LinkedIn page ↗')<company.indexOf('<h3>About'))
  assert.equal((company.match(/Website ↗/g)??[]).length,1)
})

test('existing immutable imports gain retained links and dates via scoped reads, cache only until live removal', async () => {
  const id='a'.repeat(64), rowId='b'.repeat(64), ownRowId='d'.repeat(64), positionId='e'.repeat(64)
  const owner={ownerId:'owner',userId:'user'}
  const assertions=[{id:ownRowId,importId:id,ownerId:'owner',category:'profile',fields:{'first name':'Own','last name':'Person'}},
    {id:rowId,importId:id,ownerId:'owner',category:'connections',subject:'https://www.linkedin.com/in/test-contact',fields:{'first name':'Test','last name':'Contact',company:'Example Co',position:'Researcher',email:'PRIVATE_EMAIL'}},
    {id:positionId,importId:id,ownerId:'owner',category:'positions',fields:{title:'Researcher','company name':'Example Co','started on':'2020','finished on':'2025'}}]
  const job={id,ownerId:'owner',archiveSha256:sha,status:'indexed',consent:PUBLIC_UPLOAD_CONSENT,counts:{accepted:3,indexed:3,rejected:0,skippedFiles:0,failedFiles:0},assertionIds:assertions.map(row=>row.id)}
  const cached=projectPublicMemberImport({job,assertions}), original=JSON.stringify(cached)
  let items=[{id,owner,revision:4}], assertionReads=0
  const backend={readResource:async(type,key)=>{
    if(type==='import')return{sourceOwnerId:'owner',sourceRevision:4,payload:job}
    assertionReads++;return{sourceOwnerId:'owner',payload:assertions.find(row=>row.id===key)}
  }}
  const read=createMemberPublicIndex({includeDetails:true,readLegacy:async()=>legacy,discover:async()=>items,getBackend:async()=>backend,publicPeople:{read:async dataset=>dataset==='public-import-'+id?cached:null,publish:async()=>{throw Error('must not republish')}}})
  const first=await read(), linked=first.profiles.find(row=>row.id==='public-'+rowId)
  assert.equal(linked.linkedinUrl,'https://www.linkedin.com/in/test-contact')
  assert.equal(first.profiles.find(row=>row.id==='member-import-'+id).positions[0].startDate,'2020')
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE_EMAIL/)
  const reads=assertionReads; await read();assert.equal(assertionReads,reads)
  assert.equal(JSON.stringify(cached),original)
  items=[]; const removed=await read();assert.deepEqual(removed.profiles,legacy.profiles)
  items=[{id,owner,revision:4}];await read();assert.ok(assertionReads>reads)
})

test('identity merges preserve a retained LinkedIn address', async () => {
  const linked={...person,linkedinUrl:'https://www.linkedin.com/in/test-person'}
  const merged=applyProfileDecisions({...legacy,profiles:[person,{...linked,id:'imported'}]},[{id:'merge',kind:'merge',profileId:'imported',survivorId:'legacy'}])
  assert.equal(merged.profiles[0].linkedinUrl,linked.linkedinUrl)
})
