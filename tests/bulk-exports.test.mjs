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
 for(const value of [new URLSearchParams('scope=mine&scope=all'),{scope:'admin'},{format:'xlsx'},{fields:['password']},{ownerId:'another'}])assert.throws(()=>bulkExportInput(value))
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
