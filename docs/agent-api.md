# Unlinked Agent API — versioned contract (v1)

Status: **v1** (2026-10-02). **v1.1** (2026-10-02, additive): server-to-server
grant provisioning for allow-listed confidential clients, and the
`client_unauthorized` error code — see "Grant provisioning" below. This document is the integration contract for agent
consumers (for example the Ideaflow MCP connector). The hosted MCP tools at
`/mcp` are thin wrappers over the same tool service as the HTTP JSON endpoints
below; names map 1:1 and both surfaces return the same shapes and typed errors.
Breaking changes require a new path version (`/api/agent/v2/...`); additive
fields and additive tools (via grant versions, below) are not breaking.

Implementation: `mcp-server/account-tools.mjs` (service),
`mcp-server/account-api.mjs` (HTTP), `mcp-server/account-hosted.mjs` (MCP),
`mcp-server/account-grants.mjs` (grants). Tests: `tests/account-agent-api.test.mjs`.

## Targeting

| Environment | Base URL | Notes |
|---|---|---|
| Production | `https://www.unlinked.ai` | Canonical standalone runtime. MCP endpoint `https://www.unlinked.ai/mcp`; HTTP API under `https://www.unlinked.ai/api/agent/v1/`. |
| Staging / rehearsal | An isolated private-pilot deployment (`deploy/private-pilot/README.md`), e.g. `https://private.unlinked.ai` when provisioned | Same contract; synthetic data modes exist — do not assume production data. |
| Local development | A loopback `startPrivatePilot` instance (tests show the wiring) | Serves the same `/mcp` and `/api/agent/v1/` routes. |

Consumers should take the base URL as configuration and never hard-code
production. There is no header or token difference between environments: a
grant is only valid on the origin that issued it.

## Authentication and linkage (fail closed)

Every call requires `Authorization: Bearer <account grant token>` — the
per-user, revocable, read-only grant issued in **Settings → Connect my agent**
on the runtime. There is no anonymous access to any `/api/agent/v1/` route and
no email-based linkage anywhere: the grant token *is* the account linkage, and
`unlinked_whoami` returns the stable Unlinked `ownerId` so a consumer can
verify linkage explicitly. Callers without a usable grant get typed
`not_linked` — never empty results.

Grant revocation is checked on **every** call, and re-checked after the tool
body runs, so a revocation mid-call returns `grant_revoked` rather than data.
`grant_revoked` is terminal — discard the token. A transient failure while
verifying an otherwise valid token returns `upstream_unavailable` instead:
retry with the same token.
Deleting the account tombstones all owner data and revokes grants
(`account_data_deleted` flow); a deleted account's tokens fail `grant_revoked`.

## Grant-scope versioning (how old grants keep working)

A grant record stores the exact tool list it was issued with plus a catalog
`version`. Authentication accepts a record only when its stored list equals
the catalog entry for `(version, scope)` in
`ACCOUNT_GRANT_TOOL_VERSIONS` (`mcp-server/account-grants.mjs`):

| Version | `owner_network` scope | `owner_network_and_public` scope |
|---|---|---|
| 1 (pre-existing grants) | `unlinked_search_network` | + `unlinked_search_everyone` |
| 2 | + `unlinked_whoami`, `unlinked_list_connections`, `unlinked_ai_search` | + `unlinked_whoami`, `unlinked_list_people`, `unlinked_list_connections`, `unlinked_get_profile`, `unlinked_ai_search` |
| 3 (current issuance) | version 2 + `unlinked_list_connection_requests`, `unlinked_list_notifications` (read-only) | version 2 + the same two tools |

- Old grants keep exactly their issued tools on both surfaces — MCP
  `tools/list` for a v1 grant still shows only the launch tools, and the HTTP
  API answers `scope_not_granted` for tools outside the grant.
- Adding tools later = adding version 3 to the catalog and issuing new grants
  with it. No existing record changes shape, no token is reissued, no
  consumer breaks. This is the committed migration pattern.
