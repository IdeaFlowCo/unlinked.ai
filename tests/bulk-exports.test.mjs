import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createBulkExports, bulkExportInput } from '../mcp-server/bulk-exports.mjs'
import { writeBulkExport, csvCell } from '../mcp-server/bulk-export-format.mjs'
import { createAccountToolService, INTERNAL_BULK_READ } from '../mcp-server/account-tools.mjs'
const owner={ownerId:'owner',userId:'user'},other={ownerId:'other',userId:'other-user'}
const people=Array.from({length:350},(_,i)=>({id:'person-'+i,name:'Person '+String(i).padStart(3,'0'),headline:i%2?'Engineer':'Designer',company:'Example',positions:[{title:'Role',company:'Example'}],about:'Profile detail '+i,education:[],skills:['skill'],email:'not-public@example.invalid'}))
const source=()=>({state:'published',complete:true,revision:'bulk-v1',profiles:people,connections:people.slice(1).map(row=>({fromId:'person-0',toId:row.id})),members:people.map(row=>row.id),connectionPrivacy:{'person-0':{audience:'only_me',scope:'all'}}})
const backend={listImportIds:async()=>[],readResource:async()=>null,readLegacyProfile:async()=>({profileId:'self',sourceSha256:'a'.repeat(64),receiptId:'receipt',revision:'v1',profile:{id:'self',name:'Owner'},profiles:people,connections:people.map(row=>({fromId:'self',toId:row.id}))})}
const getBackend=async bound=>{if(bound.ownerId!==owner.ownerId||bound.userId!==owner.userId)throw Error('owner denied');return backend}
const response=()=>{const chunks=[],res=new Writable({highWaterMark:1,write(chunk,_e,done){chunks.push(chunk.toString());setImmediate(done)}});res.writeHead=(status,headers)=>{res.status=status;res.headers=headers};res.text=()=>chunks.join('');return res}
const run=async(service,input,policy={publicAllowed:true,privateAllowed:true,browser:true})=>{const res=response();await service.stream({owner,input,policy,authorize:async()=>{},response:res});return res}
const service=()=>createBulkExports({getBackend,readPublishedSnapshot:async()=>source(),ownProfileId:async()=> 'person-1',isVerified:async()=>true})

