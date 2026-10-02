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
per-user, revocable grant (read-only by default) issued in **Settings → Connect my agent**
on the runtime, or through the OAuth connector flow below. There is no anonymous access to any `/api/agent/v1/` route and
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

## OAuth connector (MCP authorization)

`/mcp` is also an OAuth 2.1 protected resource, so MCP clients that sign in —
Claude custom connectors (claude.ai, Desktop, mobile), Claude Code, ChatGPT
developer-mode connectors, MCP Inspector — need only the URL
`https://www.unlinked.ai/mcp`. Unlinked is its own authorization server
(`mcp-server/oauth-server.mjs`); Ideaflow ID is used only to sign the person in.

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) | RFC 9728 metadata: `resource` = `https://www.unlinked.ai/mcp`, `authorization_servers` = `["https://www.unlinked.ai"]`, `scopes_supported` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata (`/.well-known/openid-configuration` is a JSON 404: this is not an OpenID provider) |
| `GET/POST /oauth/authorize` | Sign-in (Ideaflow ID) if needed, then a consent page; POST carries the session CSRF token |
| `POST /oauth/token` | `authorization_code` exchange (form-encoded) |
| `POST /oauth/register` | RFC 7591 dynamic client registration (JSON) |
| `POST /oauth/revoke` | RFC 7009 revocation |

Any request to `/mcp` without a usable grant answers `401` with
`WWW-Authenticate: Bearer resource_metadata="https://www.unlinked.ai/.well-known/oauth-protected-resource/mcp", scope="network people"`
(plus `error="invalid_token"` when a token was presented). Metadata, token,
registration and revocation endpoints send `Access-Control-Allow-Origin: *`
(they use no cookies) and accept requests without an `Origin` header.

Security decisions:

- **Public clients only.** `token_endpoint_auth_methods_supported` is
  `["none"]`; registration always answers `token_endpoint_auth_method: "none"`
  and issues no secret. PKCE `S256` is mandatory; `plain` is refused.
- **Clients.** Client ID Metadata Documents are fetched only for three exact
  client ids — `https://claude.ai/oauth/mcp-oauth-client-metadata` (Claude
  connectors), `https://claude.ai/oauth/claude-code-client-metadata` (Claude
  Code) and `https://chatgpt.com/oauth/client.json` (ChatGPT) — with no
  redirects, 5 s, 32 KiB, cached 1 h, and the document's `client_id` must
  equal its URL. Any other URL-form client id is refused without a fetch;
  other clients use dynamic registration.
  Registration, token and revocation endpoints have no global rate budget an
  anonymous caller could exhaust; codes gate every durable write.
  Dynamic registration is stateless: the `client_id` (`ulc1.…`) is an
  HMAC-signed record of the redirect URIs and name, under a key derived (HKDF)
  from the account grant key, so registration stores nothing and a restart
  forgets no client.
- **Redirect URIs** are limited to `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`,
  `https://chatgpt.com/connector_platform_oauth_redirect` (ChatGPT's stable
  callback, used because every response carries `iss`; its per-connector
  callbacks are not accepted) and RFC 8252 loopback (`http://localhost`,
  `http://127.0.0.1`; any port at request time). A
  look-alike client can therefore never receive a code off-device. Unknown
  clients and unregistered redirect URIs are shown an error and never
  redirected; every other error, and every success, redirects with RFC 9207 `iss`.
