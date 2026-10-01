#!/usr/bin/env python3
"""Consume Compose configuration; no daemon, graph, secrets or launch needed."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent
env = dict(os.environ, PILOT_UID='1002', PILOT_GID='1003')
for name in ('PILOT_NEO4J_IMAGE', 'PILOT_RUNTIME_IMAGE', 'PILOT_NGINX_IMAGE'):
    env[name] = 'fixture@sha256:' + '1' * 64
# This consumer fixture overrides only env_file, so no private inputs are read.
# The deployed helper independently requires the exact private input files.
with tempfile.TemporaryDirectory(prefix='unlinked-compose-consumer-') as directory:
    override = Path(directory) / 'no-private-env.yaml'
    override.write_text('services:\n  graph:\n    env_file: !override []\n  runtime:\n    env_file: !override []\n')
    result = subprocess.run(['docker', 'compose', '--env-file', '/dev/null', '-f', str(root / 'compose.yaml'), '-f', str(override), 'config', '--no-env-resolution', '--format', 'json'], env=env, capture_output=True, text=True, check=True, timeout=30)
config = json.loads(result.stdout)
services = config['services']
assert set(services) == {'graph', 'runtime', 'ingress'}
assert set(services['graph']['networks']) == {'backend'}
assert services['graph']['entrypoint'] == ['tini', '-g', '--', '/bin/bash', '-c', 'umask 077; exec /startup/docker-entrypoint.sh neo4j']
assert services['graph']['command'] == []
assert set(services['ingress']['networks']) == {'frontend'}
assert set(services['runtime']['networks']) == {'frontend', 'backend'}
assert config['networks']['backend']['internal'] is True
assert not config['networks']['frontend'].get('internal', False)
assert not services['graph'].get('ports') and not services['runtime'].get('ports')
ports = services['ingress']['ports']
assert len(ports) == 1 and ports[0]['target'] == 8443 and str(ports[0]['published']) == '443'
for service in services.values():
    assert service['user'] == '1002:1003'
    assert not service.get('network_mode') and not service.get('privileged')
    assert service['cap_drop'] == ['ALL'] and not service.get('cap_add')
    assert service['logging']['driver'] == 'none'
    for mount in service['volumes']:
        if mount.get('source', '').startswith('/srv/'):
            # Compose JSON omits this normalized field when it is false.
            assert mount.get('bind', {}).get('create_host_path', False) is False
runtime_tmpfs = services['runtime']['tmpfs']
private_parent = '/srv/unlinked-private-guest-pilot-20261001:mode=700,uid=1002,gid=1003'
assert private_parent in runtime_tmpfs
assert len(runtime_tmpfs) == 2
runtime = services['runtime']['environment']
assert runtime['PILOT_HOST'] == '0.0.0.0' and runtime['PILOT_NETWORK_MODE'] == 'isolated-container'
assert runtime['PILOT_BOLT_URL'] == 'bolt://graph:7687'
assert runtime['PILOT_OPERATIONS_URL'] == 'http://127.0.0.1:9022'
print('PASS: real Compose consumer confirms isolated service networks, no app/graph publication, private operations, non-root TLS port and zero added capabilities')
