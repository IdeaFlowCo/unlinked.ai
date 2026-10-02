import {createHash} from 'node:crypto'
import {parseLegacyCopy,decodeCopyField} from './postgres-copy.mjs'
import {unpackArchive,parseSource} from '../private-import/archive.mjs'

export const LEGACY_STORAGE_DATABASE_SHA='21bf382c5bdd28a96193d2873c257e1acc6571a54f69b2a2286ddb6e09b78cd0'
export const LEGACY_STORAGE_ZIP_SHA='b5c249834c7cd0303ecbfbd086f016745b5e7c359ce7cd8e92aafffe2b22a89b'
const hash=value=>createHash('sha256').update(value).digest('hex')
const columns=['id','bucket_id','name','owner','created_at','updated_at','last_accessed_at','metadata','version','owner_id','user_metadata']
const allowed={connections:['first name','last name','url','company','position','connected on'],profile:['first name','last name','headline','summary','industry','location'],positions:['company name','title','description','started on','finished on','location'],education:['school name','degree name','started on','finished on'],skills:['name']}
export const legacyStorageOwnerKey=(sourceSha256,legacyOwnerId)=>hash(JSON.stringify(['unlinked-legacy-storage-v1',sourceSha256,legacyOwnerId]))

// Exact storage.objects COPY only; security/auth tables are never decoded.
function storageObjects(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),result=[]
  let names=null,seen=false
  for(const original of text.split('\n')) {
    const line=original.endsWith('\r')?original.slice(0,-1):original
    if(Buffer.byteLength(line)>2*1024*1024)throw Error('legacy_storage_line_limit')
    if(names) {
      if(line==='\\.'){names=null;continue}
      if(result.length>=2000)throw Error('legacy_storage_object_limit')
      const fields=line.split('\t');if(fields.length!==names.length)throw Error('legacy_storage_copy_width')
      result.push({fields:Object.fromEntries(names.map((name,index)=>[name,decodeCopyField(fields[index])])),rowOrdinal:result.length+1});continue
    }
    const match=/^COPY storage\.objects \((.*)\) FROM stdin;$/.exec(line)
    if(!match)continue
    if(seen)throw Error('legacy_storage_duplicate_table')
    seen=true;names=match[1].split(',').map(x=>x.trim().replace(/^"|"$/g,''))
    if(names.length!==columns.length||new Set(names).size!==names.length||names.some(name=>!columns.includes(name)))throw Error('legacy_storage_columns_invalid')
  }
  if(!seen||names)throw Error('legacy_storage_source_incomplete')
  return result
}

