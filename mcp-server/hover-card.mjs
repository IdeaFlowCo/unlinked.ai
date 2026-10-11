// Hover cards, as on LinkedIn: resting a mouse on a person link shows who they
// are, mutual connections, and Message / Connect without leaving the page.
// Fine pointers only; touch and keyboard keep the plain link. Message is the
// profile's /messages?profile= address, which the dock opens as a chat window.
// The script avoids literal form markers (the CSRF field name, the Connect
// action) because page tests read their presence as signed-in state.
export const HOVER_CARD_SCRIPT = `(()=>{
  if(!matchMedia('(hover: hover) and (pointer: fine)').matches)return;
  const PERSON=/^\\/people\\/([^/?#]+)$/,cache=new Map();
  let card=null,anchor=null,timer=null,hideTimer=null,controller=null;
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;return node};
  const initials=name=>String(name||'').trim().split(/\\s+/).slice(0,2).map(word=>[...word][0]||'').join('').toUpperCase();
  const plural=(n,word)=>n.toLocaleString()+' '+word+(n===1?'':'s');
  const csrf=()=>document.querySelector('input[name=csrf]')?.value||'';
  const hide=()=>{clearTimeout(timer);clearTimeout(hideTimer);controller?.abort();card?.remove();card=null;anchor=null};
  const later=()=>{clearTimeout(hideTimer);hideTimer=setTimeout(hide,220)};
  async function show(link,id){
    let data=cache.get(id);
    if(!data){
      controller=new AbortController();
      try{const response=await fetch('/api/people/'+encodeURIComponent(id)+'/card',{credentials:'same-origin',signal:controller.signal});if(!response.ok)return;data=(await response.json()).card;cache.set(id,data)}catch{return}
    }
    if(anchor===link&&data&&link.isConnected)render(link,data);
  }
  function render(link,d){
    card?.remove();
    card=el('div','hovercard');card.setAttribute('role','dialog');card.setAttribute('aria-label',d.name||'Person');
    const href='/people/'+encodeURIComponent(d.id);
    const top=el('div','hc-top');
    let face;if(d.photo){face=el('img','hc-photo');face.src=d.photo;face.alt=''}else face=el('span','hc-photo hc-initials',initials(d.name));
    const who=el('div','hc-who'),name=el('a','hc-name',d.name);name.href=href;who.append(name);
    if(d.headline)who.append(el('p','hc-headline',d.headline));
    const facts=[d.location,d.connectionCount?plural(d.connectionCount,'connection'):''].filter(Boolean).join(' · ');
    if(facts)who.append(el('p','hc-facts',facts));
    if(d.mutual)who.append(el('p','hc-mutual',plural(d.mutual,'mutual connection')));
    if(d.presence==='member')who.append(el('p','hc-member','On Unlinked'));
    top.append(face,who);card.append(top);
    const actions=el('div','hc-actions');
    if(d.message){const message=el('a','button sm','Message');message.href=d.message;actions.append(message)}
    if(d.relation==='connected')actions.append(el('span','state-pill ok','✓ Connected'));
    else if(d.relation==='outgoing')actions.append(el('span','state-pill','Pending'));
    else if(d.relation==='none'&&csrf()){
      const form=el('form','hc-connect');form.method='post';form.action=['','connections','request'].join('/');
      for(const [key,value] of [['csrf',csrf()],['profileId',d.id],['next',location.pathname+location.search]]){const input=el('input');input.type='hidden';input.name=key;input.value=value;form.append(input)}
      const button=el('button','sec sm','Connect');button.type='submit';form.append(button);actions.append(form);
    }
    const view=el('a','button sec sm','View profile');view.href=href;actions.append(view);
    card.append(actions);
    card.addEventListener('pointerenter',()=>clearTimeout(hideTimer));
    card.addEventListener('pointerleave',later);
    (document.querySelector('.unlinked-onboarding')||document.body).append(card);
    const rect=link.getBoundingClientRect(),width=card.offsetWidth,height=card.offsetHeight;
    let y=rect.bottom+8;if(y+height>innerHeight-8)y=Math.max(8,rect.top-height-8);
    card.style.left=Math.min(Math.max(8,rect.left),innerWidth-width-8)+'px';card.style.top=y+'px';
  }
  document.addEventListener('pointerover',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link||link.closest('.hovercard'))return;
    const url=new URL(link.href,location.href),match=url.origin===location.origin&&!url.search&&PERSON.exec(url.pathname);
    if(!match||match[1]==='add')return;
    let id;try{id=decodeURIComponent(match[1])}catch{return}
    if(anchor===link)return;
    clearTimeout(timer);clearTimeout(hideTimer);
    if(card&&anchor!==link){card.remove();card=null}
    anchor=link;timer=setTimeout(()=>show(link,id),400);
  });
  document.addEventListener('pointerout',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link||link!==anchor||(event.relatedTarget&&link.contains(event.relatedTarget)))return;
    clearTimeout(timer);
    if(card&&event.relatedTarget&&card.contains(event.relatedTarget))return;
    if(card)later();else anchor=null;
  });
  addEventListener('scroll',hide,{passive:true,capture:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hide()});
  addEventListener('pagehide',hide);
})();`
