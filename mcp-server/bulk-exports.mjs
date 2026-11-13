import { createMembersOnlySnapshotReader } from '../src/utils/public-people/members-only.mjs'
import { bulkListSources } from './bulk-list-sources.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { peopleFilters, PEOPLE_FILTER_KEYS, matchesPeopleFilters } from '../src/utils/public-people/search-filters.mjs'
import { rowSlug, rowPublicTarget, groupConnectionRows, rowProvenanceType } from './connection-identity.mjs'
import { exportFields, writeBulkExport } from './bulk-export-format.mjs'

const fail = (code,message) => Object.assign(Error(message),{code})
const text = value => typeof value==='string'?value:''
export function bulkExportInput(value = {}) {
  if(value instanceof URLSearchParams && value.has('inline'))throw fail('invalid_input','inline is a query-tool option, not a file-download option.')
  const raw = value instanceof URLSearchParams ? Object.fromEntries(value) : value
  const allowed=['inline','scope','q','query','ids','listId','format','detail','fields','presence','mode',...PEOPLE_FILTER_KEYS]
  if(!raw||typeof raw!=='object'||Object.keys(raw).some(key=>!allowed.includes(key)) || value instanceof URLSearchParams && [...new Set(value.keys())].some(key=>value.getAll(key).length!==1)) throw fail('invalid_input','Invalid download options.')
  const ids=Array.isArray(raw.ids)?raw.ids:text(raw.ids).split(/[\s,]+/).filter(Boolean), fields=Array.isArray(raw.fields)?raw.fields:text(raw.fields).split(',').filter(Boolean)
  const input={scope:raw.scope||'mine',query:raw.query??raw.q??'',format:raw.format||'csv',detail:raw.detail||'summary',ids:[...new Set(ids)],fields:[...new Set(fields)],...(raw.listId?{listId:raw.listId}:{}),...(raw.presence?{presence:raw.presence}:{}),mode:raw.mode||'exact',filters:peopleFilters(raw)}
  if(!['mine','everyone','all','list'].includes(input.scope)||!['csv','json','jsonl'].includes(input.format)||!['headline','summary','full'].includes(input.detail)||!['exact','best'].includes(input.mode)||typeof input.query!=='string'||input.query.length>200||ids.length>10000||ids.some(id=>typeof id!=='string'||!id||id.length>160)||!['member','legacy','shadow',undefined].includes(input.presence)||input.scope==='list'&&(!/^(?:private:[A-Za-z0-9_-]{1,80}|saved:[a-f0-9-]{36})$/.test(input.listId??''))||input.scope!=='list'&&input.listId) throw fail('invalid_input','Invalid download options.')
  if(input.scope==='list'&&input.filters.degree)throw fail('invalid_input','Connection degree filters apply to network downloads. Remove degree to download a list.')
  if (bulkExportParams(input).toString().length > 12000) throw fail('invalid_input','The selected IDs exceed the download URL size. Use filters or download the whole selection instead.')
  try { exportFields(input) } catch { throw fail('invalid_input','Invalid download fields.') }
  return input
}
export function bulkExportParams(input) {
  const p=new URLSearchParams({scope:input.scope,format:input.format,detail:input.detail})
  for(const [key,value] of Object.entries({q:input.query,listId:input.listId,ids:input.ids?.join(','),fields:input.fields?.join(','),presence:input.presence,mode:input.mode,...input.filters})) if(value)p.set(key,value)
  return p
}
export const bulkDownloadHref = input => '/downloads?'+bulkExportParams(input)
const normalized=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
const queryMatches=(row,query)=>{
  if(!query.trim())return true
  const cells=[]
  const visit=value=>{if(typeof value==='string'||typeof value==='number')cells.push(String(value));else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit)}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Omit identity and projection metadata from searchable text; handle source fields separately.
  const {source,sourceRecords,connections,id,profileId,url,detailLevel,enrichmentStatus,notes,...values}=row
  visit(values);visit(notes?.map(note=>typeof note==='string'?note:note.text));visit(sourceRecords?.map(record=>record.fields))
  const haystack=normalized(cells.join('\n')),terms=[...normalized(query).matchAll(/"([^"]+)"|(\S+)/g)].map(match=>match[1]??match[2])
  return terms.every(term=>haystack.includes(term))
}
const summaryOf = row => ({id:row.id,name:row.name,headline:row.headline??'',company:row.company??row.positions?.[0]?.company??'',location:row.location??'',linkedinUrl:row.linkedinUrl??'',url:row.profileId?`https://www.unlinked.ai/people/${encodeURIComponent(row.profileId)}`:row.source?.kind==='own_network'?`https://www.unlinked.ai/network/contacts/${encodeURIComponent(row.id)}`:row.source?.kind==='private_list'?'':row.id?`https://www.unlinked.ai/people/${encodeURIComponent(row.id)}`:'',detailLevel:row.detailLevel??'basic',enrichmentStatus:row.enrichmentStatus??'unknown',...row})
export function createBulkExports({getBackend,readPublishedSnapshot,lookupSlug,ownProfileId,privateLists,savedSearchLists,isVerified=async()=>false}) {
  const membersSnapshot=typeof readPublishedSnapshot==='function'?createMembersOnlySnapshotReader(readPublishedSnapshot):undefined
  const check = async(owner,input,policy={})=>{
    await getBackend(owner)
    if(['everyone','all'].includes(input.scope)&&(!policy.publicAllowed||!await isVerified(owner)))throw fail('scope_not_granted','A verified account with public-network access is required for this download.')
    if(input.scope==='list'&&!policy.privateAllowed)throw fail('scope_not_granted','Private people notes & relations permission is required to download private lists.')
  }
  const manifest=async(owner,raw,policy,signal,authorizeCaller)=>{
    const input=bulkExportInput(raw);await check(owner,input,policy)
    const params=bulkExportParams(input).toString()
    const result = {kind:'unlinked_export',scope:input.scope,format:input.format,detail:input.detail,fields:exportFields(input),selection:'all_matching_people',truncated:false,download:{url:'https://www.unlinked.ai/downloads/file?'+params,apiUrl:'https://www.unlinked.ai/api/agent/v1/export?'+params,authentication:owner.grantId?.startsWith('ideaflow:')?'Browser session for url. apiUrl requires a direct Unlinked account key; the shared connector token remains at its gateway. No token is included in these links.':'Browser session for url; same direct Unlinked account bearer for apiUrl. No token is included in these links.'},guidance:'One download streams the whole result, including all internal pages. JSON and JSON Lines finish with a completion marker. Full profiles contain available evidence only.'}
    if (raw.inline === true) {
      const authorize=async()=>{signal?.throwIfAborted();await authorizeCaller?.();await check(owner,input,policy)}
      const source=await open(owner,input,policy,signal,authorize), fields=exportFields(input)
      let rows=[],bytes=0,total=0,overflow=false
      for await(const row of source.rows){
        if(total%100===0)await authorize()
        const projected=Object.fromEntries(fields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])),size=Buffer.byteLength(JSON.stringify(projected))
        total++
        if(!overflow&&bytes+size<=768*1024){rows.push(projected);bytes+=size}
        else if(!overflow){overflow=true;rows=rows.slice(0,20)}
      }
      await source.finish()
      return {...result,kind:'unlinked_query',rows,total,complete:!overflow,truncated:overflow,...(overflow?{reason:'response_size_limit',guidance:'The full result exceeds the safe inline response size. This preview is incomplete; one authenticated download returns every matching row.'}:{})}
    }
    return result
  }
  async function open(owner,input,policy,signal,authorize) {
    await check(owner,input,policy)
    const metadata={}
    const full=exportFields(input).some(key=>['about','positions','education','skills','connections','notes','sourceRecords'].includes(key))
    const reader=createPublicPeopleReader({readPublishedSnapshot:policy.membersOnly?membersSnapshot:readPublishedSnapshot,pageSize:100,reuse:false}), selected=new Set(input.ids)
    const viewer={signedIn:true,...(typeof ownProfileId==='function'?{id:await ownProfileId(owner)??undefined}:{})}
    const own=['mine','all'].includes(input.scope)||input.filters.degree||input.scope==='list'&&input.listId.startsWith('saved:')?await createAccountNetwork({owner,getBackend}).readNetwork(undefined,{signal}):null
    const ownRows=own?.assertions.filter(row=>row.category==='connections')??[], ownIndex=new Map(ownRows.map((row,index)=>[row.id,index]))
    let publicMatches
    const matches=async()=>{
      if(publicMatches)return publicMatches
      if(!full&&!input.query.trim()&&!input.presence&&!Object.keys(input.filters).length&&!input.ids.length)return publicMatches=ownRows.map(()=>null)
      try {
      const direct=await lookup([...new Set(ownRows.map(rowPublicTarget).filter(Boolean))])
      const unresolved=ownRows.filter(row=>!direct.has(rowPublicTarget(row))), slugs=[...new Set(unresolved.map(rowSlug).filter(Boolean))], resolved=new Map()
      if(typeof lookupSlug==='function'){
        let index=0
        await Promise.all(Array.from({length:Math.min(8,slugs.length)},async()=>{while(index<slugs.length){const slug=slugs[index++];signal?.throwIfAborted();const id=await lookupSlug(slug);if(id)resolved.set(slug,id)}}))
      }
      const more=await lookup([...new Set(resolved.values())])
      return publicMatches=ownRows.map(row=>direct.get(rowPublicTarget(row))??more.get(resolved.get(rowSlug(row)))??null)
      } catch(error) {
        if(input.scope==='mine'&&!input.presence&&!input.filters.degree&&!input.ids.length&&!signal?.aborted){metadata.profileDetails='unavailable';return publicMatches=ownRows.map(()=>null)}
        throw error
      }
    }
    const lookup=async ids=>{const result=new Map();for(let at=0;at<ids.length;at+=1000){await authorize();for(const [id,row]of await reader.lookup({ids:ids.slice(at,at+1000),details:true,signal}))result.set(id,row)}return result}
    const wanted=row=>(!input.presence||row.presence===input.presence)&&(!selected.size||selected.has(row.id)||selected.has(row.profileId)||row.source?.assertionIds?.some(id=>selected.has(id)))&&queryMatches(row,input.query)&&matchesPeopleFilters(row,input.filters)
    let lastRevision=null, listFence=null
    async function* imported(rows=ownRows) {
      if (input.filters.degree && input.filters.degree !== '1') return
      const all=await matches()
      const {groups}=await groupConnectionRows(rows,rows.map(row=>({id:row.id,provenance:{type:rowProvenanceType(row)}})))
      for(const group of groups){const row=rows[group[0]];signal?.throwIfAborted();const index=ownIndex.get(row.id),profile=all[index],fields=row.fields??{},name=[fields['first name'],fields['last name']].filter(Boolean).join(' ')||profile?.name||''
        const record=summaryOf({...profile,id:row.id,...(profile?.id?{profileId:profile.id}:{}),name:name||profile?.name||'',headline:fields.position||profile?.headline||'',company:fields.company||profile?.company||'',linkedinUrl:fields.url||profile?.linkedinUrl||'',connectedAt:row.connectedAt??fields['connected on']??'',source:{kind:'own_network',assertionId:row.id,assertionIds:group.map(index=>rows[index].id),importId:row.importId}})
        // An agent's network scope never acquires raw archive contact fields.
        if(policy.browser&&typeof fields['email address']==='string')record.email=fields['email address']
        if(policy.browser&&full)record.sourceRecords=group.map(index=>({assertionId:rows[index].id,importId:rows[index].importId,fields:rows[index].fields??{}}))
        if((!input.presence||profile?.presence===input.presence)&&wanted(record))yield record
      }
    }
    async function* published() {
      let cursor
      const seeds=input.filters.degree?(await matches()).filter(Boolean).map(row=>row.id):undefined
      const unlistedGroup=viewer.id?await reader.unlistedGroup({id:viewer.id,signal}):null
      do{
        await authorize()
        const page=await reader.exportPage({viewer,query:input.query,ids:input.ids,filters:input.filters,presence:input.presence,mode:input.mode,...(seeds?{networkSeeds:seeds,networkSelf:viewer.id}:{}),...(unlistedGroup?{unlistedGroups:[unlistedGroup]}:{}),cursor,signal})
        if(lastRevision&&page.revision!==lastRevision)throw fail('upstream_unavailable','The network changed while downloading. Retry for a complete copy.')
        lastRevision=page.revision
        for(const profile of page.profiles)yield summaryOf({...profile,connections:page.connections.filter(edge=>edge.fromId===profile.id).map(edge=>edge.toId),source:{kind:'published_network',revision:page.revision}})
        cursor=page.nextCursor
      }while(cursor)
    }
    async function readMembers(id){
      if(!privateLists)throw fail('upstream_unavailable','Private lists are unavailable.')
      const members=[],seen=new Set();let after,name
      do{await authorize();const page=await privateLists.get(owner,id,after,{bulk:true});name??=page.list.name;members.push(...page.members);if(page.nextCursor&&seen.has(page.nextCursor))throw fail('upstream_unavailable','The list returned a repeated cursor.');after=page.nextCursor;if(after)seen.add(after)}while(after)
      return {name,members:[...new Map(members.map(row=>[row.id,row])).values()]}
    }
    async function* list(){
      const [kind,id]=input.listId.split(':')
      if(kind==='saved'){
        const saved=await savedSearchLists?.get(owner,id);if(!saved)throw fail('not_found','This list is not available to this account.')
        metadata.name=saved.name
        listFence=async()=>{const current=await savedSearchLists.get(owner,id);if(!current||JSON.stringify(current.refs)!==JSON.stringify(saved.refs))throw fail('upstream_unavailable','The list changed during download.')}
        const publicIds=saved.refs.filter(ref=>ref.startsWith('public:')).map(ref=>ref.slice(7)),found=await lookup(publicIds)
        for(const profile of found.values()){const row=summaryOf({...profile,source:{kind:'saved_list',listId:id}});if(wanted(row))yield row}
        const contactIds=new Set(saved.refs.filter(ref=>ref.startsWith('contact:')).map(ref=>ref.slice(8)))
        yield* imported(ownRows.filter(row=>contactIds.has(row.id)))
      }else{
        const first=await readMembers(id),ids=first.members.map(row=>row.id).sort()
        metadata.name=first.name
        listFence=async()=>{const last=await readMembers(id);if(JSON.stringify(last.members.map(row=>row.id).sort())!==JSON.stringify(ids))throw fail('upstream_unavailable','The list changed during download.')}
        const found=await lookup(first.members.map(row=>row.profileId).filter(Boolean))
        const source=await bulkListSources({owner,backend:await getBackend(owner),listId:id,memberIds:new Set(ids),signal,authorize})
        if(source)metadata.sourceColumns=source.columns
        for(let start=0;start<first.members.length;start+=8){
          signal?.throwIfAborted()
          const batch=first.members.slice(start,start+8)
          const entities=await Promise.all(batch.map(member=>full||input.query.trim()?privateLists.entity(owner,member.id,{bulk:true}):member))
          for(let index=0;index<batch.length;index++){
            const member=batch[index],entity=entities[index],profile=found.get(entity.profileId??member.profileId)
            const record=summaryOf({...source?.records.get(member.id)?.[0]?.profile,...profile,id:member.id,profileId:profile?.id,name:entity.name??member.name,notes:entity.notes??[],sourceRecords:source?.records.get(member.id)??[],source:{kind:'private_list',listId:id},...(entity.links?{connections:entity.links}:{})})
            if(wanted(record))yield record
          }
        }
      }
    }
    async function* rows(){
      if(input.scope==='list'){yield* list();return}
      if(['mine','all'].includes(input.scope))yield* imported()
      if(['everyone','all'].includes(input.scope))yield* published()
    }
    const finish=async()=>{await authorize();await listFence?.();
      if(own&&(['mine','all'].includes(input.scope)||input.scope==='list'&&input.listId.startsWith('saved:'))){
        const backend=await getBackend(owner),current=await backend.listImportIds()
        if(JSON.stringify([...current].sort())!==JSON.stringify([...(own.imports??[])].sort()))throw fail('upstream_unavailable','Your imports changed during download. Retry for a complete copy.')
        if(own.legacyProfileId&&(await backend.readLegacyProfile())?.profileId!==own.legacyProfileId)throw fail('upstream_unavailable','Your linked profile changed during download.')
      }
      if(lastRevision){const final=await reader.exportPage({viewer,signal});if(final.revision!==lastRevision)throw fail('upstream_unavailable','The published network changed during download.')}}
    return {rows:rows(),finish,metadata}
  }
  return {manifest,async stream({owner,input:raw,policy,authorize,response,signal}){
    const input=bulkExportInput(raw),checkLive=async()=>{signal?.throwIfAborted();await authorize();await check(owner,input,policy)}
    const source=await open(owner,input,policy,signal,checkLive)
    return writeBulkExport({response,input,rows:source.rows,finish:source.finish,authorize:checkLive,signal,metadata:Object.assign(source.metadata,{scope:input.scope,detail:input.detail,selection:'all_matching_people'})})
  }}
}
