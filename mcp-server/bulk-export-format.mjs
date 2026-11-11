import { once } from 'node:events'
export const EXPORT_FIELDS = Object.freeze(['id','profileId','name','headline','company','email','location','linkedinUrl','url','connectedAt','about','positions','education','skills','connections','notes','sourceRecords','source','detailLevel','enrichmentStatus'])
export const EXPORT_PRESETS = Object.freeze({ headline: ['id','name','headline'], summary: ['id','name','headline','company','email','location','linkedinUrl','connectedAt'], full: EXPORT_FIELDS })
export function exportFields(input) {
  const fields = input.fields?.length ? input.fields : EXPORT_PRESETS[input.detail ?? 'summary']
  if (!fields || !Array.isArray(fields) || fields.length > EXPORT_FIELDS.length || fields.some(key => !EXPORT_FIELDS.includes(key))) throw Error('bulk_export_input_invalid')
  return [...new Set(fields)]
}
// Quote every cell and neutralize formulas, including leading whitespace/control
// characters. JSON exports preserve the exact original string.
export const csvCell = value => {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"','""') + '"'
}
export async function writeBulkExport({ response, rows, input, metadata = {}, authorize, finish, signal }) {
  let fields = exportFields(input); const format = input.format ?? 'csv'
  if (!['csv','json','jsonl'].includes(format)) throw Error('bulk_export_input_invalid')
  const iterator = rows[Symbol.asyncIterator](), first = await iterator.next()
  if(format==='csv'&&fields.includes('sourceRecords')&&Array.isArray(metadata.sourceColumns))fields=[...fields,...metadata.sourceColumns.map(key=>'source.'+key)]
  await authorize()
  const write = async text => { signal?.throwIfAborted(); if (!response.write(text)) await once(response,'drain',{signal}) }
  const project = row => Object.fromEntries(fields.filter(key => Object.hasOwn(row,key)).map(key => [key,row[key]]))
  const name=String([metadata.name??input.scope??'mine',input.query?.trim()].filter(Boolean).join('-')).normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'people'
  response.writeHead(200, {...(metadata.profileDetails?{'X-Unlinked-Profile-Details':metadata.profileDetails}:{}),'Content-Type': {csv:'text/csv',json:'application/json',jsonl:'application/x-ndjson'}[format]+'; charset=utf-8','Content-Disposition':`attachment; filename="unlinked-${name}-${input.detail ?? 'summary'}.${format==='jsonl'?'jsonl':format}"`,'Cache-Control':'no-store, private','X-Robots-Tag':'noindex, nofollow, noarchive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Vary':'Cookie, Authorization'})
  let count=0
  try {
    if(format==='csv') await write('\uFEFF'+fields.map(csvCell).join(',')+'\r\n')
    else if(format==='json') await write(JSON.stringify({format:'unlinked-people-export',version:1,exportedAt:new Date().toISOString(),...metadata}).slice(0,-1)+',"rows":[')
    else await write(JSON.stringify({type:'export',format:'unlinked-people-export',version:1,...metadata})+'\n')
    for(let next=first;!next.done;next=await iterator.next()) {
      if(count%100===0) await authorize()
      const row=project(next.value)
      if(format==='csv')for(const key of fields.filter(key=>key.startsWith('source.'))){const original=key.slice(7);row[key]=(next.value.sourceRecords??[]).filter(record=>Object.hasOwn(record.fields??{},original)).map(record=>record.fields[original]).join('\n')}
      await write(format==='csv'?fields.map(key=>csvCell(row[key])).join(',')+'\r\n':format==='json'?(count?',':'')+JSON.stringify(row):JSON.stringify({type:'person',...row})+'\n')
      count++
    }
    await finish?.(); await authorize()
    if(format==='json') await write('],"complete":true,"count":'+count+'}')
    if(format==='jsonl') await write(JSON.stringify({type:'complete',count})+'\n')
    response.end()
    return {count,format}
  } finally { await iterator.return?.() }
}
