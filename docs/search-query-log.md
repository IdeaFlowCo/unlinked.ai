# Private search query history

The canonical standalone runtime records product search activity server-side by
default. `UNLINKED_SEARCH_LOG=off` disables it on the next runtime restart.
This is independent of `UNLINKED_REQUEST_DIAGNOSTICS`, which continues to exclude
query text. Source deployment/activation must use the existing scoped release
procedure; a passing source test is not evidence of live collection.

## Coverage and fields

One `search_query` row is emitted when a search response finishes or the client
disconnects, across these current runtime paths:

- Browser People/network directory, public search page and `/api/people`.
- Header autocomplete, profile connection search, company search, and
  `/api/my-connections`.
- Browser AI search (`/ask`, `/search-account`) and the scoped import search.
- Private-list search and whole-result file download queries. Opening the
  download-options page is not counted as a second executed download.
- Direct MCP, signed shared-connector MCP and REST deterministic listings,
  network/Everyone/AI/import searches, private people search/listing and
  `unlinked_export_network` queries (including inline whole-result queries).

The fixed schema retains timestamp, independent server request UUID, transport,
allowlisted search surface, bounded query text and original character count,
query truncation, selected filter values, mode/order/scope, HTTP status,
duration/cancellation and available scalar result/page counts. MCP tool errors
are recorded even with HTTP 200. Blank directory/list queries mean browse-all;
blank static landing pages and HEAD probes are omitted. Autocomplete rows are
labelled separately, so they need not inflate submitted-search reports.

A successfully resolved browser session or authenticated agent grant attaches a
stable SHA-256 pseudonym of the owner (`searchAccountId` in
`mcp-server/search-activity.mjs`), using a separate domain from diagnostics.
Never infer an account from a query, IP, cookie contents, claimed header or
email. Anonymous public searches have no account identifier. Authentication
failures before an agent body is parsed have no query record: they remain in
metadata diagnostics. Invalid public inputs/rate limits are recorded when their
query reaches the server; invalid MCP tool schemas retain a bounded attempted
query and protocol error after authentication.

Query text is limited to 1,024 UTF-16 code units and a 2,048-byte JSON string;
controls are replaced with spaces. `query_truncated` indicates a changed query.
Only the eight documented professional/private-search filter keys are retained,
each bounded to 120 encoded bytes. Nested input, arbitrary paths or IDs,
cursors, headers, credentials, unrelated URL parameters, private notes, source documents,
messages and result contents are excluded. Search text itself can contain
personal information: the entire stream is private operational data. It never
goes to the public directory, client analytics, Docker stdout or HTTP log routes.
Ordinary message searching, legacy Next.js/Supabase routes, local filtering
without a network request and browser history restored without a server request
are outside this runtime stream.

## Storage and inspection

`<pilot-root>/audit/searches/queries-NNNNNNNNNNNN.jsonl` uses a dedicated
single-writer store. Existing `requests-YYYY-MM-DD.jsonl` files from v0.6.108
are counted and retained. Directory mode 700, files mode 600, owned by the
runtime operator; symlinks, hard links and unsafe permissions are refused.
The writer and reader both apply the independent search-schema projection.
Metadata diagnostics keeps its separate seven-date policy.

**There is no age-based deletion.** Query history is retained indefinitely up
to **1 GiB total query-file bytes**, split into segments of at most 8 MiB. Only
actual data consumes disk; no 1 GiB file is preallocated. The writer also leaves
at least 1 GiB free on the filesystem. At the cap (or free-space reserve), it
pauses new appends, counts dropped records and preserves existing history.
Raising the cap or explicitly archiving history is an operator decision; the
runtime never silently deletes older searches to make room. Files already
exceeding a newly lowered cap are preserved and new writes pause.

The queue remains bounded to 128 writes and each row to 4,096 bytes. There is
no sampling or per-minute query quota. Process crashes, queue/disk limits and
IO failures can lose records: this is operational history, not a complete
security audit. `sink_dropped_since_last_write` reports omissions in the next
successful query row; storage status also retains cumulative omission counts.

`storage-status.json` is an atomic, private, mode-600 projection containing
only byte counts, cap/reserve, file count, omission/failure counts, timestamp,
paused state and level (`normal`, `warning`, `full`, `low_disk`, `unavailable`).
It is refreshed at least once per minute and at threshold crossings. Neither
query text nor account identifiers enter that file. Operator inspection:

```sh
node --input-type=module -e 'import {readSearchLogStatus} from "./mcp-server/search-log-store.mjs"; console.log(await readSearchLogStatus({directory:"/srv/unlinked-private-guest-pilot-20261001/audit/searches"}))'
```

The existing M4 `com.jacob.ops-alert-monitor` reads only this storage projection
through its existing read-only Noos container probe every 15 minutes. It creates
one warning episode at 80%, another at the cap, and a warning for low disk or
unavailable/stale status. Query records never leave the server in an alert.
Storage alerts use the existing `ops-alert-email` channel plus the dedicated
Twilio ops number. Independent durable channel receipts mean accepted email
does not clear disabled/failed SMS. SMS remains pending until the existing
Twilio approval and recipient opt-in checks allow it; no permission/verification
checks are bypassed. Ordinary polling/restarts do not resend accepted channel
notifications; a provider acknowledgement lost during a crash can still cause
an at-least-once retry. The operator monitor runbook owns channel configuration. The portable adapter
and its channel/retry tests live in `deploy/private-pilot/ops-alerts/`; its
installed M4 copy is `~/.local/share/ops-alert-monitor/unlinked_storage_alerts.py`.

Read inside the existing runtime container as its owning operator:

```sh
node /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/scripts/read-search-log.mjs \
  --directory /srv/unlinked-private-guest-pilot-20261001/audit/searches \
  --since 2026-11-11T00:00:00Z
```

The UTC `--since` boundary is mandatory. Optional `--account-id` (computed from a
trusted owner binding) and `--request-id` narrow the result. The reader returns
at most 500 rows and explicitly reports truncation. No new browser or agent
log-reading endpoint exists. Keep query files out of public release/CI artifacts. Paired source-release
backups omit this directory; releases and rollbacks never restore or delete
newer query history. Any independent archive must have its own explicit cap
and private access policy.

Tests: `node --test tests/search-log-store.test.mjs tests/search-activity.test.mjs tests/request-diagnostics.test.mjs tests/request-diagnostics-store.test.mjs`.
Before declaring a release live, send a unique synthetic public query and match
it in the mode-600 file using this reader. Verify the deployed version/source,
kill switch, MCP/REST authentication and protected runtime inputs. Preserve the
previous runtime source/packet for rollback; rollback changes source only, never
restores the graph or files over newer state.

Rollback compatibility: a runtime older than v0.6.109 has an age-pruning writer
and a smaller inventory reader. Disable its query collector before any future
rollback to that code, or retain the v0.6.109 storage adapter. Do not let an old
collector prune retained legacy daily files. Other diagnostic streams keep their
existing expiry policy.

## Repeated owner searches after a partial import

A completed archive can have `status: partial` because records were rejected,
even when every accepted observation is indexed. Once the publisher records
`phase: private_observation_index_ready`, `indexGate: null` and
`indexVersion: observation-v1`, its verified rows use the same bounded
owner/import/revision cache as an indexed archive. Gated or unfinished partial
imports still read live. Every use rechecks the live manifest before and after;
republication and account erasure retain their existing invalidation rules.
This avoids repeating a per-observation HTTP/graph read for each directory
search. It does not change accepted/rejected counts or publish private rows.