- **Consent** names the app by its verified redirect target ("Claude",
  "ChatGPT", or "An app on this computer" plus its self-reported name), lists
  the scopes, and its CSP `form-action` allows `https:` redirect hops (the
  app's callback may redirect again) or the exact loopback origin.
  Sign-in returns to the same authorization request, ahead of the find-me and
  recovered-account steps.
- **Codes** are 256-bit, single-use (consumed even by a failed exchange),
  expire after 60 s and are bound to client, redirect URI, PKCE challenge and
  owner. `redirect_uri` at the token endpoint is required, and must match,
  whenever the authorization request carried one.
- **Resource indicators**: `resource`, when sent, must be this server
  (`https://www.unlinked.ai/mcp`; the bare origin is accepted) or the request
  fails `invalid_target`.
- **Scopes**: `network` → grant scope `owner_network`; `people` (implies
  `network`) → `owner_network_and_public`. Unknown scopes (`openid`,
  `offline_access`, `claudeai`, …) are ignored; none known means everything
  offered. The token response states the granted `scope`.
- **Tokens are account grants.** The access token is an ordinary account grant
  (same JWT, same per-call revocation check, same tool catalog) whose durable
  record carries `connection: { kind: 'oauth', app, clientName, redirectHost,
  clientKey (SHA-256 of client_id), resource }`. It does not expire and no
  refresh token is issued (`grant_types_supported: ["authorization_code"]`);
  disconnecting in **Settings → Connected apps** or `POST /oauth/revoke` (by
  the same client) stops it on the next call. Connection grants are never
  reused as the copyable Settings credential, survive **Regenerate**, and
  disconnecting one never turns off the copyable credential. Tokens never
  enter audit events (`oauth_connection_approved` / `_denied` / `_granted`
  record only app, owner hash, grant id and scope).

The copyable bearer credential in Settings keeps working unchanged for clients
that cannot sign in (header-based connectors, `claude_desktop_config.json` via
`mcp-remote`, Cursor).

## Grant-scope versioning (how old grants keep working)

A grant record stores the exact tool list it was issued with plus a catalog
`version`. Authentication accepts a record only when its stored list equals
the catalog entry for `(version, scope)` in
`ACCOUNT_GRANT_TOOL_VERSIONS` (`mcp-server/account-grants.mjs`):

| Version | `owner_network` scope | `owner_network_and_public` scope |
|---|---|---|
| 1 (pre-existing grants) | `unlinked_search_network` | + `unlinked_search_everyone` |
| 2 | + `unlinked_whoami`, `unlinked_list_connections`, `unlinked_ai_search` | + `unlinked_whoami`, `unlinked_list_people`, `unlinked_list_connections`, `unlinked_get_profile`, `unlinked_ai_search` |
| 3 | version 2 + `unlinked_list_connection_requests`, `unlinked_list_notifications` (read-only) | version 2 + the same two tools |

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
profileId?, note?, createdAt }], visibility: "owner_private" }`. Sending, accepting, ignoring and withdrawing require the separate explicit opt-in connection scope in catalog v4.

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


## Catalog v4: optional connection actions

Versions 1–3 are immutable. Version 4 retains the v3 read lists and adds
`owner_network_and_public_and_write`, never a default. Settings regeneration
and OAuth consent offer an unchecked optional choice; the server validates
`access=connections`, availability and duplicate/unknown fields. Requesting
OAuth `connections` alone does not grant it. Defaults and existing grants keep
read access only; opting out at regeneration restores a read-only credential.

| MCP tool | HTTP POST route | JSON fields |
|---|---|---|
| `unlinked_send_connection_request` | `/api/agent/v1/connection-requests/send` | `profileId`, optional `note` |
| `unlinked_accept_connection_request` | `/api/agent/v1/connection-requests/accept` | `id` |
| `unlinked_ignore_connection_request` | `/api/agent/v1/connection-requests/ignore` | `id` |
| `unlinked_withdraw_connection_request` | `/api/agent/v1/connection-requests/withdraw` | `id` |

Shared browser rules authorize the account and target, crossed requests accept,
ignore stays private, 50 sends per rolling day and 21 days after withdrawal.
An additional shared MCP/HTTP budget allows 20 writes per owner per minute,
independent of read/AI budgets. Typed failures include `not_a_member`,
`already_connected`, `request_pending`, `request_unavailable`, `cooldown_active`.
MCP annotations mark these as writes. Messaging and posting are never available.

Settings and `whoami.grant.update` suggest regeneration/reconnection only when
the grant lacks tools its own scope now provides. A v3 read grant has no nudge
solely because v4 adds an opt-in scope. Missing grant records render safely.