test('one request exports more than three public pages, with full detail and viewer privacy intact',async()=>{
 const res=await run(service(),{scope:'everyone',format:'json',detail:'full'})
 const data=JSON.parse(res.text());assert.equal(data.complete,true);assert.equal(data.count,350);assert.equal(data.rows.length,350)
 assert.equal(data.rows[0].about,'Profile detail 0');assert.equal(data.rows[0].email,undefined);assert.deepEqual(data.rows[0].connections,[],'another person’s private connections stay hidden')
 assert.match(res.headers['Content-Disposition'],/attachment/);assert.match(res.headers['Cache-Control'],/no-store/)
})
test('every ordinary owner can download their complete own network; full public scope stays verified-only',async()=>{
 const ordinary=createBulkExports({getBackend,readPublishedSnapshot:async()=>source(),isVerified:async()=>false})
 const res=await run(ordinary,{scope:'mine',format:'json'});assert.equal(JSON.parse(res.text()).count,350)
 await assert.rejects(run(ordinary,{scope:'everyone',format:'json'}),{code:'scope_not_granted'})
 await assert.rejects(ordinary.manifest(owner,{scope:'list',listId:'private:list'},{privateAllowed:false}),{code:'scope_not_granted'})
 await assert.rejects(ordinary.manifest(other,{scope:'mine'},{privateAllowed:true}),/owner denied/)
})
test('query, structured filters, selected IDs and fields work on the whole result, independent of display pages',async()=>{
 const res=await run(service(),{scope:'everyone',format:'json',query:'Engineer Example',company:'Example',ids:['person-1','person-2','person-349'],fields:['name','headline']})
 const data=JSON.parse(res.text());assert.equal(data.count,2);assert.deepEqual(Object.keys(data.rows[0]),['name','headline']);assert.equal(data.rows[1].name,'Person 349')
 const csv=await run(service(),{scope:'everyone',format:'csv',detail:'headline'});assert.equal(csv.text().split('\r\n').length,352)
})
test('manifest links contain no bearer and offer one authenticated download, without materializing or truncating records',async()=>{
 const result=await service().manifest(owner,{scope:'mine',format:'csv'},{publicAllowed:false,privateAllowed:false})
 assert.equal(result.selection,'all_matching_people');assert.equal(result.truncated,false);assert.match(result.download.apiUrl,/\/api\/agent\/v1\/export\?/);assert.ok(!result.download.url.includes('token='))
})
test('source CSV columns remain spreadsheet columns; formulas are neutralized while JSON retains exact values',async()=>{
 assert.equal(csvCell(' =1+2'),`"' =1+2"`);assert.equal(csvCell('a,"b"'),`"a,""b"""`)
 async function* rows(){yield {id:'a',name:'Alice',sourceRecords:[{fields:{Custom:'=1+2',Email:'a@example.invalid'}}]}}
 const res=response();await writeBulkExport({response:res,rows:rows(),input:{scope:'list',format:'csv',detail:'full'},metadata:{sourceColumns:['Custom','Email']},authorize:async()=>{}})
 assert.match(res.text(),/source.Custom/);assert.match(res.text(),/"'=1\+2"/)
 const json=response();await writeBulkExport({response:json,rows:rows(),input:{format:'json',detail:'full'},authorize:async()=>{}});assert.equal(JSON.parse(json.text()).rows[0].sourceRecords[0].fields.Custom,'=1+2')
})
test('private lists consume all membership pages, preserve full private notes and respect live deletion',async()=>{
 const members=people.slice(0,251).map(row=>({id:row.id,kind:'person',name:row.name}));let pages=0,deleted=false
 const lists={get:async(_owner,id,after)=>{if(deleted)throw Object.assign(Error('gone'),{code:'not_found'});pages++;const at=after?Number(after):0;return {list:{id,name:'Private people'},members:members.slice(at,at+50),nextCursor:at+50<members.length?String(at+50):null}},entity:async(_owner,id)=>({id,name:id,notes:[{text:'Private note '+id}],links:[]})}
 const instance=createBulkExports({getBackend,readPublishedSnapshot:async()=>source(),privateLists:lists})
 const result=await run(instance,{scope:'list',listId:'private:list',format:'json',detail:'full'});const data=JSON.parse(result.text());assert.equal(data.count,251);assert.ok(pages>=12);assert.equal(data.rows[250].notes[0].text,'Private note person-250')
 deleted=true;await assert.rejects(run(instance,{scope:'list',listId:'private:list',format:'json'}),{code:'not_found'})
})
test('private-list bulk paging skips repeated rate admission while keeping the normal tool budget and scopes enforced',async()=>{
 const tool=createAccountToolService({getBackend,limits:{deterministicPerMinute:1}})
 const grant={...owner,tools:['unlinked_list_notifications']}
 // The fixture has no notifications service: reaching it proves admission was
 // allowed, while the second ordinary call is rejected by the normal quota.
 await assert.rejects(tool.call({grant,name:'unlinked_list_notifications'}),error=>error.code!=='rate_limited')
 await assert.rejects(tool.call({grant,name:'unlinked_list_notifications'}),{code:'rate_limited'})
 await assert.rejects(tool.call({grant,name:'unlinked_list_notifications',admission:INTERNAL_BULK_READ}),error=>error.code!=='rate_limited')
 await assert.rejects(tool.call({grant:{...grant,tools:[]},name:'unlinked_list_notifications',admission:INTERNAL_BULK_READ}),{code:'scope_not_granted'})
})
test('download input rejects duplicate parameters, unsupported formats and unknown fields',()=>{
 for(const value of [new URLSearchParams('scope=mine&scope=all'),{scope:'admin'},{format:'xlsx'},{fields:['password']},{ownerId:'another'},{scope:'list',listId:'private:list',degree:'2'}])assert.throws(()=>bulkExportInput(value))
})

