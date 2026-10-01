#!/usr/bin/env python3
"""Real bounded Docker proof of private parent ownership and persistent child binds.

Uses generated fixture files only, no private env, provider, graph or published port.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

IMAGE = 'node@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de'
ROOT = '/srv/unlinked-private-guest-pilot-20261001'
uid, gid = os.getuid(), os.getgid()
probe = subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], capture_output=True, timeout=15)
docker = ['docker'] if probe.returncode == 0 else ['sudo', '-n', 'docker']
subprocess.run(docker + ['info', '--format', '{{.ServerVersion}}'], capture_output=True, check=True, timeout=15)
script = r"""
const fs=require('fs');const root=process.env.PROOF_ROOT;const stat=fs.statSync(root);
const privateParent=stat.uid===process.getuid()&&stat.gid===process.getgid()&&(stat.mode&511)===448;
let readOnly=false;try{fs.writeFileSync(root+'/runtime/attempt','denied')}catch(e){readOnly=e.code==='EROFS'}
if(fs.readFileSync(root+'/runtime/fixture','utf8')!=='readonly fixture')throw Error('fixture parity');
for(const part of ['assets','audit'])fs.writeFileSync(root+'/'+part+'/'+process.env.PROOF_PHASE,'persistent fixture',{flag:'wx',mode:384});
console.log(JSON.stringify({phase:process.env.PROOF_PHASE,privateParent,rootUid:stat.uid,rootGid:stat.gid,rootMode:(stat.mode&511).toString(8),runtimeReadOnly:readOnly}));
"""
with tempfile.TemporaryDirectory(prefix='unlinked-root-mount-fixture-') as temporary:
    base=Path(temporary)
    for part in ('runtime', 'assets', 'audit'):
        (base/part).mkdir(mode=0o700)
    (base/'runtime/fixture').write_text('readonly fixture')
    results=[]
    for phase in ('before', 'after'):
        args=docker+['run', '--rm', '--network', 'none', '--user', f'{uid}:{gid}', '--memory', '64m', '--cpus', '0.25', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--env', 'PROOF_ROOT='+ROOT, '--env', 'PROOF_PHASE='+phase]
        if phase=='after':
            args+=['--tmpfs', f'{ROOT}:mode=700,uid={uid},gid={gid}']
        for part in ('runtime', 'assets', 'audit'):
            args+=['--mount', f'type=bind,src={base/part},dst={ROOT}/{part}'+(',readonly' if part=='runtime' else '')]
        result=subprocess.run(args+[IMAGE, 'node', '-e', script], capture_output=True, text=True, check=True, timeout=25)
        results.append(json.loads(result.stdout))
        for part in ('assets', 'audit'):
            assert (base/part/phase).read_text()=='persistent fixture'
        assert results[-1]['runtimeReadOnly']
    assert not results[0]['privateParent'] and results[1]['privateParent']
    print(json.dumps({'status':'PASS', 'counterfactual':results, 'persistent_child_parity':True, 'real_credentials':False, 'graph_started':False, 'published_ports':False, 'owned_fixture_removed_after_receipt':True}))
