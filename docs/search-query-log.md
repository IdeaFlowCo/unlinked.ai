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

`<pilot-root>/audit/searches/requests-YYYY-MM-DD.jsonl` uses the existing private
store implementation with an independent search schema projection. Directory
mode 700, daily files mode 600, owned by the runtime operator. Symlinks, hard
links and unsafe permissions are refused. The sink re-projects the row before
persisting; the reader does the same before returning it. Diagnostics retains
its own schema and directory.

No sampling or per-minute query quota is applied by this recorder. The bounded
sink queues at most 128 writes, writes at most 8 MiB per UTC date, and retains
seven UTC dates (56 MiB maximum). Expired files are pruned at startup, date
rollover and hourly while enabled. Query records are best effort: crashes,
disconnects before parsing, queue/disk limits or IO failures can lose records.
`sink_dropped_since_last_write` reports omissions at the next successful write;
this is not a complete security audit. Disabling collection leaves existing
files subject to the operator's private cleanup/retention procedure.

Read inside the existing runtime container as its owning operator:

```sh
node /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/scripts/read-search-log.mjs \
  --directory /srv/unlinked-private-guest-pilot-20261001/audit/searches \
  --since 2026-11-11T00:00:00Z
```

The UTC `--since` boundary is mandatory. Optional `--account-id` (computed from a
trusted owner binding) and `--request-id` narrow the result. The reader returns
at most 500 rows and explicitly reports truncation. No new browser or agent
log-reading endpoint exists. Keep query files out of release artifacts, public
CI output and long-lived backups; paired rollback backups must omit this
short-retention query directory.

Tests: `node --test tests/search-activity.test.mjs tests/request-diagnostics.test.mjs tests/request-diagnostics-store.test.mjs`.
Before declaring a release live, send a unique synthetic public query and match
it in the mode-600 file using this reader. Verify the deployed version/source,
kill switch, MCP/REST authentication and protected runtime inputs. Preserve the
previous runtime source/packet for rollback; rollback changes source only, never
restores the graph or files over newer state.