test('inline queries return every matching row in one call when it fits, and declare real size overflow explicitly',async()=>{
 const found=await service().manifest(owner,{scope:'everyone',inline:true,query:'Engineer',fields:['id','name','headline']},{publicAllowed:true,privateAllowed:false})
 assert.equal(found.kind,'unlinked_query');assert.equal(found.total,175);assert.equal(found.rows.length,175);assert.equal(found.complete,true);assert.equal(found.truncated,false)
 const huge=createBulkExports({getBackend,isVerified:async()=>true,readPublishedSnapshot:async()=>({...source(),profiles:people.map(row=>({...row,about:'x'.repeat(4000)}))})})
 const overflow=await huge.manifest(owner,{scope:'everyone',inline:true,detail:'full'},{publicAllowed:true,privateAllowed:false})
 assert.equal(overflow.total,350);assert.equal(overflow.complete,false);assert.equal(overflow.truncated,true);assert.equal(overflow.reason,'response_size_limit');assert.match(overflow.download.apiUrl,/export\?/)
})

test('repeated exact connection observations produce one person with preserved full source records, never name-only merges',async()=>{
 const duplicated={...backend,readLegacyProfile:async()=>{const legacy=await backend.readLegacyProfile();return {...legacy,connections:[legacy.connections[0],legacy.connections[0],legacy.connections[1]]}}}
 const instance=createBulkExports({getBackend:async()=>duplicated})
 const result=await run(instance,{scope:'mine',format:'json',detail:'full'});const data=JSON.parse(result.text());assert.equal(data.count,2);assert.equal(data.rows[0].sourceRecords.length,2)
})

test('whole-network queries match cell values across columns, not JSON property names, and survive missing public enrichment',async()=>{
 const local=createBulkExports({getBackend})
 const result=await local.manifest(owner,{scope:'mine',query:'Person 001 Example',inline:true,fields:['name','company']},{publicAllowed:false,privateAllowed:false})
 assert.equal(result.total,1);assert.equal(result.rows[0].name,'Person 001')
 const empty=await local.manifest(owner,{scope:'mine',query:'sourceRecords',inline:true,detail:'full'},{publicAllowed:false,privateAllowed:false})
 assert.equal(empty.total,0)
})

test('native app downloads retain the same members-only public projection as its directory',async()=>{
 const app=createBulkExports({getBackend,isVerified:async()=>true,readPublishedSnapshot:async()=>({...source(),members:['person-0']})})
 const res=await run(app,{scope:'everyone',format:'json'},{publicAllowed:true,privateAllowed:false,browser:true,membersOnly:true})
 const result=JSON.parse(res.text());assert.equal(result.count,1);assert.equal(result.rows[0].id,'person-0')
})

test('an inline private-list export cannot finish after its private permission is removed',async()=>{
 const original={...owner,scope:'owner_network_and_private_notes',tools:['unlinked_export_network']};let checks=0
 const tool=createAccountToolService({getBackend,exportManifest:async(_grant,_input,_signal,authorize)=>{await authorize();return {private:'must not be returned'}}})
 await assert.rejects(tool.call({grant:original,name:'unlinked_export_network',input:{scope:'list',listId:'private:list',inline:true},revalidate:async()=>++checks===1?original:{...original,scope:'owner_network'}}),{code:'scope_not_granted'})
})


test('list exports apply presence filters to the complete selection',async()=>{
 const instance=createBulkExports({getBackend,readPublishedSnapshot:async()=>({...source(),members:['person-0']}),savedSearchLists:{get:async()=>({name:'Saved',refs:['public:person-0','public:person-1']})}})
 const res=await run(instance,{scope:'list',listId:'saved:11111111-1111-1111-1111-111111111111',presence:'member',format:'json'})
 const result=JSON.parse(res.text());assert.equal(result.count,1);assert.equal(result.rows[0].name,'Person 000')
})

