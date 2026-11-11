import { createHash } from 'node:crypto'
import { investorJobsForAccount, investorReceiptId, INVESTOR_JOB_KIND } from '../src/utils/private-import/investor-job.mjs'
import { parseInvestorFile } from '../src/utils/private-import/investor-file.mjs'

// Recover original selected-sheet columns only for successful import receipts
// whose person is STILL in this owner's live list. No name/email matching.
export async function bulkListSources({owner,backend,listId,memberIds,signal,authorize}) {
  const found=new Map(),columns=new Set(),{jobs}=await investorJobsForAccount(owner.ownerId,backend)
  for(const resource of jobs){
    const job=resource.payload
    if(job.listId!==listId)continue
    signal?.throwIfAborted();await authorize()
    const bytes=await backend.readAsset(job.sourceDigest)
    if(createHash('sha256').update(bytes).digest('hex')!==job.sourceDigest)throw Error('bulk_list_source_digest_mismatch')
    const parsed=parseInvestorFile(bytes,job.source,job.mapping),rows=[...parsed.accepted,...parsed.rejected].sort((a,b)=>a.row-b.row)
    let index=0
    await Promise.all(Array.from({length:Math.min(8,rows.length)},async()=>{
      while(index<rows.length){
        const ordinal=index++,row=rows[ordinal];signal?.throwIfAborted()
        const receipt=await backend.readResource('import',investorReceiptId(owner.ownerId,job.id,ordinal)),value=receipt?.payload
        if(!receipt||receipt.deleted||receipt.sourceOwnerId!==owner.ownerId||value?.kind!==INVESTOR_JOB_KIND+'_row'||value.importId!==job.id||value.ordinal!==ordinal||value.result?.status!=='imported'||!memberIds.has(value.result.entityId))continue
        const record={importId:job.id,importedAt:job.createdAt,row:row.row,fields:row.fields??{},profile:{name:row.name,headline:row.title??'',company:row.company??'',email:row.email??'',linkedinUrl:row.linkedinUrl??''},...(job.source?.selectedSheet?{sheet:job.source.selectedSheet.name??job.source.sheet}:{})}
        for(const key of Object.keys(record.fields))columns.add(key)
        found.set(value.result.entityId,[...(found.get(value.result.entityId)??[]),record])
      }
    }))
  }
  for(const records of found.values())records.sort((a,b)=>(b.importedAt??0)-(a.importedAt??0)||a.importId.localeCompare(b.importId)||a.row-b.row)
  return {records:found,columns:[...columns].sort()}
}
