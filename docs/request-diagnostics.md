# Private agent request diagnostics

The standalone runtime can record bounded request metadata for direct REST
(`/api/agent/...`), direct MCP (`/mcp`), and the shared gateway's signed downstream
adapter (`/api/connector/mcp`). It does not instrument browser pages, public web
search, OAuth sign-in/consent, messaging, or the historical Next.js APIs.

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
persisted. Result counts do not prove search completeness. A top-ten AI answer
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
The operator reader requires an exact request/account filter, re-projects rows,
rejects unsafe files, and returns at most500 rows with a `truncated` indicator.
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
