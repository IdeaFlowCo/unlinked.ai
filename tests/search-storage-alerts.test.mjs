import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
test('storage warnings keep email and Twilio acceptance independent and retry only unfinished channels',()=>{
 const result=spawnSync('python3',['-m','unittest','discover','-s',new URL('../deploy/private-pilot/ops-alerts/',import.meta.url).pathname,'-p','test_*.py'],{encoding:'utf8',timeout:20000})
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
})
