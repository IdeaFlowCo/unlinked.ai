import test from 'node:test'
import assert from 'node:assert/strict'
import { enhancePrivateList } from '../mcp-server/private-list-loading.mjs'
class Element {
  constructor(id) { this.dataset = id ? { memberId: id } : {}; this.children = []; this.attrs = {}; this.listeners = {} }
  setAttribute(k,v) { this.attrs[k]=v } getAttribute(k) { return this.attrs[k] ?? null }
  hasAttribute(k) { return k in this.attrs } removeAttribute(k) { delete this.attrs[k] }
  append(el) { this.children.push(el) } focus() { this.focused=true }
  addEventListener(k,fn) { this.listeners[k]=fn } querySelector() { return null }
}
function fixture({pages, saved, initial=['a']}) {
  const rows=new Element(), link=new Element(), status=new Element(), root=new Element(), empty=new Element();
  rows.children=initial.map(id=>new Element(id)); root.dataset.privateList='list1'; link.attrs.href='/lists/private/list1?after=one';
  root.querySelector=selector=>({'[data-list-members]':rows,'[data-load-members]':link,'[data-member-status]':status,'[data-members-empty]':empty})[selector];
  const events={}, requests=[], win={location:new URL('https://example.test/lists/private/list1'),scrollY:42,
    document:{querySelector:()=>root,importNode:el=>new Element(el.dataset.memberId)},
    history:{state:saved?{privateList:saved}:null,replaceState(value){this.state=value}},
    addEventListener:(k,fn)=>events[k]=fn, requestAnimationFrame:fn=>fn(),scrollTo:(x,y)=>{win.restoredY=y},
    async fetch(url){requests.push(url);const page=pages.shift();if(page instanceof Error)throw page;return {ok:true,redirected:false,url,text:async()=>page}},
    DOMParser:class {parseFromString(page){const batch=new Element();batch.children=page.ids.map(id=>new Element(id));const more=new Element();more.attrs.href=page.next;return {querySelector:()=>({dataset:{privateList:page.list||'list1'},querySelector:selector=>selector==='[data-list-members]'?batch:page.next?more:null})}}}}
  enhancePrivateList(win);
  const click=()=>link.listeners.click({button:0,preventDefault(){}});
  return {win,rows,link,status,requests,click,events,empty};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('append bounded pages once, deduplicate boundary overlap, preserve fallback and announce end',async()=>{
  const f=fixture({pages:[{ids:['a','b'],next:'/lists/private/list1?after=two'},{ids:['c']}]});
  f.click(); f.click(); await settle();
  assert.equal(f.requests.length,1); assert.deepEqual(f.rows.children.map(x=>x.dataset.memberId),['a','b']);
  assert.match(f.status.textContent,/1 more members loaded/);
  f.click();await settle();assert.deepEqual(f.rows.children.map(x=>x.dataset.memberId),['a','b','c']);assert.equal(f.link.hidden,true);
  assert.match(f.status.textContent,/End of list/);assert.equal(f.rows.children.at(-1).focused,true);
  assert.ok(!JSON.stringify(f.win.history.state).includes('memberId'));
});
test('failure retains rows and cursor for retry; cross-list and looping cursors rejected',async()=>{
  for(const bad of [new Error('offline'),{ids:['b'],list:'other'},{ids:['b'],next:'/lists/private/list1?after=one'}]){
    const f=fixture({pages:[bad,{ids:['b']}]});f.click();await settle();assert.equal(f.rows.children.length,1);assert.match(f.status.textContent,/could not/);
    f.click();await settle();assert.equal(f.rows.children.length,2);
  }
});
test('Back restoration re-fetches authorized pages without persisting private member contents',async()=>{
  const f=fixture({pages:[{ids:['b']}],saved:{path:'/lists/private/list1',pages:['https://example.test/lists/private/list1?after=one'],scroll:400}});
  await settle();assert.deepEqual(f.rows.children.map(x=>x.dataset.memberId),['a','b']);assert.equal(f.win.restoredY,400);
});
test('empty filtered page can continue and oversized pages never append',async()=>{
  const f=fixture({initial:[],pages:[{ids:[],next:'/lists/private/list1?after=two'},{ids:['b']}]});f.click();await settle();f.click();await settle();assert.equal(f.rows.children.length,1);assert.equal(f.empty.hasAttribute('hidden'),true);
  const bad=fixture({pages:[{ids:Array.from({length:51},(_,i)=>String(i))}]});bad.click();await settle();assert.equal(bad.rows.children.length,1);
});
