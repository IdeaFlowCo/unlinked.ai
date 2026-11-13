import { GROUP_KEY } from './community-chat-id.mjs'
import { createHash } from 'node:crypto'
import { concurrentMap } from './concurrent-map.mjs'
export const COMMUNITY_PATH = /^\/(?:profile\/context|asks)(?:\/(?:preview|save|\d+))?$/
export const COMMUNITY_GROUP_PATH = new RegExp(`^/groups/(${GROUP_KEY})/(welcome|community)(?:/(preview|save|organizer|[0-9a-f-]{36}))?$`)
export const isCommunityPath = path => COMMUNITY_PATH.test(path) || COMMUNITY_GROUP_PATH.test(path)
const issuer = 'https://id.ideaflow.app/api/auth'
export const identityKey = i => createHash('sha256').update(`${i.issuer}\n${i.subject}`).digest('hex')
export class IntakeError extends Error { constructor(code) { super(code); this.code = code } }
const clean = value => typeof value === 'string' ? value.trim().replace(/^[-*•]\s*/, '') : ''
const kinds = new Set(['ask','offer','idea','note'])
const sources = new Set(['manual','tasks','ideas','bookshelf','assistant','about','interests'])
// Bounded local parsing. Imported tasks are not automatically turned into requests for other people.
function csv(text) {
  const rows=[];let row=[],field='',quoted=false
  for(let i=0;i<text.length;i++) { const c=text[i]
    if(c==='"') { if(quoted && text[i+1]==='"'){field+='"';i++} else quoted=!quoted }
    else if(!quoted && (c===','||c==='\n')){row.push(field);field='';if(c==='\n'){rows.push(row);row=[]}}
    else if(c!=='\r')field+=c
  }
  if(quoted)throw new IntakeError('Finish the quoted CSV field before importing.')
  row.push(field);if(row.some(Boolean))rows.push(row);return rows
}
export function draftContext(input, source='tasks') {
  if(typeof input!=='string'||input.length>20000||!sources.has(source))throw new IntakeError('Use up to 20,000 characters and a supported source.')
  let rows=[]
  const add=(value,kind,src=source)=>{
    const title=clean(typeof value==='object'?value?.title:value)
    if(!title)return
    if(title.length>300)throw new IntakeError('Keep each entry under 300 characters; split longer passages into separate entries.')
    const body=typeof value==='object'?clean(value?.body):''
    if(body.length>1000)throw new IntakeError('Keep entry details under 1,000 characters.')
    rows.push({title,body,kind,source:src,selected:kind==='ask'||kind==='offer'||src!=='tasks'})
  }
  const value=input.trim().replace(/^\uFEFF/,'')
  if(!value)return []
  if(source==='assistant' && (value.startsWith('{')||value.startsWith('['))) {
    let data;try{data=JSON.parse(value)}catch{throw new IntakeError('The assistant draft is not valid JSON. Paste the JSON only, without code fences.')}
    if(Array.isArray(data)){for(const row of data){if(!kinds.has(row?.kind))throw new IntakeError('Each JSON entry needs kind: ask, offer, idea or note.');add(row,row.kind)}}
    else { for(const [field,kind,src] of [['about','note','about'],['interests','idea','interests'],['asks','ask','assistant'],['offers','offer','assistant'],['ideas','idea','ideas'],['books','idea','bookshelf'],['tasks','note','tasks']]) {
      if(data[field]===undefined)continue
      const values=typeof data[field]==='string'?[data[field]]:data[field]
      if(!Array.isArray(values))throw new IntakeError('Use text or an array for each supported profile field.')
      for(const row of values)add(row,kind,src)
    }}
  } else if(source==='bookshelf' && /(?:^|,)"?Title"?(?:,|$)/im.test(value.split('\n')[0])) {
    const [header,...records]=csv(value),titleIndex=header.findIndex(s=>s.trim().toLowerCase()==='title'),authorIndex=header.findIndex(s=>s.trim().toLowerCase()==='author')
    if(titleIndex<0)throw new IntakeError('The CSV needs a Title column.')
    for(const row of records)add([row[titleIndex],row[authorIndex]].filter(Boolean).join(' — '),'idea')
  } else for(const line of value.split(/\n+/).filter(s=>clean(s))) {
    let kind=source==='ideas'||source==='bookshelf'||source==='interests'?'idea':'note'
    if(/^(?:ask\s*:|looking for\b|i(?:’m|'m| am) looking for\b|(?:i |we )?need(?: help| an? | someone)|can (?:someone|anyone)\b)/i.test(clean(line)))kind='ask'
    if(/^(?:offer\s*:|(?:i |we )?can help\b|happy to help\b|i can offer\b)/i.test(clean(line)))kind='offer'
    add(line,kind)
  }
  rows=rows.filter((row,i)=>rows.findIndex(other=>other.title===row.title&&other.kind===row.kind)===i)
  if(rows.length>30)throw new IntakeError('Review up to 30 entries at a time. Split this import into smaller batches.')
  if(!rows.length)throw new IntakeError('No entries found. Use one entry per line or the supported assistant JSON format.')
  return rows
}
export const ASSISTANT_PROFILE_PROMPT = `Help me draft a profile for my developer community using only context I authorize you to use. Do not fetch private sources or take actions without my permission. Ask me about gaps instead of inventing facts. Keep sensitive details out. Separate tasks I can do myself from specific requests for help and things I can offer. Return plain JSON (no code fence) with these optional fields: about (short text), interests (text array), asks (text array), offers (text array), ideas (text array), books (text array), tasks (text array). Keep each entry under 300 characters and the total under 30 entries. This is a draft: I will review and choose visibility in Unlinked before anything is saved or shared.`
export function createCommunityIntakeClient({identityForOwner,secret,origin='https://social.ideaflow.app',fetchImpl=fetch}) {
  if(!secret || secret.length<32)return null
  if(!/^https:\/\/[^/]+$/.test(origin)&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw new Error('community_origin_invalid')
  async function call(owner,route,data={}) {
    const id=await identityForOwner(owner)
    if(id?.issuer!==issuer||!id.subject)throw new IntakeError('Your verified Ideaflow identity is unavailable. Please sign in again.')
    const r=await fetchImpl(`${origin}/api/partners/unlinked/${route}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({...data,issuer:id.issuer,subject:id.subject}),signal:AbortSignal.timeout(8000),redirect:'error'})
    if(!r.ok) {
      if(r.status===409) {
        let code
        try { code=(await r.json())?.error } catch { /* Keep the fixed conflict fallback for non-JSON errors. */ }
        if(code==='entry_visibility_conflict')throw new IntakeError('Review this entry’s visibility in Social before editing it through Unlinked. Open My asks and offers to find its Social link.')
        if(code==='entry_has_children')throw new IntakeError('This entry has attached content. Manage its audience and attached content in Social before changing its sharing here.')
        throw new IntakeError('This entry changed. Reload it before saving again.')
      }
      throw new IntakeError('Your Ideaflow profile could not be reached. Nothing new was confirmed saved; retry this same review to recover a completed save.')
    }
    return r.json()
  }
  return {
    list:(owner,page={})=>call(owner,'entries',page),
    save:(owner,data)=>call(owner,'intake',data),
    update:(owner,data)=>call(owner,'entry',data),
    async group(owner,groupId,roster,page={}){
      const members=(await concurrentMap(roster,async row=>{
        const id=await identityForOwner(row.actor)
        return id?.issuer===issuer&&id.subject?{ identity:id, memberId:row.id, name:row.name }:null
      })).filter(Boolean)
      const result=await call(owner,'group',{...page,groupId,members:members.map(row=>row.identity)})
      // Keep opaque identity keys inside this server; expose only roster-bound people and their entries.
      const allowed=new Map(members.map(row=>[identityKey(row.identity),row]))
      return {entries:(result.entries||[]).filter(e=>allowed.has(e.ownerKey)).map(e=>{const person=allowed.get(e.ownerKey);const entry={...e,memberId:person.memberId,name:person.name};delete entry.ownerKey;return entry}),nextCursor:result.nextCursor}
    },
  }
}