export function createLegacyStoragePlan(databaseBytes,zipBytes,{databaseGzipSha256='0'.repeat(64),production=false}={}) {
  const parsed=parseLegacyCopy(databaseBytes),sourceSha256=parsed.sourceSha256,storageZipSha256=hash(zipBytes)
  if(!/^[a-f0-9]{64}$/.test(databaseGzipSha256))throw Error('legacy_storage_container_hash_invalid')
  if(production&&(sourceSha256!==LEGACY_STORAGE_DATABASE_SHA||storageZipSha256!==LEGACY_STORAGE_ZIP_SHA))throw Error('legacy_storage_production_source_mismatch')
  const objects=storageObjects(databaseBytes),entries=unpackArchive(zipBytes,'storage.zip'),used=new Set(),assets=new Map(),owners=new Map()
  for(const profile of parsed.tables.profiles)if(profile.user_id){if(owners.has(profile.user_id))throw Error('legacy_storage_ambiguous_owner');owners.set(profile.user_id,profile.id)}
  const rows=[],counts={objects:0,rawBytes:0,knownOwnerObjects:0,unmappedOwnerObjects:0,referencedObjects:0,uploads:parsed.tables.uploads.length,matchedUploads:0,professionalFiles:0,accepted:0,rejected:0,failedFiles:0,otherFiles:0},matched=new Set()
  const add=(ownerKey,sha256,bytes)=>{const key=ownerKey+':'+sha256;if(assets.has(key)&&!assets.get(key).bytes.equals(bytes))throw Error('legacy_storage_hash_conflict');assets.set(key,{ownerKey,sha256,bytes})}
  for(const {fields,rowOrdinal} of objects) {
    const suffix=fields.bucket_id+'/'+fields.name,matches=entries.filter(entry=>entry.path===suffix||entry.path.endsWith('/'+suffix))
    if(matches.length!==1||used.has(matches[0].path))throw Error('legacy_storage_missing_or_ambiguous_blob')
    const entry=matches[0];used.add(entry.path)
    const legacyOwnerId=fields.owner_id??fields.owner
    if(!legacyOwnerId||fields.owner&&fields.owner_id&&fields.owner!==fields.owner_id)throw Error('legacy_storage_owner_conflict')
    const legacyProfileId=owners.get(legacyOwnerId)??null,ownerKey=legacyStorageOwnerKey(sourceSha256,legacyOwnerId),rawSha256=hash(entry.bytes)
    add(ownerKey,rawSha256,entry.bytes)
    const references=parsed.tables.uploads.filter(row=>row.file_path===fields.name||row.file_path===suffix||row.file_path?.endsWith('/'+suffix)||row.file_path?.endsWith('/'+fields.name))
    for(const row of references){if(owners.get(legacyOwnerId)!==row.profile_id)throw Error('legacy_storage_upload_owner_mismatch');matched.add(row.id)}
    const basename=fields.name.split('/').at(-1),match=/(?:^|[-_])(Connections|Profile|Positions|Education|Skills)\.csv$/i.exec(basename)
    const category=match?match[1].toLowerCase():'other_csv'
    let receipt={accepted:0,rejected:0,error:'unsupported_category',normalizedSha256:null,normalizedBytes:0}
    if(match) {
      const canonical=category[0].toUpperCase()+category.slice(1)+'.csv',result=parseSource({path:canonical,bytes:entry.bytes})
      receipt={...receipt,accepted:result.accepted.length,rejected:result.rejected.length,error:result.error??null}
      if(!result.error){const normalized=Buffer.from(JSON.stringify({version:1,objectId:fields.id,sourceSha256,category,rows:result.accepted.map(row=>({...row,fields:Object.fromEntries(allowed[category].filter(key=>typeof row.fields[key]==='string').map(key=>[key,row.fields[key]]))}))}));receipt.normalizedSha256=hash(normalized);receipt.normalizedBytes=normalized.length;add(ownerKey,receipt.normalizedSha256,normalized)}
    }
    rows.push({objectId:fields.id,legacyOwnerId,legacyProfileId,rowOrdinal,rawSha256,rawBytes:entry.bytes.length,category,sourceFields:fields,parsed:receipt})
    counts.objects++;counts.rawBytes+=entry.bytes.length;counts[legacyProfileId?'knownOwnerObjects':'unmappedOwnerObjects']++;counts.referencedObjects+=Number(references.length>0);counts[match?'professionalFiles':'otherFiles']++;counts.accepted+=receipt.accepted;counts.rejected+=receipt.rejected;counts.failedFiles+=Number(match&&!!receipt.error)
  }
  counts.matchedUploads=matched.size
  if(used.size!==entries.length||matched.size!==parsed.tables.uploads.length||production&&(rows.length!==592||matched.size!==181))throw Error('legacy_storage_source_coverage_incomplete')
  const manifest={version:1,sourceSha256,databaseGzipSha256,storageZipSha256,objects:rows.sort((a,b)=>a.objectId.localeCompare(b.objectId))}
  if(Buffer.byteLength(JSON.stringify(manifest))>1024*1024)throw Error('legacy_storage_manifest_limit')
  return {manifest,assets:[...assets.values()],counts,ownerBindingsCreated:0}
}

export async function publishLegacyStorage({plan,assets,store,signal}) {
  for(const asset of plan.assets){signal?.throwIfAborted();await assets.put(asset.ownerKey,asset.sha256,asset.bytes)}
  // Lost/crashed uploads are replayable. No publication before every referenced
  // original and normalized asset is read back from the actual private store.
  for(const asset of plan.assets){signal?.throwIfAborted();const bytes=await assets.get(asset.ownerKey,asset.sha256);if(!bytes.equals(asset.bytes))throw Error('legacy_storage_asset_readback_mismatch')}
  signal?.throwIfAborted()
  const receipt=await store.publish(plan.manifest)
  return {...receipt,counts:plan.counts,storedAssets:plan.assets.length,ownerBindingsCreated:0}
}
