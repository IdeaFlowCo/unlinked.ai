import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, link, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSearchLogStore, readSearchLogStatus, safeSearchLogStatus } from '../mcp-server/search-log-store.mjs'
import { readSearchLog } from '../scripts/read-search-log.mjs'
const row = (query='fictional investors') => ({schema:1,event:'search_query',at:'2026-11-11T00:00:00.000Z',request_id:randomUUID(),transport:'browser',surface:'directory',query})
async function dir(t){const p=await mkdtemp(join(tmpdir(),'search-store-'));t.after(()=>rm(p,{recursive:true,force:true}));return p}
const options=directory=>({directory,capBytes:4096,segmentBytes:1024,reserveBytes:0,freeBytes:async()=>1e9})

test('retains legacy and new queries indefinitely across dates and restarts, and reader handles segments',async t=>{
 const directory=await dir(t), legacy=JSON.stringify(row('old search'))+'\n'
 await writeFile(join(directory,'requests-2025-01-01.jsonl'),legacy,{mode:0o600})
 let now=new Date('2026-11-11T00:00:00Z')
 let store=await createSearchLogStore({...options(directory),now:()=>now})
 for(let i=0;i<8;i++){store.emit(row('new search '+i));await store.flush();now=new Date(now.getTime()+30*86400000)}
 await store.close()
 assert.equal(await readFile(join(directory,'requests-2025-01-01.jsonl'),'utf8'),legacy)
 const names=await readdir(directory);assert.ok(names.filter(n=>n.startsWith('queries-')).length>1)
 store=await createSearchLogStore({...options(directory),now:()=>new Date('2030-01-01')});t.after(()=>store.close())
 const rows=await readSearchLog({directory,since:'2025-01-01T00:00:00Z'});assert.equal(rows.records.length,9)
 assert.equal(rows.records[0].query.startsWith('new search'),true)
 for(const name of names)assert.equal((await stat(join(directory,name))).mode&0o777,0o600)
 const status=await readSearchLogStatus({directory});assert.equal(status.files,names.filter(n=>n.endsWith('.jsonl')).length)
 assert.equal(status.used_bytes,(await Promise.all(names.filter(n=>n.endsWith('.jsonl')).map(n=>stat(join(directory,n))))).reduce((n,s)=>n+s.size,0))
 assert.ok(!JSON.stringify(status).includes('search 0'))
})

test('warns at 80%, stops before the global cap, never deletes history, and stays paused across a restart',async t=>{
 const directory=await dir(t), opts={...options(directory),capBytes:2048}
 let store=await createSearchLogStore(opts), sawWarning=false
 for(let i=0;i<30;i++){store.emit(row());await store.flush();const s=await readSearchLogStatus({directory});sawWarning||=s.level==='warning'}
 const full=await readSearchLogStatus({directory});assert.ok(sawWarning);assert.equal(full.level,'full');assert.equal(full.paused,true);assert.ok(full.used_bytes<=2048);assert.ok(full.dropped>0)
 const names=(await readdir(directory)).filter(n=>n.endsWith('.jsonl')), bytes=await Promise.all(names.map(n=>readFile(join(directory,n))))
 await store.close();store=await createSearchLogStore(opts)
 store.emit(row('tiny'));await store.flush();assert.equal(store.stats().level,'full');assert.equal(store.stats().used_bytes,full.used_bytes)
 for(let i=0;i<names.length;i++)assert.deepEqual(await readFile(join(directory,names[i])),bytes[i])
 await store.close()
 store=await createSearchLogStore({...opts,capBytes:8192});t.after(()=>store.close());store.emit(row());await store.flush();assert.ok(store.stats().used_bytes>full.used_bytes);assert.equal(store.stats().level,'normal')
})

test('disk reserve pauses appends and exposes an alertable low-disk status without deleting history',async t=>{
 const directory=await dir(t)
 const store=await createSearchLogStore({...options(directory),reserveBytes:1000,freeBytes:async()=>1100});t.after(()=>store.close())
 store.emit(row());await store.flush();const status=await readSearchLogStatus({directory})
 assert.equal(status.level,'low_disk');assert.equal(status.paused,true);assert.equal(status.used_bytes,0);assert.equal(status.dropped,1)
})

test('refuses symlinks and hardlinks on startup and during append; invalid schemas do not enter logs',async t=>{
 const directory=await dir(t), target=join(directory,'queries-000000000001.jsonl'), external=join(await dir(t),'outside')
 await writeFile(external,'KEEP',{mode:0o600});await symlink(external,target)
 await assert.rejects(createSearchLogStore(options(directory)),/not_private/);await rm(target);await link(external,target)
 await assert.rejects(createSearchLogStore(options(directory)),/not_private/);await rm(target)
 const store=await createSearchLogStore(options(directory));t.after(()=>store.close())
 store.emit({...row(),event:'foreign',body:'SECRET'});await store.flush();assert.equal(store.stats().written,0)
 store.emit({...row(),body:'SECRET',headers:'SECRET'});await store.flush();assert.ok(!(await readFile(target,'utf8')).includes('SECRET'))
 await rm(target);await symlink(external,target);store.emit(row());await store.flush();assert.equal(await readFile(external,'utf8'),'KEEP');assert.equal(store.stats().level,'unavailable')
})

test('status projection excludes query/user/error content and the queue remains bounded',async t=>{
 const directory=await dir(t), store=await createSearchLogStore({...options(directory),maxQueue:1});t.after(()=>store.close())
 store.emit(row());store.emit(row());await store.flush();assert.equal(store.stats().written,1);assert.equal(store.stats().dropped,1)
 const safe=safeSearchLogStatus({...store.stats(),query:'SECRET',owner:'SECRET',headers:'SECRET'});assert.ok(!JSON.stringify(safe).includes('SECRET'))
 assert.equal(safeSearchLogStatus({...safe,cap_bytes:0}),null)
})
