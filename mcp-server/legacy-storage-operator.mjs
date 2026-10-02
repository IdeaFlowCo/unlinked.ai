import {readFile,stat} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {createLegacyStoragePlan,publishLegacyStorage} from '../src/utils/legacy-import/storage-plan.mjs'

async function main() {
  const root='/srv/unlinked-private-guest-pilot-20261001',action=process.argv[2]
  if(!['publish','revoke'].includes(action)||action==='publish'&&process.argv.length!==5||action==='revoke'&&process.argv.length!==4)throw Error('legacy_storage_arguments_invalid')
  const require=createRequire(root+'/runtime/noos/package.json'),neo4j=require('neo4j-driver'),{UnlinkedLegacyStorageStore}=require(root+'/runtime/noos/dist/operational/legacy-storage.js'),{StagingFileAssets}=require(root+'/runtime/noos/dist/operational/assets.js')
  const driver=neo4j.driver('bolt://graph:7687',neo4j.auth.basic('neo4j',process.env.NOOS_PRIVATE_PASSWORD),{connectionTimeout:3000,connectionAcquisitionTimeout:5000,maxTransactionRetryTime:10000})
  try {
    const store=new UnlinkedLegacyStorageStore(driver,'neo4j','operator');await store.initialize()
    if(action==='revoke'){await store.revoke(process.argv[3]);console.log(JSON.stringify({action,revoked:true}));return}
    for(const [path,limit] of [[process.argv[3],8*1024*1024],[process.argv[4],64*1024*1024]]){const info=await stat(path);if(!info.isFile()||info.size>limit||info.size<1)throw Error('legacy_storage_source_limit')}
    const gz=await readFile(process.argv[3]);if(gz.length>8*1024*1024)throw Error('legacy_storage_database_limit')
    const plan=createLegacyStoragePlan(gunzipSync(gz,{maxOutputLength:64*1024*1024}),await readFile(process.argv[4]),{production:true,databaseGzipSha256:createHash('sha256').update(gz).digest('hex')})
    const receipt=await publishLegacyStorage({plan,store,assets:new StagingFileAssets(root+'/assets'),signal:AbortSignal.timeout(300000)})
    console.log(JSON.stringify({...receipt,at:new Date().toISOString(),sourceSha256:plan.manifest.sourceSha256,storageZipSha256:plan.manifest.storageZipSha256}))
  }finally{await driver.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('legacy_storage_operation_failed\n');process.exitCode=1})