// Combined first + second-degree download with intermediaries (unlinked-flav).
// Synthetic graph: the owner's own network is hub-0..hub-2 plus one import
// with no published profile. Each published target is reached through one or
// more hubs; privacy, unlisting, duplicates and >3 internal pages are covered.
const xOwner={ownerId:'owner',userId:'user'}
const xHubs=[0,1,2].map(i=>({id:'hub-'+i,name:'Hub '+i,headline:'Connector',linkedinUrl:'https://www.linkedin.com/in/hub-'+i}))
const xTargets=Array.from({length:320},(_,i)=>({id:'target-'+String(i).padStart(3,'0'),name:'Target '+String(i).padStart(3,'0'),headline:i%2?'Investor':'Founder',company:'Example',about:'About target '+i,positions:[{title:'Role',company:'Example'}]}))
const xExtra=[{id:'me',name:'Owner'},{id:'hidden-hub',name:'Hidden Hub'},{id:'behind-hidden',name:'Behind Hidden'},{id:'unlisted-target',name:'Unlisted Target'},{id:'third',name:'Third Degree'},{id:'stranger',name:'Stranger'},{id:'same-name',name:'Offline Contact'}]
const xConnections=[
  ...xTargets.map((row,i)=>({fromId:'hub-'+(i%3),toId:row.id})),
  {fromId:'hub-1',toId:'target-000'},{fromId:'target-000',toId:'hub-2'},          // three intermediaries, one recorded from the far side
  {fromId:'hub-0',toId:'hub-1'},                                                   // first-degree people stay first degree
  {fromId:'hidden-hub',toId:'behind-hidden'},{fromId:'hub-0',toId:'unlisted-target'},
  {fromId:'target-001',toId:'third'},{fromId:'hub-0',toId:'me'},
]
const xFull=row=>({positions:[],education:[],skills:[],...row})
const xSnapshot=({profiles=[...xHubs,...xTargets,...xExtra],...overrides}={})=>({state:'published',complete:true,revision:'paths-v1',profiles:profiles.map(xFull),connections:xConnections,members:['me','hub-0','hub-1','hub-2','hidden-hub'],connectionPrivacy:{'hidden-hub':{audience:'only_me',scope:'all'}},unlisted:[{id:'unlisted-target'}],...overrides})
const xLegacy={profileId:'me',sourceSha256:'b'.repeat(64),receiptId:'receipt',revision:'v1',profile:{id:'me',name:'Owner'},profiles:[...xHubs,xExtra[1],{id:'offline-1',name:'Offline Contact'}],connections:[{fromId:'me',toId:'hub-0'},{fromId:'me',toId:'hub-0'},{fromId:'me',toId:'hub-1'},{fromId:'me',toId:'hub-2'},{fromId:'me',toId:'hidden-hub'},{fromId:'me',toId:'offline-1'}]}
const xBackend=(legacy=xLegacy)=>({listImportIds:async()=>[],readResource:async()=>null,readLegacyProfile:async()=>legacy})
const xService=(options={})=>createBulkExports({getBackend:async()=>xBackend(),readPublishedSnapshot:async()=>xSnapshot(),ownProfileId:async()=>'me',isVerified:async()=>true,...options})
const xRun=async(service,input,options={})=>{const res=response();await service.stream({owner:xOwner,input,policy:{publicAllowed:true,privateAllowed:true,browser:true},authorize:options.authorize??(async()=>{}),response:res,signal:options.signal});return res}

