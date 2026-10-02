import {legacyStorageOwnerKey} from './storage-plan.mjs'
import {privateId} from '../private-import/job.mjs'
const same=(a,b)=>a&&b&&a.manifestSha256===b.manifestSha256&&a.receiptId===b.receiptId&&a.profileId===b.profileId&&a.legacyUserId===b.legacyUserId
const connectionFields=['first name','last name','url','company','position','connected on']
export function createLegacyStorageReader({owner,readOwner,assets,readLegacyProfile}) {
  if(!owner?.ownerId||!owner.userId||typeof readOwner!=='function'||typeof readLegacyProfile!=='function')throw Error('legacy_storage_identity_required')
  owner=Object.freeze({ownerId:owner.ownerId,userId:owner.userId})
  const current=async()=>{
    const value=await readOwner(owner.ownerId,owner.userId)
    if(!value)return null
    const profile=await readLegacyProfile()
    if(!profile||profile.receiptId!==value.receiptId||profile.profileId!==value.profileId||profile.sourceSha256!==value.sourceSha256)throw Error('legacy_storage_binding_changed')
    return value
  }
  const list=async()=>{const value=await current();if(!value)return null;return {...value,objects:value.objects.map(row=>({objectId:row.objectId,filename:row.sourceFields.name.split('/').at(-1),bytes:row.rawBytes,category:row.category,accepted:row.parsed.accepted,rejected:row.parsed.rejected,error:row.parsed.error}))}}
  const readOriginal=async objectId=>{
    const value=await current(),row=value?.objects.find(row=>row.objectId===objectId)
    if(!row)throw Error('legacy_storage_not_found')
    const bytes=await assets.get(legacyStorageOwnerKey(value.sourceSha256,value.legacyUserId),row.rawSha256)
    if(bytes.length!==row.rawBytes||!same(value,await current()))throw Error('legacy_storage_binding_changed')
    return bytes
  }
  const observations=async({signal,limit=100000}={})=>{
    const value=await current();if(!value)return null
    if(!Number.isSafeInteger(limit)||limit<0||limit>100000)throw Error('account_observation_limit')
    const count=value.objects.filter(row=>row.category==='connections').reduce((n,row)=>n+row.parsed.accepted,0)
    if(count>limit)throw Error('account_observation_limit')
    const rows=[]
    for(const object of value.objects) {
      signal?.throwIfAborted()
      if(object.category!=='connections'||!object.parsed.normalizedSha256)continue
      const bytes=await assets.get(legacyStorageOwnerKey(value.sourceSha256,value.legacyUserId),object.parsed.normalizedSha256)
      if(bytes.length!==object.parsed.normalizedBytes)throw Error('legacy_storage_normalized_invalid')
      const normalized=JSON.parse(bytes)
      if(normalized.version!==1||normalized.sourceSha256!==value.sourceSha256||normalized.objectId!==object.objectId||normalized.category!=='connections'||!Array.isArray(normalized.rows)||normalized.rows.length!==object.parsed.accepted)throw Error('legacy_storage_normalized_invalid')
      for(const row of normalized.rows) {
        if(row.category!=='connections'||typeof row.rowId!=='string'||!row.fields)throw Error('legacy_storage_normalized_invalid')
        rows.push({...row,id:privateId(owner.ownerId,'legacy-storage-row',value.sourceSha256,object.objectId,row.rowId),ownerId:owner.ownerId,sourceId:object.rawSha256,importId:privateId(owner.ownerId,'legacy-storage',value.manifestSha256),fields:Object.fromEntries(connectionFields.filter(key=>typeof row.fields[key]==='string').map(key=>[key,row.fields[key]])),provenance:{source:'recovered-legacy-storage-v1',sourceSha256:value.sourceSha256,storageZipSha256:value.storageZipSha256,objectId:object.objectId,sourceRowOrdinal:object.rowOrdinal}})
      }
    }
    signal?.throwIfAborted()
    if(!same(value,await current()))throw Error('legacy_storage_binding_changed')
    return {manifestSha256:value.manifestSha256,receiptId:value.receiptId,assertions:rows}
  }
  return {list,readOriginal,observations}
}
