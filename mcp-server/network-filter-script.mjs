// Progressive enhancement only: native GET forms/links remain complete without JS.
export const NETWORK_FILTER_SCRIPT = `(()=>{
  let root=document.querySelector('[data-network]');if(!root)return;
  let timer,controller,version=0,composing=false,typingEntry=false;
  const ready=()=>{root.setAttribute('data-network-enhanced','');const help=root.querySelector('#network-search-help');if(help)help.textContent='Results update as you type.'};ready();
  const cancel=()=>{clearTimeout(timer);controller?.abort();version++};
  const formURL=()=>{const form=root.querySelector('#network-filters');const url=new URL(form.action);url.search=new URLSearchParams(new FormData(form)).toString();if(!url.searchParams.get('q'))url.searchParams.delete('q');return url};
  const busy=value=>root.querySelector('[data-network-results]')?.setAttribute('aria-busy',String(value));
  async function load(url,{historyMode='push',keepFocus=false,focusLink=null}={}){
    cancel();const current=version;controller=new AbortController();busy(true);
    const active=document.activeElement;const focusId=keepFocus&&root.contains(active)?active.id:null;
    try{
      const response=await fetch(url,{credentials:'same-origin',signal:controller.signal,headers:{'Accept':'text/html'}});
      if(!response.ok||response.redirected)throw Error('network_filter_failed');
      const text=await response.text();if(current!==version)return;
      const doc=new DOMParser().parseFromString(text,'text/html'),next=doc.querySelector('[data-network]');if(!next)throw Error('network_filter_failed');
      const oldInput=root.querySelector('#network-query');const start=oldInput.selectionStart,end=oldInput.selectionEnd;
      if(focusId==='network-query')next.querySelector('#network-query').replaceWith(oldInput);
      root.replaceWith(next);root=next;ready();
      if(historyMode==='push')history.pushState(null,'',url);else if(historyMode==='replace')history.replaceState(null,'',url);
      document.title=doc.title;
      if(focusLink){const target=[...root.querySelectorAll('a')].find(link=>link.textContent===focusLink);target?.focus({preventScroll:true})}
      if(focusId){const target=root.querySelector('#'+focusId);target?.focus({preventScroll:true});if(focusId==='network-query')try{target.setSelectionRange(start,end)}catch{}}
    }catch(error){if(current!==version||error.name==='AbortError')return;const status=root.querySelector('.network-count');if(status)status.textContent='Could not update results. Press Enter or Apply to try again.';root.removeAttribute('data-network-enhanced');}
    finally{if(current===version)busy(false)}
  }
  document.addEventListener('input',event=>{
    if(event.target.id!=='network-query'||!root.contains(event.target))return;
    cancel();busy(true);if(composing)return;
    timer=setTimeout(()=>{const mode=typingEntry?'replace':'push';typingEntry=true;load(formURL(),{historyMode:mode,keepFocus:true})},300);
  });
  document.addEventListener('compositionstart',event=>{if(event.target.id==='network-query'){composing=true;cancel()}});
  document.addEventListener('compositionend',event=>{if(event.target.id==='network-query'){composing=false;event.target.dispatchEvent(new Event('input',{bubbles:true}))}});
  document.addEventListener('change',event=>{if(event.target.id==='network-sort'&&root.contains(event.target)){typingEntry=false;load(formURL(),{keepFocus:true})}});
  document.addEventListener('submit',event=>{if(event.target.id!=='network-filters')return;event.preventDefault();typingEntry=false;load(formURL(),{keepFocus:true})});
  document.addEventListener('click',event=>{
    const link=event.target.closest('a');if(!link||!root.contains(link)||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||link.target)return;
    const url=new URL(link.href);if(url.origin!==location.origin||url.pathname!=='/network')return;
    const clear=link.classList.contains('network-reset')||link.textContent==='Clear search';
    if(!clear){const q=root.querySelector('#network-query').value;if(q)url.searchParams.set('q',q);else url.searchParams.delete('q')}
    event.preventDefault();typingEntry=false;load(url,{focusLink:link.textContent});
  });
  addEventListener('popstate',()=>{typingEntry=false;load(new URL(location.href),{historyMode:'none'})});
})();`;
