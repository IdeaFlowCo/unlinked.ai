import test from 'node:test'
import assert from 'node:assert/strict'
import { operateLegacyAccounts } from '../mcp-server/legacy-account-operator.mjs'
import { assertProductionLegacyAccountManifest, legacyAccountManifestSha256, validateLegacyAccountManifest } from '../mcp-server/legacy-account-manifest.mjs'
const source='21bf382c5bdd28a96193d2873c257e1acc6571a54f69b2a2286ddb6e09b78cd0'
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12,'0')}`
const hex = value => String(value).padStart(64,'0')
const accounts = () => Array.from({length:81},(_,i)=>({legacyUserId:uuid(i + 1),profileId:uuid(i + 1001),emailHash:hex((i + 1).toString(16)),userOrdinal:i + 1,profileOrdinal:i + 101}))
test('operator seed requires all81 exact recovered public anchors; no owner/email authority from input',async()=>{
 let seeds=0,revokes=0
 const rows=accounts(), manifest={version:1,sourceSha256:source,accounts:rows}
 const options={action:'seed',manifest,links:{seed:async value=>{assert.deepEqual(value,manifest);seeds++;return {count:81,replayed:false,manifestSha256:'test'}},revoke:async(p,r)=>{assert.equal(p,'exact-profile');assert.equal(r,'exact-receipt');revokes++}},publicPeople:{read:async()=>({state:'published',complete:true,revision:'legacy-public-v1:'+source,profiles:rows.map(a=>({id:a.profileId}))})}}
 assert.equal((await operateLegacyAccounts(options)).ownerBindingsCreated,0);assert.equal(seeds,1)
 for(const change of [{manifest:{...manifest,accounts:rows.slice(1)}},{manifest:{...manifest,sourceSha256:'x'}},{manifest:{...manifest,accounts:[{...rows[0],legacyUserId:rows[1].legacyUserId},...rows.slice(1)]}},{manifest:{...manifest,accounts:[{...rows[0],email:'raw@example.com'},...rows.slice(1)]}},{publicPeople:{read:async()=>null}},{publicPeople:{read:async()=>({state:'published',complete:true,revision:'legacy-public-v1:'+source,profiles:[]})}}]) await assert.rejects(operateLegacyAccounts({...options,...change}))
 assert.equal(seeds,1)
 assert.equal((await operateLegacyAccounts({...options,action:'revoke',profileId:'exact-profile',receiptId:'exact-receipt'})).revoked,true);assert.equal(revokes,1)
})

test('legacy account manifest validation is exact, bounded and canonicalized',()=>{
 const manifest={version:1,sourceSha256:source,accounts:accounts()}
 assert.equal(validateLegacyAccountManifest(manifest),manifest)
 assert.equal(legacyAccountManifestSha256(manifest),legacyAccountManifestSha256({...manifest,accounts:[...manifest.accounts].reverse()}))
 assert.throws(()=>assertProductionLegacyAccountManifest(manifest),/complete_verified_legacy_manifest_required/)
 for (const bad of [
  {...manifest,version:2},
  {...manifest,unexpected:true},
  {...manifest,accounts:manifest.accounts.map((account,i)=>i===0?{...account,emailHash:'x'.repeat(64)}:account)},
  {...manifest,accounts:manifest.accounts.map((account,i)=>i===0?{...account,userOrdinal:0}:account)},
  {...manifest,accounts:manifest.accounts.map((account,i)=>i===0?{...account,email:'raw@example.com'}:account)},
  {...manifest,accounts:manifest.accounts.map((account,i)=>i===0?{...account,profileId:manifest.accounts[1].profileId}:account)},
 ]) assert.throws(()=>validateLegacyAccountManifest(bad),/complete_verified_legacy_manifest_required/)
})
