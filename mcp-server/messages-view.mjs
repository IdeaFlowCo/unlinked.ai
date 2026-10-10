// This page owns only the Unlinked frame. OpenChat owns all conversations,
// history, read state, sends and realtime updates inside it.
export function messagesScript(csrf) {
  return `(()=>{
    const frame=document.getElementById('messages-frame'),status=document.getElementById('messages-status'),retry=document.getElementById('messages-retry');
    if(!frame)return;
    const origin='https://chat.ideaflow.app';let cached=null,cachedAt=0,pending=null;
    const show=text=>{status.textContent=text;status.hidden=false;retry.hidden=false};
    const session=()=>{if(cached&&Date.now()-cachedAt<60000)return Promise.resolve(cached);if(pending)return pending;pending=fetch('/messages/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:${JSON.stringify(csrf)}}),signal:AbortSignal.timeout(12000)}).then(async response=>{if(!response.ok)throw Error('unavailable');cached=await response.json();cachedAt=Date.now();return cached}).finally(()=>{pending=null});return pending};
    let timer=setTimeout(()=>show('Messages couldn’t connect. Try again.'),20000);
    addEventListener('message',async event=>{
      if(event.origin!==origin||event.source!==frame.contentWindow||typeof event.data?.nonce!=='string'||!/^[a-f0-9-]{8,80}$/.test(event.data.nonce))return;
      if(event.data.type==='openchat:connected'){clearTimeout(timer);status.hidden=true;retry.hidden=true;return}
      if(event.data.type!=='openchat:ready')return;
      try{const value=await session();frame.contentWindow.postMessage({type:'unlinked:session',nonce:event.data.nonce,...value},origin)}
      catch{show('Messages are unavailable. Try again.');frame.contentWindow.postMessage({type:'unlinked:unavailable',nonce:event.data.nonce},origin)}
    });
    retry.addEventListener('click',()=>{cached=null;cachedAt=0;status.textContent='Connecting…';retry.hidden=true;frame.src=frame.src;clearTimeout(timer);timer=setTimeout(()=>show('Messages couldn’t connect. Try again.'),20000)});
  })();`
}
