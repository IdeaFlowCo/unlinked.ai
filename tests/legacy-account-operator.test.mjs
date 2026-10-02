import test from 'node:test'
import assert from 'node:assert/strict'
import { operateLegacyAccounts } from '../mcp-server/legacy-account-operator.mjs'
const source='21bf382c5bdd28a96193d2873c257e1acc6571a54f69b2a2286ddb6e09b78cd0'
test('operator seed requires all81 exact recovered public anchors; no owner/email authority from input',async()=>{
 let seeds=0,revokes=0
 const accounts=Array.from({length:81},(_,i)=>({profileId:'profile-'+i})), manifest={sourceSha256:source,accounts}
 const options={action:'seed',manifest,links:{seed:async value=>{assert.deepEqual(value,manifest);seeds++;return {count:81,replayed:false,manifestSha256:'test'}},revoke:async(p,r)=>{assert.equal(p,'exact-profile');assert.equal(r,'exact-receipt');revokes++}},publicPeople:{read:async()=>({state:'published',complete:true,revision:'legacy-public-v1:'+source,profiles:accounts.map(a=>({id:a.profileId}))})}}
 assert.equal((await operateLegacyAccounts(options)).ownerBindingsCreated,0);assert.equal(seeds,1)
 for(const change of [{manifest:{...manifest,accounts:accounts.slice(1)}},{manifest:{...manifest,sourceSha256:'x'}},{publicPeople:{read:async()=>null}},{publicPeople:{read:async()=>({state:'published',complete:true,revision:'legacy-public-v1:'+source,profiles:[]})}}]) await assert.rejects(operateLegacyAccounts({...options,...change}))
 assert.equal(seeds,1)
 assert.equal((await operateLegacyAccounts({...options,action:'revoke',profileId:'exact-profile',receiptId:'exact-receipt'})).revoked,true);assert.equal(revokes,1)
})
