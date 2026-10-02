import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import JSZip from 'jszip'
import {LEGACY_COLUMNS} from '../src/utils/legacy-import/postgres-copy.mjs'
import {createLegacyStoragePlan,publishLegacyStorage,legacyStorageOwnerKey} from '../src/utils/legacy-import/storage-plan.mjs'
import {createLegacyStorageReader} from '../src/utils/legacy-import/storage-reader.mjs'
import {createAccountNetwork} from '../src/utils/private-import/account-network.mjs'
import {createPrivateBrowserHandler} from '../mcp-server/private-browser.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const legacy=id(1),profile=id(2),unknown=id(3), owner={ownerId:'current-one',userId:'verified-one'}
const storageColumns=['id','bucket_id','name','owner','created_at','updated_at','last_accessed_at','metadata','version','owner_id','user_metadata']
const encode=v=>v===null||v===undefined?'\\N':String(v).replaceAll('\\','\\\\').replaceAll('\t','\\t').replaceAll('\n','\\n')
const copy=(table,columns,rows)=>`COPY ${table} (${columns.join(', ')}) FROM stdin;\n${rows.map(row=>columns.map(k=>encode(row[k])).join('\t')+'\n').join('')}\\.\n`
async function fixture(change={}){
  const files={ 'old/Connections.csv':Buffer.from('First Name,Last Name,URL,Email Address,Company,Position\nAda,Example,https://www.linkedin.com/in/ada-example,private@example.invalid,Research Co,Scientist\n'), 'old/Messages.csv':Buffer.from('private notes and original bytes\n'), 'unknown/Skills.csv':Buffer.from([0xff,0x00,0x01]),...change.files }
  const objects=Object.keys(files).map((name,i)=>({id:id(10+i),bucket_id:'private',name,owner:i<2?legacy:unknown,owner_id:i<2?legacy:unknown,metadata:JSON.stringify({size:files[name].length})}))
  const publicRows={profiles:[{id:profile,user_id:legacy,full_name:'Recovered Member'}],uploads:[{id:id(20),profile_id:change.uploadOwner??profile,file_path:'old/Connections.csv'}]}
  const database=Buffer.from(Object.entries(LEGACY_COLUMNS).map(([table,columns])=>copy('public.'+table,columns,publicRows[table]??[])).join('')+copy('storage.objects',storageColumns,change.objects??objects))
  const zip=new JSZip();for(const [name,bytes] of Object.entries(files))zip.file('export/private/'+name,bytes)
  for(const [name,bytes] of Object.entries(change.extra??{}))zip.file(name,bytes)
  const bytes=await zip.generateAsync({type:'nodebuffer'})
  return {database,bytes,files,plan:createLegacyStoragePlan(database,bytes)}
}
async function filesystem(t){
  const root=await mkdtemp(join(tmpdir(),'legacy-storage-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const assets={put:async(key,sha,bytes)=>{assert.equal(hash(bytes),sha);const dir=join(root,key);await mkdir(dir,{recursive:true,mode:0o700});await writeFile(join(dir,sha),bytes,{mode:0o600})},get:async(key,sha)=>{const bytes=await readFile(join(root,key,sha));assert.equal(hash(bytes),sha);return bytes}}
  return {root,assets}
}
function linked(plan,assets){
  let active=true,reads=0
  const value={sourceSha256:plan.manifest.sourceSha256,storageZipSha256:plan.manifest.storageZipSha256,manifestSha256:hash(JSON.stringify(plan.manifest)),receiptId:'confirmed-receipt',legacyUserId:legacy,profileId:profile,objects:plan.manifest.objects.filter(o=>o.legacyOwnerId===legacy)}
  const readOwner=async(ownerId,userId)=>{reads++;return active&&ownerId===owner.ownerId&&userId===owner.userId?value:null}
  const readLegacyProfile=async()=>active?{receiptId:value.receiptId,profileId:profile,sourceSha256:value.sourceSha256,revision:'snapshot',profiles:[],connections:[]}:null
  const reader=createLegacyStorageReader({owner,readOwner,assets,readLegacyProfile})
  return {reader,readOwner,readLegacyProfile,value,revoke:()=>{active=false},reads:()=>reads}
}
test('all exact objects and upload references survive; unsupported/invalid files stay private and professional JSON excludes contact fields',async()=>{
  const {plan,files}=await fixture()
  assert.deepEqual(plan.counts,{objects:3,rawBytes:Object.values(files).reduce((n,b)=>n+b.length,0),knownOwnerObjects:2,unmappedOwnerObjects:1,referencedObjects:1,uploads:1,matchedUploads:1,professionalFiles:2,accepted:1,rejected:0,failedFiles:1,otherFiles:1})
  for(const object of plan.manifest.objects)assert.ok(plan.assets.find(asset=>asset.ownerKey===legacyStorageOwnerKey(plan.manifest.sourceSha256,object.legacyOwnerId)&&asset.sha256===object.rawSha256).bytes.equals(files[object.sourceFields.name]))
  const normalized=plan.assets.find(asset=>asset.sha256===plan.manifest.objects[0].parsed.normalizedSha256)
  assert.equal(JSON.parse(normalized.bytes).rows[0].fields.company,'Research Co');assert.doesNotMatch(normalized.bytes.toString(),/private@example|email address/)
  assert.equal(plan.manifest.objects[2].legacyProfileId,null);assert.equal(plan.ownerBindingsCreated,0)
  await assert.rejects(fixture({extra:{'extra.csv':'not referenced'}}),/source_coverage/)
  await assert.rejects(fixture({uploadOwner:unknown}),/owner_mismatch/)
  const missing=await fixture();const zip=new JSZip();zip.file('export/private/old/Connections.csv',missing.files['old/Connections.csv'])
  const missingBytes=await zip.generateAsync({type:'nodebuffer'});assert.throws(()=>createLegacyStoragePlan(missing.database,missingBytes),/missing_or_ambiguous_blob/)
  assert.throws(()=>createLegacyStoragePlan(missing.database,Buffer.from('invalid')),/zip/)
  assert.throws(()=>createLegacyStoragePlan(missing.database,missing.bytes,{production:true}),/production_source_mismatch/)
  assert.throws(()=>createLegacyStoragePlan(missing.database,missing.bytes,{databaseGzipSha256:'invalid'}),/container_hash/)
})
test('filesystem originals recover after asset crash and lost publication response; fence follows verified assets and exact replay',async t=>{
  const {plan}=await fixture(),{root,assets}=await filesystem(t)
  let publications=0,document=null,puts=0
  const store={publish:async manifest=>{publications++;for(const asset of plan.assets)assert.ok((await assets.get(asset.ownerKey,asset.sha256)).equals(asset.bytes));const next=JSON.stringify(manifest);if(document&&document!==next)throw Error('conflict');document=next;return {manifestSha256:hash(next),replayed:publications>1}}}
  await assert.rejects(publishLegacyStorage({plan,store,assets:{...assets,put:async(...args)=>{await assets.put(...args);if(++puts===2)throw Error('crash_after_asset')}}}),/crash_after_asset/)
  assert.equal(publications,0)
  await assert.rejects(publishLegacyStorage({plan,store:{publish:async manifest=>{await store.publish(manifest);throw Error('lost_response')}},assets}),/lost_response/)
  const replay=await publishLegacyStorage({plan,store,assets});assert.equal(replay.replayed,true);assert.equal(replay.storedAssets,4);assert.equal(replay.counts.objects,3)
  for(const asset of plan.assets)assert.equal((await stat(join(root,asset.ownerKey,asset.sha256))).mode&0o077,0)
  await assert.rejects(publishLegacyStorage({plan,store,assets:{...assets,get:async()=>Buffer.from('corrupted')}}),/asset_readback/);assert.equal(publications,2)
})
test('confirmed same-owner recovery denies foreign/unknown originals, returns sanitized network rows and fences revocation during reads',async t=>{
  const {plan}=await fixture(),{assets}=await filesystem(t);await publishLegacyStorage({plan,assets,store:{publish:async()=>({})}})
  const link=linked(plan,assets),list=await link.reader.list();assert.equal(list.objects.length,2);assert.equal(list.objects[0].filename,'Connections.csv');assert.equal(list.objects[0].sourceFields,undefined)
  assert.ok((await link.reader.readOriginal(id(10))).equals(plan.assets.find(a=>a.sha256===plan.manifest.objects[0].rawSha256).bytes))
  await assert.rejects(link.reader.readOriginal(id(12)),/not_found/)
  const foreign=createLegacyStorageReader({owner:{ownerId:'foreign',userId:'foreign'},readOwner:link.readOwner,assets,readLegacyProfile:link.readLegacyProfile});assert.equal(await foreign.list(),null)
  const recovered=await link.reader.observations();assert.equal(recovered.assertions.length,1);assert.equal(recovered.assertions[0].ownerId,owner.ownerId);assert.equal(recovered.assertions[0].fields['email address'],undefined)
  const network=await createAccountNetwork({owner,getBackend:async()=>({listImportIds:async()=>[],readLegacyProfile:link.readLegacyProfile,readLegacyObservations:link.reader.observations})}).readNetwork();assert.equal(network.indexed,1);assert.equal(network.assertions[0].provenance.objectId,id(10))
  await assert.rejects(link.reader.observations({limit:0}),/observation_limit/)
  const delayed=createLegacyStorageReader({owner,readOwner:link.readOwner,readLegacyProfile:link.readLegacyProfile,assets:{get:async(...args)=>{const bytes=await assets.get(...args);link.revoke();return bytes}}})
  await assert.rejects(delayed.readOriginal(id(10)),/binding_changed/);assert.equal(await link.reader.list(),null)
})
test('actual browser recovery route requires session and same-owner publication; no raw file in anonymous output',async t=>{
  const {plan}=await fixture(),{assets}=await filesystem(t);await publishLegacyStorage({plan,assets,store:{publish:async()=>({})}});const link=linked(plan,assets)
  let handler;const server=createServer((req,res)=>void handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const endpoint=`http://127.0.0.1:${server.address().port}`,baseUrl=endpoint.replace('http:','https:')
  handler=createPrivateBrowserHandler({baseUrl,login:{begin:async()=>({location:'https://identity.invalid/login',transaction:{state:'state'}}),finish:async()=>({issuer:'https://identity.invalid',subject:'actual-signed-subject',verifiedEmail:'current@example.invalid'})},resolveOwner:async()=>owner,signup:async()=>owner,getBackend:async()=>({adapter:{},readResource:async()=>null,readLegacyFiles:link.reader.list,readLegacyOriginal:link.reader.readOriginal}),issueAccountGrant:async()=>{},revokeAccountGrant:async()=>{}})
  const request=(path,options={})=>fetch(endpoint+path,{redirect:'manual',...options})
  assert.equal((await request('/api/legacy-files')).status,401);assert.equal((await request('/legacy-files/'+id(10))).status,401)
  const begin=await request('/login'),callback=await request('/auth/callback/ideaflow?code=code&state=state',{headers:{Cookie:begin.headers.getSetCookie()[0].split(';')[0]}})
  const cookie=callback.headers.getSetCookie().find(value=>value.startsWith('__Host-ul-session=')).split(';')[0],headers={Cookie:cookie}
  const list=await request('/api/legacy-files',{headers});assert.equal(list.status,200);assert.equal((await list.json()).files.length,2)
  const raw=await request('/legacy-files/'+id(10),{headers});assert.equal(raw.status,200);assert.equal(raw.headers.get('Content-Type'),'application/octet-stream');assert.match(await raw.text(),/private@example.invalid/)
  assert.equal((await request('/legacy-files/'+id(12),{headers})).status,404)
  link.revoke();assert.equal((await request('/legacy-files/'+id(10),{headers})).status,404)
})
