#!/usr/bin/env python3
"""Lightweight release consumer checks; no Docker, network, graph or secrets."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

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

print('PASS: blocked plan, paired recovery roundtrip, production/overwrite refusal, corruption, symlink and unsafe target/image rejection; no external operations')