- Automatic grant provisioning (the in-flight profile-card/QR work) composes
  with this: `issueGrant(owner)` always writes the current catalog version,
  and authentication tolerates every cataloged version side by side.

OpenChat's production integration — stateless JSON-RPC `tools/call` POSTs to
`/mcp` invoking `unlinked_search_network` / `unlinked_search_everyone` — is
preserved exactly (names, stateless POST without initialize) and covered by
test. Since the typed-failure fix (PR #53), the two launch tools also return
the sanitized typed JSON failure shape below instead of their original
free-text error sentences.

## Typed errors

Error responses are `{"error":{"code":<code>,"message":<human text>}}` with
the HTTP status below. On MCP, tool failures return `isError: true` with the
same JSON object as the text content (launch tools included; theirs may carry
an extra sanitized `cause` identifier).

| Code | HTTP | Meaning |
|---|---|---|
| `not_linked` | 401 | Missing/invalid bearer token — no linked Unlinked account. Never silently empty. |
| `grant_revoked` | 401 | Token verified but the grant was revoked, superseded or its account deleted. |
| `invalid_input` | 400 | Parameter failed validation (also unknown/repeated parameters). |
| `cursor_invalid` | 400 | Cursor does not match the current listing (query/degree/revision changed). Restart from page one. |
| `client_unauthorized` | 403 | (v1.1, provisioning only) Unknown confidential client id or wrong client secret. |
| `scope_not_granted` | 403 | Tool or scope not included in this grant's catalog entry. |
| `not_found` | 404 | No published profile/route/tool with that id. |
| `degree_unproven` | 409 | Second-degree requested without recorded public paths (no confirmed anchor). Paths are never inferred. |
| `result_too_large` | 413 | Result would exceed 1 MiB; narrow the query or page size. |
| `rate_limited` | 429 | Budget exhausted; honor `Retry-After`. |
| `upstream_unavailable` | 503 | Index/AI/backend unavailable or AI time budget exceeded. Retry. |

This vocabulary may be extended, never renamed.

## Pagination and size

- Cursors are opaque strings; treat them as such. They are bound to the
  owner, query, degree and data revision — any change yields `cursor_invalid`.
- `limit` is 1–50; default and maximum page size is **50**.
- Every response is capped at **1 MiB**.
- List responses carry `total`, a `revision` (snapshot or content hash — if it
  changes between pages, restart) and `nextCursor` only when more rows exist.

## Rate limits and latency

- Deterministic tools (`whoami`, `list_people`, `list_connections`,
  `get_profile`): 120 requests/min **per grant owner**; expected well
  under 1 s p95 at the current index size (~16k profiles, in-memory snapshot).
- AI tools (`ai_search`, `search_network` free-text mode, `search_everyone`):
  20/min, 2000/day and 2 in flight **per grant owner**, plus a shared ceiling
  of 8 concurrent AI calls per runtime. These budgets are enforced on the
  HTTP API and on the new MCP tools; the two launch tools keep their
  historical unmetered behavior **on the MCP surface only** (preserved for
  existing integrations). **Known conflict with a 10 s consumer
  timeout:** these call a provider with batched ranking rounds; worst case is
  bounded at 40 s and p95 is not guaranteed under 10 s. Mitigations the
  contract commits to: `unlinked_ai_search` accepts `timeoutMs` (1000–40000) and
  fails typed `upstream_unavailable` when the budget elapses, so a consumer
  wanting a hard 10 s SLA should send `timeoutMs: 9000` and fall back to the
  deterministic listings. Streamed/async AI results are not offered in v1.

## Privacy and field visibility

Hard fences, identical on both surfaces and strictly narrower than the
human-facing profile card (card-only opt-ins such as phone never appear here):

- **Never returned:** contact email/phone, raw archives/original files,
  credential or signed URLs, other owners' private imports.
- Every entry/result is labeled `visibility: "public"` (published People
  index / recorded public paths) or `"owner_private"` (the grant owner's own
  imported observations, visible only to that grant).
- Owner-imported connection entries expose only: `name`, `headline`
  (position), `company`, validated `linkedinUrl`, ids and provenance.

## Degree semantics

- `degree 1` **includes owner-imported contacts even without a confirmed
  legacy profile anchor** (provenance `{"type":"owner_import", importId, rowId}`),
  plus recorded public first-degree paths when an anchor is confirmed
  (provenance `{"type":"recorded_public_path", path:{fromId,toId}, revision}`).
- `degree 2` returns **only recorded public paths** — both endpoints in the
  published snapshot, reached through the confirmed anchor — with the proving
  `path {fromId, viaId, toId}` and snapshot `revision` on every entry. Without
  an anchor the call fails `degree_unproven`. Second degree is never inferred
  from imports, names or emails.

## Endpoints (HTTP ⇄ MCP tool)

All JSON. GET parameters are query-string; POST bodies are
`application/json` (≤ 8 KiB). Unknown or repeated parameters are `invalid_input`.

### `GET /api/agent/v1/whoami` ⇄ `unlinked_whoami`
Response: `{ kind, ownerId, grant: { scope, version, tools }, importCount,
legacyProfile: { profileId, name, revision } | null, publicIndexAvailable }`.
`ownerId` is the stable identifier for fail-closed linkage verification.

### `GET /api/agent/v1/people?q&mode&presence&cursor&limit` ⇄ `unlinked_list_people`
Deterministic listing of the published public People index.
`q` ≤ 200 chars; `mode` `best` (default) or `exact`; `presence` `member` (people
who joined: confirmed claims and members' own imports) or `shadow` (imported,
not on Unlinked yet), omitted for everyone. The filter is bound into the cursor.
Response: `{ kind, revision, total, match?, profiles: [{ id, name, headline?,
location?, presence?, connectionCount? }], nextCursor?, visibility: "public" }`.
`presence` and `connectionCount` (connections counted from both ends) are present
whenever the published snapshot names its members.

### `GET /api/agent/v1/people/{id}?connectionsCursor` ⇄ `unlinked_get_profile`
One published profile with its public connections page (50 per page).
Response: `{ kind, revision, visibility: "public", profile: { id, name,
headline?, location?, about?, positions, education, skills,
connections: [...summaries], nextConnectionsCursor? } }`. Unknown id → `not_found`.

### `GET /api/agent/v1/connections?degree&q&cursor&limit` ⇄ `unlinked_list_connections`
Deterministic owner-connections listing; see **Degree semantics**.
Response: `{ kind, degree, revision, total, anchorId? (degree 2),
connections: [{ id, name, headline?, company?, linkedinUrl?, provenance,
visibility }], nextCursor? }`.

### `GET /api/agent/v1/connection-requests?direction` ⇄ `unlinked_list_connection_requests`
Read-only, grant catalog version 3. `direction` `received` (default: requests
waiting for the owner's answer) or `sent` (the owner's requests still pending;
a request the recipient ignored still reads as pending, as it does in the app).
Response: `{ kind, direction, total, requests: [{ id, direction, status, name,
profileId?, note?, createdAt }], visibility: "owner_private" }`. Agents cannot
send, answer or withdraw requests; that stays a signed-in browser action.

### `GET /api/agent/v1/notifications?limit` ⇄ `unlinked_list_notifications`
Read-only, grant catalog version 3. Newest first, `limit` 1–50 (default 20).
Response: `{ kind, unseen, unread, notifications: [{ id, kind, actorName,
actorProfileId?, createdAt, read }], visibility: "owner_private" }`. Kinds:
`connection_request_received`, `connection_request_accepted`,
`invite_accepted`, `profile_claimed`. Reading here marks nothing seen or read.

### `POST /api/agent/v1/ai-search` `{ query, scope?, timeoutMs? }` ⇄ `unlinked_ai_search`
Explicit AI tool. `scope: "mine"` ranks only the owner's imported network
(works on every grant); `scope: "everyone"` ranks the published public index
and requires the public scope, else `scope_not_granted`. When `scope` is
omitted it defaults to the widest scope the grant covers (`everyone` on
public-scope grants, `mine` on owner-network grants).
Response (`mine`): `{ kind, scope, mode, considered, indexed, matches: [{
assertionId, sourceId, rowId, name, headline?, company?, reason,
visibility: "owner_private" }] }`.
Response (`everyone`): `{ kind, scope, mode, revision, considered,
lexicalMatches, modelCandidates, matches: [{ id, name, headline?, location?,
company?, reason }], visibility: "public" }`.

### `POST /api/agent/v1/search-network` `{ query, degree?, cursor? }` ⇄ `unlinked_search_network`
Launch tool, unchanged semantics: free-text AI search of the owner network, or
recorded-path reading with `degree`. On HTTP, failures are typed
(`degree_unproven`, `cursor_invalid`, ...) and recorded-path pages cap at 50
rows; on MCP it returns the same typed failure shape and keeps 100-row pages
(offset cursors are interchangeable between the two).

### `POST /api/agent/v1/search-everyone` `{ query }` ⇄ `unlinked_search_everyone`
Launch tool, unchanged semantics: AI search over the published public index.
Requires the public scope.

## Grant provisioning (v1.1) — `POST /api/agent/v1/provision-grant`

Server-to-server only: lets an **allow-listed confidential client** (the
Ideaflow develop/connector backend) obtain or re-derive a read-only Unlinked
account grant for a person whose identity it has already verified through its
own OIDC session. Keyed strictly on the verified **issuer + subject** binding
(`OperationalIdentity`); **never email**, no token pasting by users.

- **Client auth:** HTTP Basic (`client_secret_basic`) — `Authorization: Basic
  base64(clientId:clientSecret)`. Client ids are exact-matched; secrets are
  compared as SHA-256 digests with a timing-safe comparison, and unknown ids
  cost the same as wrong secrets. Failure is typed `client_unauthorized`
  (403) — distinct from `not_linked`, which is about the *person*.
- **Enablement:** the allow list is server-side operator configuration
  (`UNLINKED_AGENT_PROVISION_CLIENTS="clientId:secret,..."`, secrets ≥ 32
  chars; only their hashes are retained in memory). An empty/absent list
  disables the endpoint entirely: it answers `not_found` (404).
  On the canonical runtime the list lives in the private runtime env file on
  the Noos production host,
  `/srv/unlinked-private-guest-pilot-20261001/runtime/runtime.env`, and is set
  by the Unlinked host operator, not by the consumer. The runtime reads it
  only at startup, so adding, rotating or removing a client requires a
  runtime restart, and every restart signs all browser users out. Batch
  allow-list changes with a release rollout rather than restarting on their
  own.
- **Issuer and subject:** the issuer must exactly equal the issuer the
  Unlinked runtime is configured with (production:
  `https://id.ideaflow.app/api/auth`). Any other issuer, including a
  development Ideaflow ID instance, always answers `not_linked`, even for
  people who have signed in to Unlinked. The subject is matched against the
  one Unlinked recorded when the person signed in through Unlinked's own
  Ideaflow ID client. This assumes Ideaflow ID issues the same subject for a
  given user to every client (public, not pairwise, subjects). Consumers
  should confirm that for their own client before relying on it, since
  pairwise subjects would make every lookup answer `not_linked`.
- **Rate limit:** 30 requests/min per client id (`rate_limited`, 429,
  `Retry-After`).
- **Request:** `{"issuer": "<https OIDC issuer>", "subject": "<exact opaque
  subject>"}` — the pair the caller verified itself. Unknown fields, non-https
  issuers or malformed subjects are `invalid_input`.
- **Semantics (= Settings auto-setup `ensureGrant`):** reuses the newest live
  grant of **any** catalog version for that owner (multiple live grants per
  owner are expected and never clobbered — tokens are deterministically
  re-derived from the durable record, nothing is minted on reuse); mints the
  one deterministic automatic grant (current catalog version, read-only
  `owner_network_and_public` scope) only when the owner has no live grants and
  never revoked the automatic one. **Revoked stays revoked**: after the owner
  turns agent access off, provisioning answers `grant_revoked` until they
  re-enable it in Settings.
- **Response (200):** `{ kind: "unlinked_provision_grant", ownerId, grantId,
  created, version, scope, tools, accessToken }`. The token is verified
  against the live grant record before it is returned, appears **only** in
  this TLS response body, and is never logged or audited. `ownerId` is the
  stable identifier for fail-closed linkage verification; `created` is false
  on reuse.
- **Errors:** `client_unauthorized` (403), `not_linked` (401 — the person has
  no Unlinked owner binding yet; they must sign in at `/login` once),
  `grant_revoked` (401 — owner turned agent access off), `invalid_input`
  (400), `rate_limited` (429), `upstream_unavailable` (503, retry),
  `not_found` (404, endpoint disabled on this runtime).
- **Audit:** every issuance/reuse appends `account_grant_provisioned` /
  `account_grant_reused` with client id, owner hash and grant id — never the
  token. Provisioning **fails closed** if the audit sink is unavailable
  (`upstream_unavailable`; no credential is returned unaudited).
- **Consumer guidance:** store the token mode-600 server-side keyed by
  `ownerId`; re-calling the endpoint is cheap and idempotent (same `grantId`,
  re-derived token), so prefer re-provisioning over long-lived caches when in
  doubt; treat `grant_revoked` as the user's explicit choice — surface "re-enable
  in Unlinked Settings", do not retry automatically.

## Future consumers (design-level notes, nothing here is built)

Beyond the Ideaflow MCP connector, two planned consumers are expected to use
this same HTTP JSON API: an Unlinked people-context overlay and a
cross-product "OpenChat asks on profiles" feature (both centered on person
read, `whoami`/linkage verification and the typed error vocabulary). A
Superconnector→Neo4j projection is also under design consideration. For
cross-product person-identity resolution the contract therefore keeps stable
identifiers first-class:

**Reserved namespace:** `ask` / `asks` (tool names, endpoint segments and
result `kind`s) is reserved for that future person-"asks" resource
(user-authored intent posts on profiles). That is why the AI search tool is
named `unlinked_ai_search` and lives at `/api/agent/v1/ai-search` — do not
add AI-search aliases under an `ask` name.

- `ownerId` (from `whoami`) is the stable, never-reused account identifier —
  the only linkage primitive. Consumers must key on it, not on names or email.
- Published profile `id`s are stable within the public index and appear on
  every person-shaped result (`profiles[].id`, `connections[].id`,
  `path.fromId/viaId/toId`), so joins across tools need no name matching.
- Validated canonical LinkedIn profile URLs (`linkedinUrl`, normalized to
  `https://www.linkedin.com/in/...`) are first-class *identity evidence* on
  owner-imported entries — useful as a cross-product correlation key — but
  they never confer authority: Unlinked never derives ownership or linkage
  from a URL or email, and neither should consumers.
- Known friction to flag for projection designs: owner-imported connection
  entry `id`s are per-owner assertion ids (salted by owner), so the same
  external person imported by two owners has two different assertion ids;
  cross-owner resolution must go through published profile ids or the
  LinkedIn URL evidence, never assertion ids. `revision` values are
  snapshot-scoped and must not be used as long-lived identity.

## Bulk export (deliberately not offered in v1)

A revision-pinned NDJSON public export (to work around the deterministic
budget for agent-side full search) was evaluated and **skipped**: the
published snapshot is computed live and has no persisted revision history, so
a pinned export would require new storage with expiry guarantees to prove
that a stale pinned revision can never resurrect a tombstoned (deleted)
person. Until an expiring, deletion-propagating revision store exists, bulk
needs are served by `list_people` pagination (50/page inside the 120/min
budget covers the full ~16k-profile index in ~3 minutes, always at the live
revision, which is tombstone-safe by construction).