test('extended download lists each first and second-degree person once, across pages, with who connects them',async()=>{
 const data=JSON.parse((await xRun(xService(),{scope:'extended',format:'json',detail:'full'})).text())
 assert.equal(data.complete,true);assert.equal(data.scope,'extended')
 const first=data.rows.filter(row=>row.degree===1),second=data.rows.filter(row=>row.degree===2)
 assert.equal(first.length,5,'three hubs, the hidden hub and the unpublished import; the repeated hub-0 row is one person')
 assert.equal(second.length,320,'every recorded second-degree person beyond the 100-row internal page')
 assert.equal(new Set(data.rows.map(row=>row.profileId??row.id)).size,data.rows.length,'no person appears in both degrees')
 assert.ok(first.every(row=>row.viaCount===0&&row.via.length===0&&row.pathEvidence.hops===1))
 const multi=second.find(row=>row.id==='target-000')
 assert.deepEqual(multi.via.map(entry=>entry.viaId),['hub-0','hub-1','hub-2']);assert.equal(multi.viaCount,3);assert.equal(multi.viaNames,'Hub 0; Hub 1; Hub 2')
 assert.deepEqual(multi.via[1].path,{fromId:'me',viaId:'hub-1',toId:'target-000'});assert.equal(multi.via[0].url,'https://www.unlinked.ai/people/hub-0')
 assert.deepEqual(multi.pathEvidence,{type:'recorded_public_path',hops:2,revision:'paths-v1',named:3,total:3})
 assert.equal(multi.about,'About target 0','full detail is retained for second-degree people')
 const last=second.find(row=>row.id==='target-319');assert.deepEqual(last.via.map(entry=>entry.viaId),['hub-1'],'paths remain correct on the last internal page')
 const ids=new Set(data.rows.map(row=>row.id))
 for(const absent of ['behind-hidden','unlisted-target','third','stranger','me','same-name'])assert.ok(!ids.has(absent),absent+' is not a visible recorded second-degree person')
 assert.ok(second.every(row=>row.via.every(entry=>['hub-0','hub-1','hub-2'].includes(entry.viaId))),'only the owner’s own first-degree people are ever named')
})
test('extended CSV has one header and flat path columns; degree narrows to one side; degree 3 and path fields elsewhere are refused',async()=>{
 const csv=(await xRun(xService(),{scope:'extended',format:'csv',detail:'summary',query:'Investor'})).text().trim().split('\r\n')
 assert.match(csv[0],/"degree","viaCount","viaNames","viaUrls"$/);assert.equal(csv.length,161);assert.ok(csv.slice(1).every(line=>/"2","\d+","Hub \d/.test(line)))
 const one=JSON.parse((await xRun(xService(),{scope:'extended',format:'json',degree:'1'})).text());assert.equal(one.count,5);assert.ok(one.rows.every(row=>row.degree===1))
 const two=JSON.parse((await xRun(xService(),{scope:'extended',format:'json',degree:'2',fields:['name','degree','viaNames']})).text());assert.equal(two.count,320);assert.deepEqual(Object.keys(two.rows[0]),['name','degree','viaNames'])
 assert.throws(()=>bulkExportInput({scope:'extended',degree:'3'}),{code:'invalid_input'})
 assert.throws(()=>bulkExportInput({scope:'mine',fields:['name','via']}),{code:'invalid_input'})
 assert.deepEqual(Object.keys(JSON.parse((await xRun(xService(),{scope:'mine',format:'json'})).text()).rows[0]).includes('degree'),false,'other downloads keep their columns')
})
test('extended download keeps the shared-network entitlement and never falls back to a partial file',async()=>{
 const standard=xService({isVerified:async()=>false})
 await assert.rejects(xRun(standard,{scope:'extended',format:'json'}),{code:'scope_not_granted'})
 await assert.rejects(standard.manifest(xOwner,{scope:'extended'},{publicAllowed:true,privateAllowed:true}),{code:'scope_not_granted'})
 await assert.rejects(xService().manifest(xOwner,{scope:'extended'},{publicAllowed:false,privateAllowed:true}),{code:'scope_not_granted'},'an owner-only agent grant gains no published rows')
 const approved=xService({isVerified:undefined,accessTier:async()=>'approved'});assert.equal(JSON.parse((await xRun(approved,{scope:'extended',format:'json',detail:'headline'})).text()).count,325)
 const manifest=await xService().manifest(xOwner,{scope:'extended',format:'csv'},{publicAllowed:true,privateAllowed:false});assert.match(manifest.download.url,/scope=extended/);assert.match(manifest.guidance,/not complete LinkedIn second-degree coverage/);assert.ok(manifest.fields.includes('viaNames'))
 const broken=xService({readPublishedSnapshot:async()=>{throw Error('reader down')}});await assert.rejects(xRun(broken,{scope:'extended',format:'json'}),'a failed profile read is never reported as a first-degree-only file')
})
test('extended download stops without a completion marker on revocation, cancellation or a changed publication',async()=>{
 let calls=0;const revoked=response()
 await assert.rejects(xService().stream({owner:xOwner,input:{scope:'extended',format:'jsonl'},policy:{publicAllowed:true,privateAllowed:true,browser:true},authorize:async()=>{if(++calls>6)throw Object.assign(Error('revoked'),{code:'grant_revoked'})},response:revoked}),{code:'grant_revoked'})
 assert.doesNotMatch(revoked.text(),/"type":"complete"/)
 let tier='verified',tierReads=0;const demoted=response()
 await assert.rejects(xService({isVerified:undefined,accessTier:async()=>{if(++tierReads>6)tier='standard';return tier}}).stream({owner:xOwner,input:{scope:'extended',format:'json'},policy:{publicAllowed:true,privateAllowed:true,browser:true},authorize:async()=>{},response:demoted}),{code:'scope_not_granted'})
 assert.doesNotMatch(demoted.text(),/"complete":true/)
 const controller=new AbortController();let aborts=0;const cancelled=response()
 await assert.rejects(xService().stream({owner:xOwner,input:{scope:'extended',format:'json'},policy:{publicAllowed:true,privateAllowed:true,browser:true},authorize:async()=>{if(++aborts===8)controller.abort()},response:cancelled,signal:controller.signal}))
 assert.doesNotMatch(cancelled.text(),/"complete":true/)
 let reads=0;const moved=response()
 await assert.rejects(xService({readPublishedSnapshot:async()=>xSnapshot({revision:++reads>3?'paths-v2':'paths-v1'})}).stream({owner:xOwner,input:{scope:'extended',format:'json'},policy:{publicAllowed:true,privateAllowed:true,browser:true},authorize:async()=>{},response:moved}),error=>['upstream_unavailable','public_people_unavailable'].includes(error.code))
 assert.doesNotMatch(moved.text(),/"complete":true/)
})
test('more intermediaries than the named bound are disclosed by count, and agents receive no archive contact fields',async()=>{
 const hubs=Array.from({length:30},(_,i)=>({id:'wide-'+String(i).padStart(2,'0'),name:'Wide '+String(i).padStart(2,'0')}))
 const legacy={...xLegacy,profiles:hubs,connections:hubs.map(row=>({fromId:'me',toId:row.id}))}
 const wide=xService({getBackend:async()=>xBackend(legacy),readPublishedSnapshot:async()=>xSnapshot({profiles:[...hubs,{id:'me',name:'Owner'},{id:'popular',name:'Popular'}],connections:hubs.map(row=>({fromId:row.id,toId:'popular'})),members:['me'],connectionPrivacy:{},unlisted:[]})})
 const res=response();await wide.stream({owner:xOwner,input:{scope:'extended',format:'json',detail:'full',degree:'2'},policy:{publicAllowed:true,privateAllowed:false,browser:false},authorize:async()=>{},response:res})
 const [row]=JSON.parse(res.text()).rows
 assert.equal(row.via.length,25);assert.equal(row.viaCount,30);assert.deepEqual(row.pathEvidence,{type:'recorded_public_path',hops:2,revision:'paths-v1',named:25,total:30});assert.equal(row.email,undefined);assert.equal(row.sourceRecords,undefined)
})
test('a viewer in an unlisted group can download shared scopes and sees only their own group’s unlisted people',async()=>{
 // Regression: the viewer's group must reach the reader as a Set; the earlier array form failed every shared download for such a viewer.
 const grouped=xService({readPublishedSnapshot:async()=>xSnapshot({unlisted:[{id:'me',group:'pilot'},{id:'unlisted-target',group:'pilot'},{id:'target-002',group:'other'},{id:'target-003'}]})})
 const data=JSON.parse((await xRun(grouped,{scope:'extended',format:'json'})).text()),ids=new Set(data.rows.map(row=>row.id))
 assert.equal(data.complete,true);assert.ok(ids.has('unlisted-target'),'same-group unlisted person stays visible');assert.ok(!ids.has('target-002')&&!ids.has('target-003'),'other groups and ungrouped unlisted people stay hidden')
 assert.equal(data.rows.find(row=>row.id==='unlisted-target').viaNames,'Hub 0')
 const everyone=new Set(JSON.parse((await xRun(grouped,{scope:'everyone',format:'json',detail:'headline'})).text()).rows.map(row=>row.id))
 assert.ok(everyone.has('unlisted-target')&&!everyone.has('target-002')&&!everyone.has('target-003'))
})
