import { communityChatId } from './community-chat-id.mjs'
import { IDEAFLOW_ISSUER } from './messaging.mjs'
const ENDPOINT='https://chat.ideaflow.app/api/unlinked/groups/sync'
const valid=i=>i?.issuer===IDEAFLOW_ISSUER && typeof i.subject==='string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(i.subject)
export function createOpenChatGroupSync({store,identityForOwner,blocked=async()=>false,secret,fetchImpl=fetch,now=Date.now,intervalMs=1000}) {
  let running=null,timer=null,stopped=false
  const deliver=async id=>{
    const job=await store.chatJob(id)
    if(!job || job.done || job.nextAttemptAt>now())return
    try {
      const group=job.group
      const resolved=await identityForOwner(group.organizer)
      const organizer=valid(resolved)?{issuer:resolved.issuer,subject:resolved.subject,name:job.lastSnapshot?.organizer.name??'Organizer'}:job.lastSnapshot?.organizer
      if(!valid(organizer))throw Error('identity_unavailable')
      const deleted=job.deleted || !valid(resolved)
      const members=[],seen=new Set([organizer.subject])
      if(!deleted)for(const member of group.members) {
        const identity=await identityForOwner(member.actor)
        if(!valid(identity) || seen.has(identity.subject) || await blocked(group.organizer,member.actor))continue
        seen.add(identity.subject);members.push({issuer:identity.issuer,subject:identity.subject,name:(member.name??'Member').slice(0,160)})
      }
      const snapshot={groupId:id,revision:job.revision,name:group.name,organizer,members,deleted,...(group.chatConversationId?{existingConversationId:group.chatConversationId}:{})}
      if((await store.chatJob(id))?.revision!==job.revision)return
      // Persist the verified organizer binding before network delivery. Deletion
      // retries still work after the owner's active account binding disappears.
      await store.chatFinish(id,job.revision,{lastSnapshot:snapshot})
      const response=await fetchImpl(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify(snapshot)})
      if(!response.ok)throw Error('sync_unavailable')
      const text=await response.text();if(text.length>2048)throw Error('invalid_receipt')
      const receipt=JSON.parse(text)
      if(receipt.revision!==job.revision || receipt.conversationId!==communityChatId(group))throw Error('invalid_receipt')
      await store.chatFinish(id,job.revision,{done:true,attempts:0})
    } catch {
      const attempts=Math.min((job.attempts??0)+1,10)
      await store.chatFinish(id,job.revision,{attempts,nextAttemptAt:now()+Math.min(60000,1000*2**(attempts-1))})
    }
  }
  const runOnce=()=>{
    if(stopped || !secret || secret.length<32)return Promise.resolve()
    if(running)return running
    running=(async()=>{for(const id of await store.chatDue(now(),20)){if(stopped)break;await deliver(id)}})().finally(()=>{running=null})
    return running
  }
  const wake=()=>{void runOnce().catch(()=>{})}
  return {runOnce,wake,start(){if(timer||stopped||!secret||secret.length<32)return;timer=setInterval(wake,intervalMs);timer.unref?.();wake()},async stop(){stopped=true;clearInterval(timer);await running?.catch(()=>{})}}
}
