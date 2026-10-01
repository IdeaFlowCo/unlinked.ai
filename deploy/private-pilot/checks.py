#!/usr/bin/env python3
"""Lightweight release consumer checks; no Docker, network, graph or secrets."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pilot', HERE / 'pilot.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def refused(function):
    try:
        function()
    except ValueError:
        return
    raise AssertionError('unsafe input accepted')


os.umask(0o077)
result = subprocess.run(['python3', str(HERE / 'pilot.py'), 'plan'], text=True, capture_output=True, check=True)
plan = json.loads(result.stdout)
assert plan['status'] == 'blocked' and plan['mutations'] is False
assert 'missing_reviewed_wiring_digest' in plan['blockers']
assert 'provider_client_registered' in plan['blockers']

with tempfile.TemporaryDirectory(prefix='private-pilot-release-check-') as temporary:
    temporary = Path(temporary).resolve()
    source = temporary / 'source'
    source.mkdir(mode=0o700)
    for part in pilot.PARTS:
        (source / part).mkdir(mode=0o700)
        (source / part / 'fixture').write_bytes(('synthetic-' + part).encode())
    backup = temporary / 'cold-pair'
    checksum = pilot.snapshot(source, backup, {'unlinked': 'synthetic-head', 'noos': 'synthetic-head'})
    pilot.verify_snapshot(backup, checksum)
    original_root = pilot.ROOT
    pilot.ROOT = temporary / 'pilot-root'
    target = temporary / 'pilot-root-rehearsal-1'
    pilot.restore_snapshot(backup, checksum, target)
    assert (target / 'invitations/fixture').read_bytes() == b'synthetic-invitations'
    refused(lambda: pilot.restore_snapshot(backup, checksum, pilot.ROOT))
    refused(lambda: pilot.restore_snapshot(backup, checksum, target))
    (backup / 'assets/fixture').write_bytes(b'corrupted')
    refused(lambda: pilot.verify_snapshot(backup, checksum))
    (source / 'assets/fixture').unlink()
    (source / 'assets/fixture').symlink_to('/etc/passwd')
    refused(lambda: pilot.inventory(source))
    pilot.ROOT = original_root
    manifest = json.loads((HERE / 'manifest.example.json').read_text())
    manifest['root'] = '/opt/noos'
    invalid = temporary / 'unsafe.json'
    invalid.write_text(json.dumps(manifest))
    refused(lambda: pilot.validate_manifest(invalid))
    manifest['root'] = str(original_root)
    manifest['images_verified'] = True
    invalid.write_text(json.dumps(manifest))
    refused(lambda: pilot.validate_manifest(invalid))
    ports = {'bolt': 9289, 'operations': 9022, 'browser': 9367, 'https': 443}
    original_listeners = pilot.listening_tcp_ports
    original_socket = pilot.socket.socket
    pilot.listening_tcp_ports = lambda: {443}
    refused(lambda: pilot.check_ports_available(ports))
    class ProbeSocket:
        def bind(self, address):
            if address[1] == 443:
                raise PermissionError('would require root')
        def connect_ex(self, address):
            return 1
        def close(self):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            self.close()
    try:
        pilot.listening_tcp_ports = lambda: set()
        pilot.socket.socket = ProbeSocket
        pilot.check_ports_available(ports)
    finally:
        pilot.listening_tcp_ports = original_listeners
        pilot.socket.socket = original_socket

# Exercise the consumer invocation, including sudo's environment allowlist.
manifest = json.loads((HERE / 'manifest.example.json').read_text())
calls = []
service_running = False
def docker_result(command, **options):
    calls.append((command, options))
    assert command[:2] == ['sudo', '-n']
    docker_at = command.index('docker')
    operation = command[docker_at + 1]
    if operation == 'compose':
        preserved = command[2].removeprefix('--preserve-env=').split(',')
        assert set(preserved) == {'PILOT_UID', 'PILOT_GID', 'PILOT_NEO4J_IMAGE', 'PILOT_RUNTIME_IMAGE', 'PILOT_NGINX_IMAGE'}
        # Model sudo's cleared environment: interpolation still has exact IDs/images.
        effective = {key: options['env'][key] for key in preserved}
        assert effective['PILOT_UID'] == str(os.getuid())
        assert effective['PILOT_GID'] == str(os.getgid())
        assert effective['PILOT_RUNTIME_IMAGE'] == manifest['images']['runtime']
        assert 'OPENAI_API_KEY' not in effective
        assert 'IDEAFLOW_CLIENT_SECRET' not in effective
        return SimpleNamespace(returncode=0, stdout='')
    assert command[:3] == ['sudo', '-n', 'docker']
    if operation == 'inspect':
        labels = {'com.docker.compose.project': pilot.PROJECT, 'unlinked.private-pilot.root': str(pilot.ROOT)}
        return SimpleNamespace(returncode=0, stdout=json.dumps(labels) + ('\ntrue' if service_running else '\nfalse'))
    return SimpleNamespace(returncode=0, stdout='29.1.3')

with patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic-secret', 'IDEAFLOW_CLIENT_SECRET': 'synthetic-secret'}), patch.object(pilot.subprocess, 'run', docker_result):
    assert pilot.run(['docker', 'info', '--format', '{{.ServerVersion}}']) == '29.1.3'
    pilot.stop(manifest)
    assert len([args for args, _ in calls if 'compose' in args]) == 1
    assert calls[-1][0][-1] == pilot.PROJECT + '-graph'

calls.clear()
service_running = True
with patch.object(pilot.sys, 'argv', ['pilot.py', 'start', '--execute']), patch.object(pilot.sys, 'platform', 'linux'), patch.object(pilot.socket, 'gethostname', lambda: 'noos'), patch.object(pilot, 'validate_manifest', lambda *args, **kwargs: (manifest, [])), patch.object(pilot, 'check_ports_available', lambda ports: None), patch.object(pilot.subprocess, 'run', docker_result):
    pilot.main()
    assert calls[0][0][2:4] == ['docker', 'info']
    starts = [args for args, _ in calls if 'compose' in args]
    assert len(starts) == 1 and starts[0][-5:] == ['up', '-d', 'graph', 'runtime', 'ingress']
    assert len([args for args, _ in calls if 'inspect' in args]) == 3

calls.clear()
with patch.object(pilot.subprocess, 'run', lambda command, **options: SimpleNamespace(returncode=0, stdout='{}\nfalse')):
    refused(lambda: pilot.stop(manifest))
# Denied sudo never falls back to direct Docker or runs a mutation.
with patch.object(pilot.subprocess, 'run', lambda command, **options: calls.append(command) or SimpleNamespace(returncode=1, stdout='')):
    refused(lambda: pilot.run(['docker', 'info']))
    assert calls == [['sudo', '-n', 'docker', 'info']]

print('PASS: blocked plan, paired recovery roundtrip, production/overwrite refusal, corruption, symlink, unsafe target/image rejection and privileged port checks, sudo-only start/stop, nonsecret interpolation, foreign-container and denied-daemon refusal; no external operations')
