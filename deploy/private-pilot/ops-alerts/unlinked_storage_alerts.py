"""Private Unlinked storage metrics -> persistent per-channel ops warnings.
No query text or account data is read, copied, or sent to an alert channel.
"""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

QUERYLOG_PROBE = r'''sudo -n docker exec unlinked-private-guest-pilot-20261001-runtime node --input-type=module -e '
import {readSearchLogStatus} from "/srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/search-log-store.mjs";
try { const s=await readSearchLogStatus({directory:"/srv/unlinked-private-guest-pilot-20261001/audit/searches"});console.log("Q|"+JSON.stringify(s)) } catch { console.log("Q|unavailable") }
' 2>/dev/null || echo 'Q|unavailable'
'''


def observations(output, started, make_observation):
    data = None
    for line in output.splitlines():
        if line.startswith('Q|'):
            try:
                value = json.loads(line[2:])
                if value.get('event') == 'search_log_storage' and value.get('schema') == 1:
                    data = value
            except (ValueError, TypeError, AttributeError):
                pass
    valid = data is not None and all(type(data.get(k)) is int and data[k] >= 0 for k in ('used_bytes', 'cap_bytes')) and data['cap_bytes'] > 0
    level = data.get('level') if valid else 'unavailable'
    if valid:
        try:
            age = datetime.fromisoformat(started.replace('Z','+00:00')) - datetime.fromisoformat(data['at'].replace('Z','+00:00'))
            if age.total_seconds() > 600 or age.total_seconds() < -120:
                level = 'unavailable'
        except (KeyError, ValueError, TypeError):
            level = 'unavailable'
    if level not in ('normal','warning','full','low_disk','unavailable'):
        level = 'unavailable'
    mib = f"{data['used_bytes']/1048576:.1f} / {data['cap_bytes']/1048576:.0f} MiB" if valid else 'unknown'
    messages = {
        'warning': f'Unlinked query log is at least 80% full ({mib}). Review its cap before new logging pauses. Existing history is retained.',
        'full': f'Unlinked query log reached its storage cap ({mib}). New query logging is paused; existing history is retained. Review the cap or archive history.',
        'low_disk': 'Unlinked query logging paused to preserve server free space. Existing history is retained. Check the server disk.',
        'unavailable': 'Unlinked query-log storage status is unavailable or stale. Check the private log writer and status file.'}
    return [make_observation('querylog:'+key, 'querylog', level == key, key.upper() if level == key else 'CLEAR', 'prod', date=started[:10], text=message if level == key else '') for key,message in messages.items()]


def enqueue(state, key, observation, started):
    state.setdefault('querylog_delivery', {}).setdefault(key, {'at':started, 'text':observation['text'], 'email_receipt':None, 'sms_receipt':None})


def send_email(text):
    result = subprocess.run([str(Path.home()/'.local/bin/ops-alert-email'), 'Unlinked query-log storage warning'], input=text+'\n', text=True, capture_output=True, timeout=40)
    return 'email:ops-alert-email' if result.returncode == 0 else None


def flush(state, started, sms_sender, persist, email_sender=send_email):
    """Acceptance receipts are independent. Disabled/failed SMS stays queued.

    Delivery can be at least once after a process/network failure at the provider
    acknowledgement boundary; normal polling and restarts do not duplicate it.
    """
    for key, item in state.setdefault('querylog_delivery', {}).items():
        if not item.get('email_receipt'):
            try:
                receipt = email_sender(item['text'])
                if receipt:
                    item['email_receipt'] = receipt
                    persist()
            except Exception:
                pass
        if not item.get('sms_receipt'):
            try:
                receipts = sms_sender(item['text'])
                if receipts:
                    item['sms_receipt'] = '+'.join(receipts)
                    persist()
            except Exception:
                pass
        if item.get('email_receipt') and item.get('sms_receipt'):
            state.setdefault('notified', {})[key] = {'at':started, 'via':item['email_receipt']+'+'+item['sms_receipt']}
    persist()
    return sum(int(not v.get('email_receipt')) + int(not v.get('sms_receipt')) for v in state['querylog_delivery'].values())
