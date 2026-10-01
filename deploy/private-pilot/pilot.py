#!/usr/bin/env python3
"""Private release packet. Default is read-only plan; --execute is explicit.

Commands: plan, preflight, start, stop, backup, verify-backup, restore, rollback.
No DNS, certificate, identity-provider or credential registration command exists.
Cold recovery pairs graph (including identities), assets, invitation bundles and
audit state. Restore creates a new isolated rehearsal directory, never the pilot.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time

ROOT = Path('/srv/unlinked-private-guest-pilot-20261001')
PROJECT = 'unlinked-private-guest-pilot-20261001'
ORIGIN = 'https://private.unlinked.ai'
PARTS = ('neo4j-data', 'assets', 'identity-state', 'invitations', 'audit')
HERE = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private(path, directory=False):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), 'symlink_rejected')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'unexpected_file_type')
    require(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), 'private_mode_required')
    require(info.st_uid == os.getuid(), 'operator_ownership_required')


def no_links(path):
    for item in (path, *path.parents):
        if item.exists() or item.is_symlink():
            require(not item.is_symlink(), 'symlink_parent_rejected')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def run(args):
    # Never relay subprocess stderr/stdout: Docker errors may include env data.
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, 'command_failed:' + args[0])
    return result.stdout.strip()


def inventory(root):
    private(root, True)
    files, directories = {}, []
    for base, children, names in os.walk(root, followlinks=False):
        base = Path(base)
        private(base, True)
        if base != root:
            directories.append(str(base.relative_to(root)))
        for name in children:
            private(base / name, True)
        for name in names:
            path = base / name
            private(path)
            files[str(path.relative_to(root))] = {'sha256': digest(path), 'bytes': path.stat().st_size}
    return {'files': files, 'directories': sorted(directories)}


def snapshot(source, destination, source_receipt):
    no_links(source)
    private(source, True)
    require(not destination.exists(), 'new_backup_destination_required')
    no_links(destination)
    destination.mkdir(mode=0o700)
    for part in PARTS:
        private(source / part, True)
        inventory(source / part)
        shutil.copytree(source / part, destination / part)
    payload = inventory(destination)
    payload.update(version=1, kind='quiesced-private-pair', parts=list(PARTS), source=source_receipt)
    path = destination / 'manifest.json'
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        json.dump(payload, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    # The manifest digest lives beside the snapshot and is required on restore.
    checksum = destination.parent / (destination.name + '.sha256')
    with checksum.open('x') as stream:
        os.chmod(checksum, 0o600)
        stream.write(digest(path) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    fsync_tree(destination)
    descriptor = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return checksum


def fsync_tree(root):
    for base, _, names in os.walk(root):
        for name in names:
            with (Path(base) / name).open('rb') as stream:
                os.fsync(stream.fileno())
        descriptor = os.open(base, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def verify_snapshot(root, checksum):
    no_links(root)
    no_links(checksum)
    private(checksum)
    private(root / 'manifest.json')
    require(checksum.read_text().strip() == digest(root / 'manifest.json'), 'manifest_digest_mismatch')
    manifest = json.loads((root / 'manifest.json').read_text())
    require(manifest['version'] == 1 and manifest['kind'] == 'quiesced-private-pair' and manifest['parts'] == list(PARTS), 'paired_manifest_required')
    actual = inventory(root)
    actual['files'].pop('manifest.json')
    require(actual['files'] == manifest['files'] and actual['directories'] == manifest['directories'], 'paired_inventory_mismatch')
    return manifest


def restore_snapshot(backup, checksum, target):
    manifest = verify_snapshot(backup, checksum)
    no_links(target)
    # Strict sibling namespace and NEW path prevent production or legacy restore.
    require(target.parent == ROOT.parent and target.name.startswith(ROOT.name + '-rehearsal-'), 'isolated_rehearsal_target_required')
    require(not target.exists(), 'new_rehearsal_target_required')
    require(re.fullmatch(re.escape(ROOT.name) + r'-rehearsal-[A-Za-z0-9_-]+', target.name), 'rehearsal_name_invalid')
    target.mkdir(mode=0o700)
    for part in PARTS:
        shutil.copytree(backup / part, target / part)
    private(target, True)
    actual = inventory(target)
    require(actual['files'] == manifest['files'] and actual['directories'] == manifest['directories'], 'restore_digest_mismatch')
    fsync_tree(target)


def validate_manifest(path, execution=False, recovery=False):
    no_links(path)
    manifest = json.loads(path.read_text())
    require(manifest['root'] == str(ROOT) and manifest['project'] == PROJECT and manifest['origin'] == ORIGIN, 'exact_target_required')
    require(manifest['callback'] == ORIGIN + '/auth/callback/ideaflow', 'exact_callback_required')
    require(manifest['gcp'] == {'project': 'lightsail-migration', 'instance': 'noos', 'zone': 'us-central1-a'}, 'existing_host_required')
    require(manifest['ports'] == {'bolt': 9289, 'operations': 9022, 'browser': 9367, 'https': 443}, 'owned_ports_required')
    if recovery:
        # Stopping/recovering owned state must work after cert expiry, DNS loss,
        # credential removal or superseded source approvals.
        private(path)
        no_links(ROOT)
        private(ROOT, True)
        for part in (*PARTS, 'backups'):
            private(ROOT / part, True)
        return manifest, []
    if manifest['provider_client_registered']:
        issuer = manifest['provider_request']['issuer']
        require(issuer.startswith('https://') and 'REQUIRES_' not in issuer and 'REQUIRES_' not in manifest['provider_request']['client_id'], 'exact_registered_provider_required')
        require(manifest['provider_request']['redirect_uri'] == manifest['callback'] and manifest['provider_request']['method'] == 'client_secret_basic' and manifest['provider_request']['pkce'] == 'S256', 'reviewed_provider_contract_required')
    blockers = []
    for name in ('unlinked', 'noos'):
        source = manifest['sources'][name]
        require(re.fullmatch(r'[a-f0-9]{40}', source['sha']), 'exact_source_sha_required')
        checkout = Path(source['checkout'])
        require(checkout == ROOT / 'runtime' / name, 'exact_isolated_source_destination_required')
        if checkout.is_dir():
            head = run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'])
            require(head == source['sha'], 'source_head_mismatch:' + name)
            require(not run(['git', '-C', str(checkout), 'status', '--porcelain']), 'clean_source_required:' + name)
        else:
            blockers.append('missing_exact_source_checkout:' + name)
        if not source['approved'] or not source['final_receipt_sha256']:
            blockers.append('missing_source_approval_or_final_receipt:' + name)
        else:
            require(re.fullmatch(r'[a-f0-9]{64}', source['final_receipt_sha256']), 'receipt_digest_required')
            receipt = Path(source['final_receipt'])
            require(receipt.is_file() and not receipt.is_symlink() and digest(receipt) == source['final_receipt_sha256'], 'source_receipt_mismatch:' + name)
    for name in ('neo4j', 'runtime', 'nginx'):
        require(re.fullmatch(r'[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}', manifest['images'][name]), 'approved_digest_image_required')
        if manifest['images_approved']:
            require(not manifest['images'][name].endswith('0' * 64), 'placeholder_image_rejected')
        if not manifest['images_approved']:
            blockers.append('image_approval_pending:' + name)
    for flag in ('target_security_approved', 'provider_client_registered', 'dns_tls_ready', 'persistent_secret_destinations_approved', 'invitation_activation_approved'):
        if not manifest[flag]:
            blockers.append(flag)
    if not manifest['openai_persistent_destination_confirmed']:
        blockers.append('openai_persistent_destination_confirmation')
    for name in ('runtime_env', 'graph_env', 'operator_config', 'invitation_bundle', 'wiring', 'certificate', 'certificate_key'):
        location = Path(manifest['destinations'][name])
        no_links(location)
        require(location.is_relative_to(ROOT), 'private_destination_outside_root')
        if not location.is_file():
            blockers.append('missing_private_destination:' + name)
        elif execution:
            private(location)
    if not manifest['wiring_sha256']:
        blockers.append('missing_reviewed_wiring_digest')
    else:
        require(re.fullmatch(r'[a-f0-9]{64}', manifest['wiring_sha256']), 'wiring_digest_required')
        wiring = Path(manifest['destinations']['wiring'])
        require(wiring.is_file() and digest(wiring) == manifest['wiring_sha256'], 'reviewed_wiring_digest_mismatch')
    require(manifest['destinations']['wiring'] == str(ROOT / 'runtime/wiring.mjs'), 'reviewed_runtime_wiring_required')
    require(manifest['destinations']['runtime_env'] == str(ROOT / 'runtime/runtime.env') and manifest['destinations']['graph_env'] == str(ROOT / 'runtime/graph.env'), 'exact_compose_env_destinations_required')
    if execution:
        private(path)
        private(ROOT, True)
        for part in (*PARTS, 'runtime', 'backups', 'runtime/tls'):
            private(ROOT / part, True)
        require(not blockers, 'activation_blocked:' + ','.join(blockers))
        require({item[4][0] for item in socket.getaddrinfo('private.unlinked.ai', 443, family=socket.AF_INET)} == {'34.10.134.247'}, 'exact_private_dns_target_required')
        run(['openssl', 'x509', '-in', manifest['destinations']['certificate'], '-noout', '-checkhost', 'private.unlinked.ai'])
        run(['openssl', 'x509', '-in', manifest['destinations']['certificate'], '-noout', '-checkend', '86400'])
    return manifest, blockers


def owned_services(stopped=False, running=False):
    for service in ('ingress', 'runtime', 'graph'):
        name = PROJECT + '-' + service
        output = run(['docker', 'inspect', '--format', '{{json .Config.Labels}}\n{{.State.Running}}', name]).splitlines()
        labels = json.loads(output[0])
        require(labels.get('com.docker.compose.project') == PROJECT and labels.get('unlinked.private-pilot.root') == str(ROOT), 'foreign_container_rejected')
        if stopped:
            require(output[1] == 'false', 'cold_quiesced_pair_required')
        if running:
            require(output[1] == 'true', 'owned_service_not_running')


def compose_env(manifest):
    # Only approved image digests are added to child environment; no secret reads.
    environment = dict(os.environ)
    environment['PILOT_UID'] = str(os.getuid())
    environment['PILOT_GID'] = str(os.getgid())
    for name, variable in (('neo4j', 'PILOT_NEO4J_IMAGE'), ('runtime', 'PILOT_RUNTIME_IMAGE'), ('nginx', 'PILOT_NGINX_IMAGE')):
        environment[variable] = manifest['images'][name]
    return environment


def stop(manifest):
    owned_services()
    result = subprocess.run(['docker', 'compose', '-p', PROJECT, '-f', str(HERE / 'compose.yaml'), 'stop', 'ingress', 'runtime', 'graph'], env=compose_env(manifest), capture_output=True, timeout=120)
    require(result.returncode == 0, 'owned_stop_failed')
    owned_services(stopped=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'preflight', 'start', 'stop', 'backup', 'verify-backup', 'restore', 'rollback'])
    parser.add_argument('--manifest', type=Path, default=HERE / 'manifest.example.json')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--checksum', type=Path)
    parser.add_argument('--rehearsal', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'verify-backup':
        require(args.backup and args.checksum, 'backup_and_checksum_required')
        verify_snapshot(args.backup, args.checksum)
        print(json.dumps({'status': 'paired_digests_verified'}))
        return
    if args.command == 'restore':
        require(args.backup and args.checksum and args.rehearsal, 'new_rehearsal_arguments_required')
        verify_snapshot(args.backup, args.checksum)
        require(args.rehearsal.parent == ROOT.parent and re.fullmatch(re.escape(ROOT.name) + r'-rehearsal-[A-Za-z0-9_-]+', args.rehearsal.name) and not args.rehearsal.exists(), 'new_isolated_rehearsal_required')
        if args.execute:
            restore_snapshot(args.backup, args.checksum, args.rehearsal)
        print(json.dumps({'status': 'restored_isolated_rehearsal' if args.execute else 'restore_dry_run'}))
        return
    recovery = args.execute and args.command in ('stop', 'rollback', 'backup')
    manifest, blockers = validate_manifest(args.manifest, execution=args.execute or args.command == 'preflight', recovery=recovery)
    if not args.execute:
        print(json.dumps({'status': 'blocked' if blockers else 'ready_plan_only', 'action': args.command, 'root': str(ROOT), 'blockers': blockers, 'mutations': False}, indent=2))
        return
    require(args.command not in ('plan', 'preflight'), 'read_only_command')
    require(sys.platform == 'linux', 'existing_gcp_linux_host_required')
    require(socket.gethostname().split('.')[0] == 'noos', 'existing_noos_host_required')
    if args.command == 'start':
        # Socket probes allocate no persistent service or firewall rule.
        for port in manifest['ports'].values():
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        result = subprocess.run(['docker', 'compose', '-p', PROJECT, '-f', str(HERE / 'compose.yaml'), 'up', '-d', 'graph', 'runtime', 'ingress'], env=compose_env(manifest), capture_output=True, timeout=120)
        require(result.returncode == 0, 'owned_start_failed')
        owned_services(running=True)
        print(json.dumps({'status': 'started_not_live_accepted', 'real_guest_acceptance': 'unlinked-9a9'}))
    elif args.command in ('stop', 'rollback'):
        stop(manifest)
        # No down -v, purge, legacy stop, provider mutation or receipt deletion.
        print(json.dumps({'status': 'owned_runtime_stopped_private_state_preserved', 'external_grant_or_client_revocation': 'identity_owner_separate_operation'}))
    elif args.command == 'backup':
        owned_services(stopped=True)
        target = ROOT / 'backups' / ('cold-pair-' + str(time.time_ns()))
        checksum = snapshot(ROOT, target, manifest['sources'])
        verify_snapshot(target, checksum)
        print(json.dumps({'status': 'paired_backup_verified', 'backup': str(target), 'checksum': str(checksum)}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.SubprocessError):
        # Do not serialize exception messages or credential-bearing paths/data.
        print(json.dumps({'status': 'refused', 'reason': 'explicit_target_sources_private_inputs_or_recovery_verification_failed'}), file=sys.stderr)
        sys.exit(2)
