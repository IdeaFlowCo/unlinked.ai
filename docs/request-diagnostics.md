# Private agent request diagnostics

Query text is stored separately by the [private search query history](search-query-log.md), enabled independently. The content-free diagnostics contract below is unchanged.

The standalone runtime can record bounded request metadata for direct REST
(`/api/agent/...`), direct MCP (`/mcp`), and the shared gateway's signed downstream
adapter (`/api/connector/mcp`). Public directory reads produce only the
[admission aggregates](#public-directory-admission-aggregates) described below,
not per-request browser records. Browser click-to-content timing has a separate
[collector and private report](browser-performance.md), enabled independently. OAuth sign-in/consent, messaging, and the
historical Next.js APIs are not instrumented.

This is **off by default**. Building, merging, deploying, and enabling diagnostics
are separate actions. There is no production activation in this change. Use the
existing canonical runtime release gates before setting
`UNLINKED_REQUEST_DIAGNOSTICS=on` in its protected runtime environment. Keep nginx
access/error logging and Docker stdout logging unchanged. Removing the flag
stops collection on the next approved runtime restart; it does not erase files.

## Record contract

`schema: 1`, `event: agent_request`, one row when an HTTP response finishes or
closes. `at` and `completed_at` are server UTC timestamps; `duration_ms` uses a
monotonic clock. The server generates a fresh UUIDv4 and returns it in
`X-Request-ID`, including on authentication failures. Caller `X-Request-ID`,
`traceparent`, JSON-RPC IDs, proxy IPs and user agents are never trusted or stored.
A client can correlate a direct response header with exactly one retained row.

Fields describe transport, HTTP method, a fixed route template (never a raw URL),
an allowlisted RPC method/tool, auth type/outcome, actual HTTP status (null if no
headers were sent), typed error class, duration and observed body byte counts.
`account_id` appears only after successful authentication against the existing
trusted owner boundary. It is SHA-256 of
`unlinked-diagnostics-owner-v1\0` followed by the authenticated owner ID. It is a
stable opaque pseudonym, not a caller-provided identity, email, name, subject or
bearer token. Direct OAuth and copyable account grants both use
`auth_type: account_bearer`; the shared adapter uses `gateway_assertion`; the old
invited-import path uses `private_bearer`. Provisioning uses
`provisioning_client`; its account pseudonym is attached only after the returned
grant has been verified. Auth infrastructure failures are `unavailable`, not
credential rejection.

Available scalar details include query character count (not text), page limit,
cursor presence (not value), requested timeout, result count, next-page presence,
explicit truncation, considered/indexed/model-candidate counts, cancellation,
timeout and rate-limit flags. Missing fields mean **not observed**, not false or
zero. A 200 MCP response can still have a typed tool error or `protocol_error`
(e.g. rejected tool/schema). Provider HTTP/context-limit causes map to fixed
`failure_stage` values; exception messages, stacks and provider bodies are never
persisted.

`unlinked_lookup_contact` failures also name the step that failed in
`failure_stage` and, for public-index steps, an allowlisted `index_failure`
reason distinguishing timeouts, cancellation, stale indexes, validation or
worker/reader refusals, and unexpected exceptions. `STAGES` and `INDEX_REASONS`
in `mcp-server/request-diagnostics.mjs` own the exact vocabularies.
An unexpected exception in the lookup tool, index worker or reader also writes
one fixed stderr line, for example
`unlinked_public_index_worker_error method=lookup class=TypeError at=reader.mjs:531`:
the method, the error class and the first public-people source location only,
never its message or data. Private-notes, investor-import and lookup tools are
recorded by name instead of `unknown`. Result counts do not prove search completeness. A top-ten AI answer
is not labeled truncated unless the result contract explicitly says so.

No Authorization, Cookie, credentials, raw query, path ID, URL parameters, RPC
arguments, result contents, cursor, model input/output, arbitrary tool/method
name, error message or stack can enter the record. The sink and reader apply
another allowlist projection. Records are operational personal data despite
pseudonymization; keep them private.

Body counts exclude HTTP headers and compression/framing. Request bytes are
observed at the incoming stream before application consumption, without putting
it into flowing mode. A body rejected early may be incomplete; response bytes
count attempted application writes, not acknowledged delivery. Check
`request_complete`/`response_complete`. Cancellation rows may be emitted before
later backend cleanup finishes. A process crash cannot emit its final row.

## Shared gateway boundary

The adapter ignores incoming request/trace IDs. Only after the existing
signature, audience, scope, body-hash and replay checks succeed does it record
SHA-256 of the assertion's one-use `jti` as `gateway_assertion_hash`. The raw
assertion, subject and `jti` are not stored. This supports comparison with a
separately authorized gateway-side digest, not a new authentication mechanism.
A rejected/replayed assertion gets no hash or account ID.

The downstream adapter also returns its own `X-Request-ID`. The current shared
gateway does **not** expose that downstream response header to the end client or
log matching assertion hashes. End-to-end gateway correlation therefore remains
limited to an operator-observed downstream response or independently available
trusted assertion digest. Do not equate unrelated Cloud Run request IDs with
Unlinked IDs. This PR does not change the gateway or its other app destinations.

## Storage, bounds and access

The runtime operator alone owns `<pilot-root>/audit/requests` (mode700).
`requests-YYYY-MM-DD.jsonl` files are mode600; symlinks, hard links, wrong owners
and non-private modes are refused. Startup fails if an explicitly enabled store
cannot initialize securely. Runtime sink failures drop metadata and never alter
authentication, tool results or HTTP status.

- At most600 completed request rows per minute, per runtime instance.
- At most128 queued writes and4096 bytes per row.
- At most8MiB per UTC day. Once full, remaining rows for that day are dropped.
- Seven UTC calendar dates, at most56MiB under the single-writer deployment.
  Expired owned files are pruned on startup, date rollover and an hourly timer.
  The timer runs only while diagnostics is enabled. When disabling/shutting down,
  the operator must remove expired diagnostics through the approved cleanup
  procedure; no deletion occurs while the process is stopped.

`dropped_since_last_emit` and `sink_dropped_since_last_write` count omissions
since the next successful stage. A full disk or sustained failures may prevent
these counters being persisted. Logging is best-effort, not a complete audit of
all requests or a security ledger. No new public log-reading endpoint exists.
The operator reader re-projects rows, rejects unsafe files, and returns at
most500 rows with a `truncated` indicator. Agent request lookup requires an
exact request/account filter; the separate
[aggregate lookup mode](#public-directory-admission-aggregates) requires a time boundary.
Only the approved single runtime writes this directory; concurrent writers are
not supported. Do not include request logs in public release/CI artifacts or
long-lived backups that defeat this retention policy.

## On-demand correlation after approved deployment and activation

1. Ask the client to repeat **one** small successful operation and **one** failing
   operation using its existing connection. Record server response
   `X-Request-ID` for each, approximate local time with timezone, endpoint/tool,
   HTTP status/typed error, elapsed time and query length. Do not ask for a key,
   request headers, private query text or result bodies. If the host hides
   headers, request its sanitized execution details and exact time instead.
2. As the private runtime operator, run the checked-in reader against its own
   mounted directory (inside the existing runtime container):

   ```sh
   node /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/scripts/read-request-diagnostics.mjs \
     --directory /srv/unlinked-private-guest-pilot-20261001/audit/requests \
     --request-id UUID-FROM-RESPONSE
   ```

   Use the existing explicit GCP account/project/zone SSH route and container
   execution permissions. No Peter credential or impersonation is needed.
3. If only a timestamp is available, first resolve the account through a verified
   issuer/subject binding, not its display name. Compute `diagnosticAccountId`
   from that trusted owner ID using `mcp-server/request-diagnostics.mjs`; then:

   ```sh
   node scripts/read-request-diagnostics.mjs --directory /PRIVATE/audit/requests \
     --account-id OPAQUE-64-HEX-ID --since 2026-10-09T04:45:00Z
   ```

   Authentication failures deliberately have no account ID and require a
   response request ID. Never attach them to an owner based on a claimed header.
4. Compare `transport`, `auth_outcome`, `tool`, `http_status`, `error_class`,
   timeout/cancellation flags and sizes/counts. Distinguish400 input limits,
   401 grant rejection/revocation,429 budgets,413 result size and503 upstream
   failures. For MCP, inspect the error class even when HTTP is200. A cancelled
   response does not establish whether the host, network or user caused it.
5. Save only the selected sanitized rows in the private incident directory.
   Missing rows can mean diagnostics was off, retention/volume limits, sink
   failure, a process crash or a different destination; absence is not proof
   that no request occurred. These logs cannot recover Peter's earlier calls.

Before activation, an isolated synthetic success, rejection, typed error,
timeout and cancellation verify the record/response ID path. After activation,
use an authorized test persona for one read and invalid synthetic credential for
one rejection; match their IDs in the private store. Confirm file modes, bounds,
release source/version and rollback before declaring live diagnostic coverage.

## Public directory admission aggregates

The same default-off collection gate also records `public_admission` schema-1 aggregates: UTC minute, lane (`anonymous`/`arrival`/`viewer`/`preview`; `arrival` = a light visitor or card scan admitted ahead of the shared fuse; `preview` = a link unfurler on its own small profile lane, [docs/link-previews.md](link-previews.md)), route family (`profile`/`connections`/`company`/`search`), reason (`admitted`/`minute`/`capacity`/`cancelled`) and count. At most 51 rows per completed minute, flushed on the next admission; the current partial minute may be lost on shutdown. No account, IP, user agent, handle or query is collected; the per-visitor budget key lives only in process memory. Retention, file size and queue bounds are identical to agent diagnostics. This distinguishes minute exhaustion from concurrency pressure without enabling access logs.

Read only aggregate counters with `node scripts/read-request-diagnostics.mjs --directory /absolute/private/audit/requests --event public_admission --since 2026-10-24T00:00:00Z`. The explicit UTC time boundary is required. This mode excludes agent request rows and cannot be combined with account/request filters; those retain their existing exact-filter requirement. All file ownership, mode, link and 500-record bounds remain in force.

## Runtime health rows

With diagnostics on, the runtime also writes one `event: runtime_health` row
per minute to the same private sink. Every signed-in page and agent call is
served by this one Node process, so a long major garbage collection or a
synchronous rebuild stalls all of them at once. These rows put that next to
request and [browser timings](browser-performance.md). Rows contain numbers
only, and no request, owner, route or error content:

- `uptime_s`, `interval_ms`
- memory: `rss_mb`, `heap_used_mb`, `heap_total_mb`, `heap_limit_mb`
  (V8's effective limit), `external_mb`, `array_buffers_mb`
- garbage collection during the interval: `gc_major_count`, `gc_major_ms`,
  `gc_major_max_ms`, `gc_minor_count`, `gc_minor_ms`, `gc_incremental_count`,
  `gc_incremental_ms`
- event-loop delay at 20 ms resolution: `loop_delay_p50_ms`,
  `loop_delay_p99_ms`, `loop_delay_max_ms`
- CPU during the interval: `cpu_user_ms`, `cpu_system_ms`

Sampling starts before the cold public index build, so warm-up pressure is
included. A process that aborts loses its final partial minute.

The operator report infers restarts from uptime resets. Per UTC hour it reports
maximum heap use, minimum heap headroom, major-GC totals, the worst loop delay,
minutes with a stall of at least 1 s, and CPU percentage:

```sh
node scripts/read-runtime-health.mjs --directory <private requests dir> --since 2026-11-06T00:00:00Z
```

Container PID 1 note: Node runs as the container's PID 1 without an init
process. A fatal V8 error (for example `Reached heap limit`) calls `abort()`.
PID 1 ignores SIGABRT, so glibc falls back to a trapping instruction, and the
process exits **139**. The kernel logs `general protection fault ... in
libc.so.6`. Read that combination as an abort, usually heap exhaustion, rather
than a native memory bug. With `init: true` the same abort exits 134.

## Stall profiles (opt-in)

Set `UNLINKED_STALL_PROFILE_DIR` to an existing directory with mode 700, owned by the runtime user, and the runtime records what blocked its main thread.

- **How it samples.** The runtime runs V8's sampling profiler in-process (`node:inspector` `Session.connect()`), with no port and no external attach, at 10 ms sampling. That still gives about 50 samples per 500 ms stall. A 20 ms ticker notes every main-thread gap of at least 500 ms.
- **When it rotates.** It rotates (stop, summarize, restart) only after a 60 s window that had stalls, or once the running profile is 5 minutes old. Stopping a profile blocks the loop for a time that grows with its samples and nodes. In 0.6.92, which sampled at 1 ms and rotated every minute, that cost about 0.75 s every minute and appeared as a stall with no samples. The profiler's own rotation gap is now reported as `rotation_ms` and `self_stalls`, never as a stall.
- **What it writes.** At the end of a window that had stalls, only the samples taken during those gaps are summarized. One mode-600 file `stall-YYYYMMDDTHHMMSSZ.json` is written, holding:
  - stall count and lengths;
  - `app`: inclusive time in our own code (`mcp-server/`, `src/`), so runtime internals such as `runMicrotasks` don't hide the frame that did the work;
  - top self and inclusive frames, as `function file:line` with milliseconds;
  - the heaviest stacks.
- **Privacy.** Only code locations and numbers are written, never request, owner, argument or value data.
- **Retention.** The newest 240 files are kept.
- **Cost.** Sampling overhead is small at 10 ms, but each rotation (after every stall window, and at least every 5 minutes) blocks the loop while V8 serializes the profile. On the production host that took 0.8–1.2 s (0.6.93, 2026-11-06), because cost follows the number of distinct stacks. **Enable it only while investigating, then unset it.**
- **Stopping.** Unset the variable to stop on the next restart.
