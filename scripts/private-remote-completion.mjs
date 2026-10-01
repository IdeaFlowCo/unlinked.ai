import { spawn } from 'node:child_process'
import { responsesRequest } from '../src/utils/private-import/ai-search.mjs'

// Explicit staging bridge: the existing remote credential is read in place.
// No credential is copied, persisted locally or returned over stdout/stderr.
export function createRemoteCompletion({ sshHost, credentialFile, onReceipt = () => {} }) {
  if (sshHost !== 'm5' || typeof credentialFile !== 'string' || !credentialFile.startsWith('/') || credentialFile.includes('\n')) throw new Error('explicit_private_remote_configuration_required')
  const script = `import sys,json,urllib.request,urllib.error,os,stat
try:
 p=${JSON.stringify(credentialFile)}
 if stat.S_IMODE(os.stat(p).st_mode)!=0o600: raise Exception('credential_permissions')
 lines=open(p).read().splitlines()
 key=next(x.split('=',1)[1].strip().strip(chr(34)).strip(chr(39)) for x in lines if x.startswith('OPENAI_API_KEY='))
 data=json.load(sys.stdin)
 req=urllib.request.Request('https://api.openai.com/v1/responses',data=json.dumps(data).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(req,timeout=30) as r: result=json.load(r)
 if result.get('status')!='completed': raise Exception('provider_incomplete')
 parts=[p for x in result.get('output',[]) if x.get('type')=='message' for p in x.get('content',[])]
 if any(p.get('type')=='refusal' for p in parts): raise Exception('provider_refused')
 answer=json.loads(''.join(p.get('text','') for p in parts if p.get('type')=='output_text'))
 print(json.dumps({'answer':answer,'receipt':{'httpStatus':200,'model':result.get('model'),'usage':result.get('usage'),'stored':False}}))
except urllib.error.HTTPError as e: print(json.dumps({'error':'provider_http_'+str(e.code)}))
except Exception as e: print(json.dumps({'error':str(e) if str(e) in ['credential_permissions','provider_incomplete','provider_refused'] else 'remote_provider_unavailable'}))
`
  const command = `python3 -c '${script.replaceAll("'", "'\\''")}'`
  return async input => {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, command], { stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('private_remote_timeout')) }, 45000)
      let data = '', size = 0
      child.stdout.on('data', bytes => {
        size += bytes.length
        if (size > 64 * 1024) { child.kill('SIGTERM'); reject(new Error('private_remote_result_limit')) } else data += bytes.toString('utf8')
      })
      // SSH/provider stderr can include private configuration. Never surface it.
      child.stderr.resume()
      child.once('error', () => { clearTimeout(timer); reject(new Error('private_remote_unavailable')) })
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(data) : reject(new Error('private_remote_unavailable')) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(responsesRequest(input)))
    })
    let result
    try { result = JSON.parse(output) } catch { throw new Error('private_remote_invalid_result') }
    if (result.error) throw new Error(`private_search_${result.error}`)
    onReceipt(result.receipt)
    return result.answer
  }
}
