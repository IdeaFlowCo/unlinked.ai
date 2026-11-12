import { randomUUID } from 'node:crypto'
import { renderPageShell } from './private-onboarding-views.mjs'
import { profilePath } from '../src/utils/public-people/profile-handles.mjs'
import { COMMUNITY_GROUP_PATH, IntakeError, draftContext, ASSISTANT_PROFILE_PROMPT } from './community-intake.mjs'
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const field=(n,v)=>`<input type="hidden" name="${h(n)}" value="${h(v)}">`
const options=(items,selected)=>items.map(([v,label])=>`<option value="${h(v)}"${v===selected?' selected':''}>${h(label)}</option>`).join('')
const typeOptions=[['ask','Looking for help'],['offer','Can help with'],['idea','Idea or interest'],['note','Private task or context']]
const style='<style>.community-intake{max-width:850px;margin:auto}.community-intake textarea{width:100%;min-height:90px}.community-intake .review-entry{padding:20px 0;border-top:1px solid var(--border,#ddd)}.community-intake .review-controls{display:flex;gap:16px;flex-wrap:wrap}.community-intake .review-controls>label{flex:1;min-width:180px}.community-intake .actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.community-intake details{margin:22px 0}.community-intake summary{cursor:pointer;min-height:44px}.community-intake pre{white-space:pre-wrap;overflow-wrap:anywhere}.community-intake table{width:100%;border-collapse:collapse}.community-intake td,.community-intake th{text-align:left;padding:12px 8px;border-bottom:1px solid #8884;vertical-align:top}.community-intake td{overflow-wrap:anywhere}.community-intake .pill{font-size:12px}.community-intake label{display:block;margin:12px 0}</style>'
const fileScript=`document.querySelector('[data-context-file]')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const out=document.getElementById('import-status');if(file.size>60000){out.textContent='Use a text or CSV file under 60 KB.';return}try{document.getElementById('context-text').value=await file.text();out.textContent='File loaded locally. Choose Review draft to continue.'}catch{out.textContent='Could not read this file. Paste the text instead.'}});`
const shell=(chrome,title,body)=>({...renderPageShell(title,style+`<section class="community-intake"><p class="small"><a href="/groups">Communities</a> · <a href="/asks">My asks and offers</a> · <a href="/profile/context">Add more about me</a></p>${body}</section>`,{...chrome,active:'lists'}),script:fileScript})
const audiences=group=>[['only_me','Only me'],...(group?[['group',`Members of ${group.name}`]]:[]),['public','Public on my Ideaflow profile']]
const requestForm=(path,csrf,body)=>`<form method="post" action="${h(path)}">${field('csrf',csrf)}${body}</form>`
function pagination(params,allowed) {
 if([...params.keys()].some(key=>!allowed||!['cursor','limit'].includes(key)))throw new IntakeError('This page does not accept those query parameters.')
 const page={limit:100}
 for(const key of ['cursor','limit']) {
  const values=params.getAll(key)
  if(!values.length)continue
  const value=Number(values[0])
  if(values.length!==1||!/^[1-9]\d*$/.test(values[0])||!Number.isSafeInteger(value)||(key==='limit'&&value>500))throw new IntakeError('Use a positive cursor and a page size from 1 to 500.')
  page[key]=value
 }
 return page
}
const pageLinks=(path,page,nextCursor)=>`<nav aria-label="Entry pages">${page.cursor?`<a href="${h(path)}?limit=${page.limit}">Newest entries</a> `:''}${Number.isSafeInteger(nextCursor)&&nextCursor>0?`<a href="${h(path)}?cursor=${nextCursor}&amp;limit=${page.limit}" rel="next">Older entries →</a>`:''}</nav>`
function entryFields(e,i,group,selected=true){return `<article class="review-entry"><label><input type="checkbox" name="selected" value="${i}"${selected?' checked':''}> Save this entry</label><label>Entry<input name="title-${i}" value="${h(e.title)}" maxlength="300" required></label><label>Details (optional)<textarea name="body-${i}" maxlength="1000">${h(e.body)}</textarea></label><div class="review-controls"><label>Type<select name="kind-${i}">${options(typeOptions,e.kind)}</select></label><label>Who can see it?<select name="audience-${i}">${options(audiences(group),e.audience||'only_me')}</select></label></div>${field('source-'+i,e.source)}</article>`}
function review(chrome,rows,path,group,requestId=randomUUID(),error='') {
 return shell(chrome,'Review your profile draft',`<h1 class="hq">Choose what to save and share.</h1><p class="lead">These are suggestions. Edit them, leave out anything sensitive, and choose an audience for each entry.</p>${error?`<p role="alert" class="notice">${h(error)}</p>`:''}${requestForm(path+'/save',chrome.csrf,field('requestId',requestId)+field('count',rows.length)+rows.map((e,i)=>entryFields(e,i,group,e.selected)).join('')+'<p class="small">Saving keeps these canonical entries in your Ideaflow profile and lets Unlinked read and update these entries. A Social profile is created if needed. Existing private Social content is not imported.</p><button type="submit">Save selected entries</button>')}<p><a href="${h(path)}">Back without saving</a></p>`)
}
function intake(chrome,group,path) {
 const title=group?`Introduce yourself to ${group.name}`:'Add more about me'
 return shell(chrome,title,`<h1 class="hq">${h(title)}</h1><p class="lead">Start with one thing you need or can offer. Everything here is optional and can be changed later.</p>${group?`<p>You’ve joined the group. <a href="/groups/${group.id}/community">Explore the community now →</a></p>`:''}<div class="card">${requestForm(path+'/preview',chrome.csrf,field('source','quick')+'<label>A little about me<textarea name="about" maxlength="300" placeholder="What are you working on?"></textarea></label><label>What I’m looking for<input name="ask" maxlength="300" placeholder="A person, introduction or specific kind of help"></label><label>What I can help with<input name="offer" maxlength="300" placeholder="Something you know or can offer"></label><button type="submit">Review my introduction</button>')}</div><details class="card"><summary><strong>Add more about me</strong> · optional imports and context</summary><p><a href="/profile">Add X, GitHub, your website and other profile links →</a></p><p><a href="/import">Import your LinkedIn data →</a> You can join and participate before importing.</p>${requestForm(path+'/preview',chrome.csrf,`<label>What are you adding?<select name="source">${options([['tasks','Tasks or projects'],['ideas','An idea list'],['bookshelf','A bookshelf (text or Goodreads CSV)'],['assistant','A draft from my assistant'],['interests','Interests']],'tasks')}</select></label><label>Text or CSV file (optional)<input data-context-file type="file" accept=".txt,.csv,.json,text/plain,text/csv,application/json"></label><p id="import-status" role="status" class="small"></p><label>Paste or load your list<textarea id="context-text" name="text" maxlength="20000" rows="8" placeholder="One entry per line, Goodreads CSV, or your assistant’s JSON draft"></textarea></label><p class="small">Parsing happens here without sending your draft to an AI model. Tasks stay tasks unless you choose “Looking for help”. Nothing is saved until you review.</p><button type="submit">Review draft</button>`)}<details><summary>Ask my assistant to draft a profile</summary><p>Copy this prompt into an assistant you already use, then paste the resulting draft above. You decide which context it may use.</p><textarea readonly rows="10" aria-label="Assistant profile prompt">${h(ASSISTANT_PROFILE_PROMPT)}</textarea></details></details><p class="small">Book imports support title lists and Goodreads CSV. Photos, live X imports and automatic bookshelf sync are not part of this import.</p>`)
}
export function createCommunityIntakeBrowser({client,groups,body}) {
 return async({request,url,session,render,redirect})=>{
  const match=COMMUNITY_GROUP_PATH.exec(url.pathname),groupId=match?.[1],suffix=match?.[3]||url.pathname.split('/').pop(),path=groupId?`/groups/${groupId}/welcome`:'/profile/context'
  const chrome={accountLabel:session?.accountLabel,displayName:session?.displayName,csrf:session?.csrf},actor=session?.owner
  if(!actor)return render(shell(chrome,'Sign in to continue',`<h1>Sign in to continue</h1><a class="button" href="/login?next=${encodeURIComponent(url.pathname)}">Continue with Ideaflow</a>`),401)
  let rows=null,requestId=null,group=null
  try {
    const page=pagination(url.searchParams,request.method==='GET'&&(url.pathname==='/asks'||(match?.[2]==='community'&&!match[3])))
    if(groupId)group=await groups.detail(actor,groupId)
    if(!client)return render(shell(chrome,'Profile connection unavailable','<h1>Profile connection unavailable</h1><p>You can still use your groups. Please try adding your introduction again later.</p>'),request.method==='GET'?200:503)
    if(request.method==='GET') {
      if(match?.[2]==='community') {
        const roster=await groups.roster(actor,groupId),signature=JSON.stringify(roster)
        const result=await client.group(actor,groupId,roster,page)
        if(JSON.stringify(await groups.roster(actor,groupId))!==signature)throw new IntakeError('Group membership changed. Reload this page.')
        const open=result.entries.filter(e=>e.status!=='done'&&e.status!=='paused')
        const list=kind=>open.filter(e=>e.kind===kind).map(e=>`<article class="review-entry"><h3>${h(e.title)}</h3><p class="small">${h(e.name)}</p>${e.body?`<p>${h(e.body)}</p>`:''}</article>`).join('')||'<p class="small">Nothing shared here yet.</p>'
        const people=roster.map(r=>`<tr><td>${r.profileId?`<a href="${profilePath(r.profileId)}">${h(r.name)}</a>`:h(r.name)}</td><td>${h(r.role)}</td></tr>`).join('')
        return render(shell(chrome,group.name+' · Community',`<h1 class="hq">${h(group.name)}</h1><p class="lead">People, asks and offers shared with this group.</p><p class="actions"><a class="button" href="${path}">Add an ask or offer</a><a href="/groups/${groupId}">Group settings and lists</a></p><section class="card"><h2>Looking for help</h2>${list('ask')}</section><section class="card"><h2>Can help with</h2>${list('offer')}</section><details class="card"><summary>Ideas and introductions</summary>${list('idea')}${list('note')}</details>${pageLinks(url.pathname,page,result.nextCursor)}<section class="card"><h2>People</h2><table><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody>${people}</tbody></table></section>`))
      }
      if(url.pathname==='/asks') {
        const mine=await client.list(actor,page),directory=await groups.directory(actor)
        return render(shell(chrome,'My asks and offers',`<h1 class="hq">My asks and offers</h1><p class="lead">Your saved community entries. Update their status or change who can see them.</p><p><a class="button" href="/profile/context">Add an entry</a>${mine.profileUrl?` · <a href="${h(mine.profileUrl)}">My full Ideaflow profile</a>`:''}</p>${mine.entries.map(e=>`<article class="card"><h2>${h(e.title)}</h2><p class="small">${h(e.kind)} · ${h(e.status)} · ${h(e.audience==='group'?directory.groups.find(g=>g.id===e.groupId)?.name||'Former group':e.audience==='public'?'Public':'Only me')}</p><p>${h(e.body)}</p><a href="/asks/${e.id}">Edit entry</a></article>`).join('')||'<p>No saved entries yet.</p>'}${pageLinks(url.pathname,page,mine.nextCursor)}<p><a href="https://neo4j.testingsuperconnector.network" rel="noopener">Open Superconnector →</a> Use your Ideaflow ID; joining a community here does not automatically join a Superconnector network.</p>`))
      }
      const edit=/^\/asks\/(\d+)$/.exec(url.pathname)
      if(edit){const id=Number(edit[1]);if(!Number.isSafeInteger(id)||id<1||id>=Number.MAX_SAFE_INTEGER)throw new IntakeError('This entry is unavailable.')
        // Social orders by descending id and selects id < cursor; this fetches the exact entry without scanning older pages.
        const mine=await client.list(actor,{cursor:id+1,limit:1}),e=mine.entries.find(e=>e.id===id);if(!e)throw new IntakeError('This entry is unavailable.')
        const directory=await groups.directory(actor),choices=directory.groups;const target=choices.length||e.audience==='group'?{name:'the selected community'}:null
        const selectedGroup=choices.some(g=>g.id===e.groupId)?e.groupId:''
        const communityOptions=[['','Choose a community'],...choices.map(g=>[g.id,g.name])]
        return render(shell(chrome,'Edit '+e.title,`<h1 class="hq">Edit entry</h1>${requestForm(url.pathname,chrome.csrf,field('revision',e.revision)+field('count',1)+entryFields(e,0,target,true)+`<label>Status<select name="status">${options([['open','Open'],['done','Done'],['paused','Paused'] ],e.status)}</select></label>`+(choices.length?`<label>Community (used when audience is members)<select name="groupId">${options(communityOptions,selectedGroup)}</select></label>`:'')+(e.audience==='group'&&!selectedGroup?'<p role="alert">Your previous community is unavailable. Choose a community explicitly to share there, or change who can see this entry.</p>':'')+'<button type="submit">Save changes</button>')}<p><a href="/asks">Back to my asks</a></p>`))}
      return render(intake(chrome,group,path))
    }
    if(request.method!=='POST')throw new IntakeError('Use a supported action.')
    if(request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new IntakeError('Refresh this page and try again.')
    const input=new URLSearchParams((await body(request,65536)).toString('utf8'))
    if(input.getAll('csrf').length!==1||input.get('csrf')!==session.csrf)throw new IntakeError('Refresh this page and try again.')
    for(const key of input.keys())if(key!=='selected'&&input.getAll(key).length!==1)throw new IntakeError('Repeated form fields are not accepted.')
    if(suffix==='preview') {
      const source=input.get('source')
      rows=source==='quick'?[
        ...draftContext(input.get('about')||'','about'),
        ...draftContext(input.get('ask')?`Ask: ${input.get('ask')}`:'','manual'),
        ...draftContext(input.get('offer')?`Offer: ${input.get('offer')}`:'','manual'),
      ]:draftContext(input.get('text')||'',source)
      if(!rows.length)throw new IntakeError('Add an introduction, ask or offer, or continue to your group without adding one.')
      return render(review(chrome,rows,path,group))
    }
    const edit=/^\/asks\/(\d+)$/.exec(url.pathname)
    if(suffix!=='save'&&!edit)throw new IntakeError('Use a supported action.')
    requestId=input.get('requestId')
    const count=Number(input.get('count')),selected=input.getAll('selected')
    if(!Number.isSafeInteger(count)||count<1||count>30||new Set(selected).size!==selected.length)throw new IntakeError('Review up to 30 entries at a time.')
    if(edit&&input.get('audience-0')==='group'&&input.get('groupId'))group=await groups.detail(actor,input.get('groupId'))
    rows=Array.from({length:count},(_,i)=>({title:input.get('title-'+i)||'',body:input.get('body-'+i)||'',kind:input.get('kind-'+i),source:input.get('source-'+i),audience:input.get('audience-'+i),selected:selected.includes(String(i))}))
    const entries=rows.filter(e=>e.selected).map(({selected,...e})=>({...e,...(e.audience==='group'&&group?{groupId:group.id}:{})}))
    if(!entries.length)throw new IntakeError('Select an entry to save, or go back without saving.')
    if(entries.some(e=>e.audience==='group'&&!group))throw new IntakeError('Choose an active group before sharing an entry.')
    if(edit){if(count!==1)throw new IntakeError('Edit one entry at a time.');await client.update(actor,{id:Number(edit[1]),revision:input.get('revision'),entry:entries[0],status:input.get('status')});return redirect('/asks')}
    requestId=input.get('requestId')
    await client.save(actor,{requestId,entries,consent:true,name:session.displayName||'Unlinked member'})
    return redirect(group?`/groups/${group.id}/community`:'/asks')
  }catch(error){const message=error instanceof IntakeError?error.message:'This page is unavailable. Please try again.'
    if(rows&&requestId)return render(review(chrome,rows,path,group,requestId,message),503)
    return render(shell(chrome,'Community profile',`<h1 class="hq">Couldn’t complete that step</h1><p role="alert">${h(message)}</p><p><a href="${h(path)}">Return to your introduction</a> · <a href="/groups">My communities</a></p>`),400)
  }
 }
}
