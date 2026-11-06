import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'
import {createServer} from 'node:http'
import {mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {browserPerformanceScript,createBrowserPerformanceRecorder,safeBrowserPerformance} from '../mcp-server/browser-performance.mjs'
import {createPrivateBrowserHandler} from '../mcp-server/private-browser.mjs'
import {createDiagnosticsStore} from '../mcp-server/request-diagnostics-store.mjs'
import {readBrowserPerformance,summarizeBrowserPerformance} from '../scripts/read-browser-performance.mjs'
function browser({memory=new Map(),path='/people/private-person',origin=1000,now=500,status=200,hidden=false,softError=false}={}){
 const listeners=new Map(),frames=[],micro=[],sent=[];const on=(name,fn)=>{listeners.set(name,[...(listeners.get(name)??[]),fn])}
 const context={URL,JSON,Number,Math,queueMicrotask:fn=>micro.push(fn),setTimeout:fn=>micro.push(fn),requestAnimationFrame:fn=>frames.push(fn),location:new URL('https://example.test'+path),performance:{timeOrigin:origin,now:()=>now,getEntriesByType:()=>[{type:'navigate',responseStart:200,responseEnd:350}]},sessionStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},document:{querySelector:selector=>softError&&selector==='[data-page-load-error]'?{}:null,visibilityState:hidden?'hidden':'visible',readyState:'complete',addEventListener:on},addEventListener:on,fetch:async(url,options)=>{sent.push({url,options,body:JSON.parse(options.body)})}}
 vm.runInNewContext(browserPerformanceScript(status),context)
 const fire=(name,event={})=>{for(const fn of listeners.get(name)??[])fn(event)}
 const flush=()=>{for(let i=0;i<10&&(micro.length||frames.length);i++){for(const fn of micro.splice(0))fn();for(const fn of frames.splice(0)){now+=16;fn()}}}
 return{context,fire,flush,sent,memory}
}
test('actual click timestamp crosses document boundary without storing URL or query',()=>{
 const first=browser({path:'/network?q=private-query',origin:0,now:700});first.flush()
 const link={href:'https://example.test/people/private-person?secret=value',target:'',download:''}
 first.fire('click',{target:{closest:()=>link},button:0});first.flush();first.fire('pagehide')
 const stored=first.memory.get('ul-navigation-start-v1');assert.match(stored,/"kind":"click"/);assert.doesNotMatch(stored,/secret|private-person|private-query/)
 const next=browser({memory:first.memory,origin:1000,now:500});next.flush();next.fire('load');next.flush()
 assert.deepEqual(next.sent.map(x=>x.body.metric),['content_ready','page_load'])
 assert.equal(next.sent[0].body.start,'click');assert.equal(next.sent[0].body.route,'profile');assert.ok(next.sent[0].body.duration_ms>700)
 assert.equal(next.sent[0].body.ttfb_ms,200);assert.equal(next.sent[0].options.credentials,'omit');assert.doesNotMatch(JSON.stringify(next.sent),/private-person|private-query/)
})
test('prevented navigation, background pages, error pages and restored pages are distinguished',()=>{
 const b=browser();b.flush();const e={target:{closest:()=>({href:'https://example.test/network',target:'',download:''})},button:0};b.fire('click',e);e.defaultPrevented=true;b.flush();b.fire('pagehide');assert.equal(b.memory.size,0)
 const hidden=browser({hidden:true});hidden.flush();assert.equal(hidden.sent.length,0)
 const error=browser({status:503});error.flush();assert.equal(error.sent[0].body.outcome,'error')
 const restored=browser();restored.fire('pageshow',{persisted:true});restored.flush();assert.deepEqual(restored.sent.map(x=>x.body.metric),['bfcache'])
})
test('in-place timing finishes once after paint; cancellation and errors stay distinct',()=>{
 const b=browser();b.flush();b.sent.length=0
 const mark=b.context.unlinkedPerformance.start('filter','/network');mark.finish();mark.finish();assert.equal(b.sent.length,0);b.flush();assert.equal(b.sent.length,1)
 b.context.unlinkedPerformance.start('filter','/network').finish('cancelled')
 b.context.unlinkedPerformance.start('connections_filter','/people/secret').finish('error')
 assert.deepEqual(b.sent.map(x=>x.body.outcome),['ok','cancelled','error'])
})
test('collection is bounded and projects only fixed professional-page timing fields',()=>{
 const rows=[];let now=100000
 const record=createBrowserPerformanceRecorder({emit:r=>rows.push(r),now:()=>now,release:'0.6.84',maxPerMinute:1})
 const value={route:'search',metric:'filter',start:'interaction',outcome:'ok',duration_ms:200,query:'secret',userId:'secret',url:'/people/secret',release:'spoofed'}
 assert.ok(record(value));assert.equal(record(value),false);now+=60000;assert.ok(record(value));assert.equal(rows[1].dropped_since_last_emit,1);assert.doesNotMatch(JSON.stringify(rows),/secret|spoofed/)
 assert.equal(safeBrowserPerformance({...value,route:'/people/secret'}),null);assert.equal(safeBrowserPerformance({...value,duration_ms:Infinity}),null)
})
test('HTTP telemetry is same-origin, bounded, unauthenticated and excluded from iOS',async t=>{
 const rows=[];let handler
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const endpoint='http://127.0.0.1:'+server.address().port,baseUrl=endpoint.replace('http:','https:')
 handler=createPrivateBrowserHandler({baseUrl,recordBrowserPerformance:createBrowserPerformanceRecorder({emit:r=>rows.push(r)}),login:{begin:async()=>({}),finish:async()=>({})},resolveOwner:async()=>null,getBackend:async()=>({})})
 const payload={route:'profile',metric:'content_ready',start:'click',outcome:'ok',duration_ms:1234,query:'secret'}
 const post=(headers={},body=JSON.stringify(payload))=>fetch(endpoint+'/api/browser-performance',{method:'POST',headers:{Origin:baseUrl,'Content-Type':'application/json',...headers},body})
 assert.equal((await post({Origin:'https://foreign.invalid'})).status,403)
 assert.equal((await post()).status,204);assert.equal(rows.length,1);assert.doesNotMatch(JSON.stringify(rows),/secret/)
 assert.equal((await post({},'x'.repeat(2050))).status,400)
 const html=await(await fetch(endpoint+'/support')).text();assert.match(html,/ul-navigation-start-v1/)
 assert.equal((await fetch(endpoint+'/api/browser-performance')).status,405)
})
test('private persisted report produces percentiles, error counts and honest time coverage',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ul-performance-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'records');await mkdir(directory,{mode:0o700})
 const store=await createDiagnosticsStore({directory}),record=createBrowserPerformanceRecorder({emit:store.emit,release:'0.6.84'})
 for(const duration_ms of [100,200,300,400,500,3000])record({route:'search',metric:'filter',start:'interaction',outcome:'ok',duration_ms})
 record({route:'search',metric:'filter',start:'interaction',outcome:'error',duration_ms:10000});await store.close()
 const report=await readBrowserPerformance({directory,since:'2020-01-01T00:00:00Z'}),g=report.groups[0]
 assert.equal(report.records,7);assert.equal(g.ok,6);assert.equal(g.error,1);assert.equal(g.p50_ms,300);assert.equal(g.p95_ms,3000);assert.equal(g.over_2s,1);assert.ok(report.first_at)
 assert.deepEqual(summarizeBrowserPerformance([{schema:1,event:'browser_performance',route:'secret'}]).groups,[])
})

test('HTTP 200 search fallbacks do not count as successful page loads',()=>{
 for(const state of ['error','unavailable'])assert.match(renderPeople({state,everyone:[]}).content,/data-page-load-error/)
 assert.doesNotMatch(renderPeople({state:'ready',everyone:[]}).content,/data-page-load-error/)
 const b=browser({status:200,softError:true});b.flush();b.fire('load');b.flush()
 assert.deepEqual(b.sent.map(row=>row.body.outcome),['error','error'])
})
