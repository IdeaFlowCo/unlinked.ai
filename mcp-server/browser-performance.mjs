// First-party navigation measurements. No URL, query, person or account IDs.
export function performanceRoute(path) {
  if (path === '/') return 'home'
  if (/^\/(?:network|people)$/.test(path)) return 'search'
  if (/^\/people\/[^/]+\/connections$/.test(path)) return 'connections'
  if (/^\/people\/[^/]+$/.test(path)) return 'profile'
  if (/^\/network\/contacts\//.test(path)) return 'contact'
  if (/^\/companies\//.test(path)) return 'company'
  if (/^\/lists(?:\/|$)/.test(path)) return 'saved_lists'
  if (/^\/messages(?:\/|$)/.test(path)) return 'messages'
  if (/^\/(?:settings|profile|import|find-me|legacy-account)$/.test(path)) return 'account'
  if (/^\/(?:notifications|invites|invitations)(?:\/|$)/.test(path)) return 'connections'
  return 'other'
}
const routes = new Set(['home','search','connections','profile','contact','company','saved_lists','messages','account','other'])
export function safeBrowserPerformance(value) {
  if (!value || !routes.has(value.route) || !['content_ready','page_load','filter','connections_filter','bfcache'].includes(value.metric) || !['click','submit','navigation','history','interaction'].includes(value.start) || !['ok','error','cancelled'].includes(value.outcome) || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0 || value.duration_ms > 120000) return null
  const row = { route:value.route, metric:value.metric, start:value.start, outcome:value.outcome, duration_ms:value.duration_ms }
  for (const key of ['ttfb_ms','render_ms']) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 120000) row[key] = value[key]
  if (value.duration_capped === true) row.duration_capped = true
  return row
}
export function createBrowserPerformanceRecorder({ emit, now = () => Date.now(), release = 'unknown', maxPerMinute = 300 } = {}) {
  if (typeof emit !== 'function' || !Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 600) throw Error('browser_performance_configuration_invalid')
  let minute = -1, used = 0, dropped = 0
  const version = /^\d+\.\d+\.\d+$/.test(release) ? release : 'unknown'
  return value => {
    const row = safeBrowserPerformance(value), at = now()
    if (!row) return false
    const current = Math.floor(at/60000)
    if (minute !== current) { minute=current;used=0 }
    if (used++ >= maxPerMinute) { dropped++;return false }
    try { emit({ schema:1,event:'browser_performance',at:new Date(at).toISOString(),release:version,...row,dropped_since_last_emit:dropped });dropped=0 } catch { return false }
    return true
  }
}
export function browserPerformanceScript(status = 200) {
  // Route-only tab memory bridges navigation. It expires after two minutes.
  // Double rAF is a post-DOM-update paint opportunity, not a claim of LCP/INP.
  return `(()=>{
const route=${performanceRoute.toString()},key='ul-navigation-start-v1';
const epoch=()=>performance.timeOrigin+performance.now();
const painted=fn=>requestAnimationFrame(()=>requestAnimationFrame(fn));
let sent=0,pending=null,restored=false,interactionAt=0;
const send=value=>{if(document.visibilityState==='hidden'||sent>=120)return;sent++;try{fetch('/api/browser-performance',{method:'POST',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(()=>{})}catch{}};
const measure=(metric,start,at,path,outcome='ok',extra={})=>{const duration=Math.round(epoch()-at);if(duration>=0)send({route:route(path),metric,start,outcome,duration_ms:Math.min(120000,duration),...(duration>120000?{duration_capped:true}:{}),...extra})};
const remember=(event,url,kind)=>{if(url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')||url.pathname==='/login'||url.pathname==='/logout')return;const at=epoch();queueMicrotask(()=>{if(!event.defaultPrevented)pending={at,route:route(url.pathname),kind}})};
document.addEventListener('click',event=>{interactionAt=epoch();const link=event.target.closest?.('a[href]');if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.download||link.target&&link.target!=='_self')return;try{const url=new URL(link.href,location.href);if(url.pathname===location.pathname&&url.search===location.search&&url.hash)return;remember(event,url,'click')}catch{}},true);
document.addEventListener('input',()=>{interactionAt=epoch()},true);
document.addEventListener('change',()=>{interactionAt=epoch()},true);
document.addEventListener('submit',event=>{interactionAt=epoch();const form=event.target;if(form.target&&form.target!=='_self')return;try{remember(event,new URL(form.action,location.href),'submit')}catch{}},true);
addEventListener('pagehide',()=>{try{sessionStorage.removeItem(key);if(pending&&epoch()-pending.at<=120000)sessionStorage.setItem(key,JSON.stringify(pending))}catch{};pending=null});
let previous=null;try{previous=JSON.parse(sessionStorage.getItem(key));sessionStorage.removeItem(key)}catch{}
const nav=performance.getEntriesByType('navigation')[0];
const click=previous&&previous.route===route(location.pathname)&&['click','submit'].includes(previous.kind)&&Number.isFinite(previous.at)&&epoch()-previous.at>=0&&epoch()-previous.at<=120000;
const start=click?previous.kind:nav?.type==='back_forward'?'history':'navigation',at=click?previous.at:performance.timeOrigin;
const extras=()=>({...(nav?.responseStart>0?{ttfb_ms:Math.round(nav.responseStart)}:{}),...(nav?.responseEnd>0?{render_ms:Math.round(performance.now()-nav.responseEnd)}:{})});
const outcome=()=>${status >= 400 ? "'error'" : "document.querySelector('[data-page-load-error]')?'error':'ok'"};
const ready=()=>painted(()=>{if(!restored)measure('content_ready',start,at,location.pathname,outcome(),extras())});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
addEventListener('load',()=>setTimeout(()=>{if(!restored)measure('page_load',start,at,location.pathname,outcome(),extras())},0),{once:true});
addEventListener('pageshow',event=>{if(event.persisted){restored=true;pending=null;try{sessionStorage.removeItem(key)}catch{}const at=epoch();painted(()=>measure('bfcache','history',at,location.pathname))}});
globalThis.unlinkedPerformance={start(metric,path){if(!['filter','connections_filter'].includes(metric))return;const current=epoch(),at=interactionAt&&current-interactionAt<=2000?interactionAt:current;interactionAt=0;let done=false;return{finish(outcome='ok'){if(done)return;done=true;if(outcome==='ok')painted(()=>measure(metric,'interaction',at,path,outcome));else measure(metric,'interaction',at,path,outcome)}}}};
})();`
}
