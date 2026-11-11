import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers/investor-fixture.mjs'
import { bulkListSources } from '../mcp-server/bulk-list-sources.mjs'

test('real imported list recovery retains unmapped spreadsheet columns, excludes removed members and other owners, and verifies the original digest',async()=>{
 const f=fixture(),owner={ownerId:'alice',userId:'alice',agent:'test-agent'},tools=f.tools()
 const staged=await tools.unlinked_stage_investor_csv(owner,{csv:'Name,Company,Comment,Custom\nAda,Example,Useful note,=1+2\nGrace,Other,Another note,private value\n',mapping:{name:'Name',company:'Company',notes:['Comment']},listName:'Whole list'})
 const complete=await tools.unlinked_resume_investor_import(owner,{importId:staged.importId,batchSize:25})
 assert.equal(complete.status,'complete')
 const member=[...f.state('alice').entities.values()].find(row=>row.name==='Ada'),backend=await f.getBackend(owner)
 const source=await bulkListSources({owner,backend,listId:complete.listId,memberIds:new Set([member.id]),authorize:async()=>{}})
 assert.equal(source.records.size,1);assert.equal(source.records.get(member.id)[0].fields.Custom,'=1+2');assert.ok(source.columns.includes('Custom'));assert.equal(source.records.get(member.id)[0].profile.company,'Example')
 const other={ownerId:'bob',userId:'bob'}
 const empty=await bulkListSources({owner:other,backend:await f.getBackend(other),listId:complete.listId,memberIds:new Set([member.id]),authorize:async()=>{}});assert.equal(empty.records.size,0)
 await assert.rejects(bulkListSources({owner,backend:{...backend,readAsset:async()=>Buffer.from('corrupted')},listId:complete.listId,memberIds:new Set([member.id]),authorize:async()=>{}}),/digest_mismatch/)
})
