// Progressive enhancement only: native GET forms/links remain complete without JS.
export const NETWORK_FILTER_SCRIPT = `(()=>{
  let root=document.querySelector('[data-network]');if(!root)return;
  const initialForm=root.querySelector('#network-filters');
  let renderedURL=new URL(initialForm.action);renderedURL.search=new URLSearchParams(new FormData(initialForm)).toString();
  let pendingURL=new URL(renderedURL);
  let timer,controller,version=0,composing=false,typingEntry=false,enhanced=true;
  const ready=()=>{root.setAttribute('data-network-enhanced','');const help=root.querySelector('#network-search-help');if(help)help.textContent='Results update as you type.'};ready();
  const cancel=()=>{clearTimeout(timer);controller?.abort();version++};
  const value=(u,key)=>u.searchParams.get(key)||(['sort','mode'].includes(key)?'best':'');
  const formURL=()=>{const form=root.querySelector('#network-filters'),fields=new URLSearchParams(new FormData(form)),url=new URL(form.action);url.search=pendingURL.search;for(const key of ['q','sort']){const live=fields.get(key)||value(new URL(form.action),key);if(live)url.searchParams.set(key,live);else url.searchParams.delete(key)}url.searchParams.delete('page');url.searchParams.delete('cursor');return url};
  const focusables='a,button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[contenteditable="true"]';
  const focusKey=element=>{if(element.id)return JSON.stringify(['id',element.id]);const section=element.closest('section[aria-label]');const form=element.closest('form'),person=element.closest('article')?.querySelector('a[href^="/people/"]');return JSON.stringify([section?.getAttribute('class')||section?.getAttribute('aria-label'),element.tagName,form?.getAttribute('action'),form?.querySelector('input[name="profileId"],input[name="id"]')?.value,person?.getAttribute('href'),element.name,element.type,element.tagName==='BUTTON'?element.value:null,['A','BUTTON','SUMMARY'].includes(element.tagName)?element.textContent.trim():null])};
  const busy=value=>root.querySelector('[data-network-results]')?.setAttribute('aria-busy',String(value));
  async function load(url,{historyMode='push'}={}){
    cancel();pendingURL=new URL(url);for(const [key,id] of [['q','network-query'],['sort','network-sort']]){const control=root.querySelector('#'+id),nextValue=value(pendingURL,key);if(control.value!==nextValue)control.value=nextValue}const current=version;controller=new AbortController();busy(true);
    try{
      const response=await fetch(url,{credentials:'same-origin',signal:controller.signal,headers:{'Accept':'text/html'}});
      if(!response.ok||response.redirected)throw Error('network_filter_failed');
      const text=await response.text();if(current!==version)return;
      const doc=new DOMParser().parseFromString(text,'text/html'),next=doc.querySelector('[data-network]');if(!next)throw Error('network_filter_failed');
      const active=document.activeElement;const focused=root.contains(active)?focusKey(active):null;
      const openDisclosures=[...root.querySelectorAll('details[open]')].map(details=>details.querySelector('summary')).filter(Boolean).map(focusKey);
      const oldInput=root.querySelector('#network-query');const start=oldInput.selectionStart,end=oldInput.selectionEnd;
      if(active===oldInput){oldInput.value=next.querySelector('#network-query').value;next.querySelector('#network-query').replaceWith(oldInput);}
      root.replaceWith(next);root=next;renderedURL=new URL(url);ready();
      if(historyMode==='push')history.pushState(null,'',url);else if(historyMode==='replace')history.replaceState(null,'',url);
      document.title=doc.title;
      for(const details of root.querySelectorAll('details')){const summary=details.querySelector('summary');if(summary&&openDisclosures.includes(focusKey(summary)))details.open=true}
      if(focused){const target=[...root.querySelectorAll(focusables)].find(element=>focusKey(element)===focused);target?.focus({preventScroll:true});if(target===oldInput)try{target.setSelectionRange(start,end)}catch{}}
    }catch(error){if(current!==version||error.name==='AbortError')return;const status=root.querySelector('.network-count');if(status)status.textContent='Could not update results. Press Enter or Apply to try again.';const form=root.querySelector('#network-filters'),sort=root.querySelector('#network-sort'),wantedSort=value(pendingURL,'sort');
      if(![...sort.options].some(option=>option.value===wantedSort)){const option=document.createElement('option');option.value=wantedSort;option.textContent=wantedSort==='connected'?'Recently connected':'Recently imported';sort.append(option)}sort.value=wantedSort;
      for(const key of ['presence','connected','mode','scope','page','cursor']){
        let field=form.querySelector('input[name="'+key+'"]');const wanted=pendingURL.searchParams.get(key);
        if(wanted===null){field?.remove();continue}if(!field){field=document.createElement('input');field.type='hidden';field.name=key;form.append(field)}field.value=wanted;
      }
      enhanced=false;root.removeAttribute('data-network-enhanced');}
    finally{if(current===version)busy(false)}
  }
  document.addEventListener('input',event=>{
    if(!enhanced||event.target.id!=='network-query'||!root.contains(event.target))return;
    cancel();busy(true);if(composing)return;
    timer=setTimeout(()=>{const mode=typingEntry?'replace':'push';typingEntry=true;load(formURL(),{historyMode:mode})},300);
  });
  document.addEventListener('compositionstart',event=>{if(event.target.id==='network-query'){composing=true;cancel()}});
  document.addEventListener('compositionend',event=>{if(event.target.id==='network-query'){composing=false;event.target.dispatchEvent(new Event('input',{bubbles:true}))}});
  document.addEventListener('change',event=>{if(enhanced&&event.target.id==='network-sort'&&root.contains(event.target)){typingEntry=false;load(formURL(),{})}});
  document.addEventListener('submit',event=>{if(!enhanced||event.target.id!=='network-filters')return;event.preventDefault();typingEntry=false;load(formURL(),{})});
  document.addEventListener('click',event=>{
    const link=event.target.closest('a');if(!enhanced||!link||!root.contains(link)||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||link.target)return;
    const destination=new URL(link.href);if(destination.origin!==location.origin||destination.pathname!=='/network')return;
    const clear=link.classList.contains('network-reset')||link.textContent==='Clear search';
    let url=destination;
    if(!clear){
      url=formURL();
      const keys=['q','sort','mode','presence','connected','scope'];
      const changed=keys.some(key=>value(url,key)!==value(renderedURL,key));
      const intentKeys=link.closest('.network-segments')?['presence']:link.closest('.network-scopes')?['connected']:link.closest('.modes')?['mode']:['mode','presence','connected','scope'].filter(key=>value(destination,key)!==value(renderedURL,key));
      for(const key of intentKeys){
        if(destination.searchParams.has(key))url.searchParams.set(key,destination.searchParams.get(key));else url.searchParams.delete(key);
      }
      if(!url.searchParams.has('connected')&&['connected','imported'].includes(url.searchParams.get('sort')))url.searchParams.delete('sort');
      if(!changed)for(const key of ['page','cursor'])if(destination.searchParams.has(key))url.searchParams.set(key,destination.searchParams.get(key));
    }
    event.preventDefault();typingEntry=false;load(url);

  });
  addEventListener('popstate',()=>{if(!enhanced){location.reload();return}typingEntry=false;load(new URL(location.href),{historyMode:'none'})});
})();`;
