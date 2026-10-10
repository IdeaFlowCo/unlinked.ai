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
per-user, revocable grant (read-only by default) issued in **Settings → API keys → Create API key**
on the runtime, or through the OAuth connector flow below. There is no anonymous access to any `/api/agent/v1/` route and
no email-based linkage anywhere: the grant token *is* the account linkage, and
`unlinked_whoami` returns the stable Unlinked `ownerId` so a consumer can
verify linkage explicitly. Callers without a usable grant get typed
`not_linked` — never empty results.

Grant revocation is checked before **every** call and re-checked after reads,
so a revocation during a read returns `grant_revoked` rather than data. Writes
are checked before the action only: a completed action is not reported as a
failure if the grant is revoked mid-call.
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
That sign-in is the ordinary web sign-in (silent SSO, no forced password; see
`docs/ideaflow-sign-in.md`). The consent page names the signed-in account and
offers "Not you? Switch account", which returns to the same request; the
consent decision is the confirmation for the grant.

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) | RFC 9728 metadata: `resource` = `https://www.unlinked.ai/mcp`, `authorization_servers` = `["https://www.unlinked.ai"]`, `scopes_supported` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata (`/.well-known/openid-configuration` is a JSON 404: this is not an OpenID provider) |
| `GET/POST /oauth/authorize` | Sign-in (Ideaflow ID) if needed, then a consent page; POST carries the session CSRF token |
| `POST /oauth/token` | `authorization_code` exchange (form-encoded) |
| `POST /oauth/register` | RFC 7591 dynamic client registration (JSON) |
| `POST /oauth/revoke` | RFC 7009 revocation |

Any request to `/mcp` without a usable grant answers `401` with
`WWW-Authenticate: Bearer resource_metadata="https://www.unlinked.ai/.well-known/oauth-protected-resource/mcp", scope="network people private_notes"`
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
  `offline_access`, `claudeai`, …) are ignored; no recognized read scope means
  all offered read access. Optional `connections` requires the separate
  consent choice described [below](#optional-connection-actions);
  a scope request alone never enables writes. `private_notes` (private people
  notes & relations, [below](#private-people-notes--relations-catalog-v7)) is a
  separate consent-page checkbox that **starts ticked**; unticking it leaves the
  permission out. The token response states the granted `scope`. Apps connected
  before catalog v7 do not gain `private_notes`: disconnect and connect again
  to consent to it.
- **Tokens are account grants.** The access token is an ordinary account grant
  (same JWT, same per-call revocation check, same tool catalog) whose durable
  record carries `connection: { kind: 'oauth', app, clientName, redirectHost,
  clientKey (SHA-256 of client_id), resource }`. It does not expire and no
  refresh token is issued (`grant_types_supported: ["authorization_code"]`);
  disconnecting in **Settings → Connected apps** or `POST /oauth/revoke` (by
  the same client) stops it on the next call. Connection grants are never
  reused as the copyable Settings credential, survive manual key creation, replacement and revocation, and
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

The implementation catalog is the authoritative list of historical and current
tools for each scope; historical entries are immutable.

- Valid v1/v2 and later records resolve to the current catalog **within the same
  enabled permission and data boundary**. Owner-only keys stay owner-only; reads
  never silently gain writes. Authentication, `tools/list`, `whoami`, Settings,
  provisioning and execution agree. Historical records are validated against their
  original exact catalog before normalization; simply editing a tool array fails.
- New tools within enabled permissions use the same exact token bytes. No record
  migration or token rotation is needed. Refresh an agent's cached `tools/list`;
  copying a new key is not a tool refresh. This stateless POST-only MCP transport
  does not deliver tool-list-change or notification pushes (`listChanged: false`).
  The notification tool reads the in-app feed on demand.
- Catalog v6 added the read-only, owner-scoped `unlinked_lookup_contact` to every
  scope. Current issuance is **catalog v7**: every v6 scope keeps its exact list
  and gains a twin with the suffix `_and_private_notes` (scope grammar
  `owner_network[_and_public][_and_write][_and_private_notes]`) that appends the
  twelve [private people notes & relations](#private-people-notes--relations-catalog-v7)
  tools. That is a **separate, default-on permission** (Jacob's decision on
  unlinked-lf4), so a valid pre-v7 **API key** resolves to its private-notes
  twin with the same token bytes; it never gains connection-request writes.
  A pre-v7 **OAuth connection** keeps exactly its consented scope and needs
  reconnection to consent to `private_notes`. Manual-key permissions
  (connection requests, private notes) are switched in Settings; OAuth apps
  require actual consent/reconsent for additional permissions.

OpenChat's production integration — stateless JSON-RPC `tools/call` POSTs to
`/mcp` invoking `unlinked_search_network` / `unlinked_search_everyone` — is
preserved exactly (names, stateless POST without initialize) and covered by
test. Since the typed-failure fix (PR #53), the two launch tools also return
the sanitized typed JSON failure shape below instead of their original
free-text error sentences.

Catalog v5 keeps both read scopes and the optional connection actions described
[below](#optional-connection-actions).

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
| `not_a_member` | 409 | The target profile is not an Unlinked member. |
| `already_connected` | 409 | The owner and target are already connected. |
| `request_pending` | 409 | An open request already exists for the pair. |
| `request_unavailable` | 409 | The requested state transition is no longer available. |
| `cooldown_active` | 429 | The withdrawal cooldown has not elapsed. |
| `ambiguous_name` | 409 | (private notes) Several of the owner's saved things share that name. The body adds `candidates` (`id`, `kind`, `name`, the owner's own); ask the user, then pass an id, or `createNew` with `clientRequestId`. |
| `identity_unavailable` | 409 | (private notes) The account has no Ideaflow sign-in identity, so it has no people overlay. Sign in to Unlinked with Ideaflow once. |

Private-notes input refusals from the overlay are `invalid_input` with an extra
`overlayCode` (for example `invalid_relation`).

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
  `get_profile`, `list_connection_requests`, `list_notifications`): 120
  requests/min **per grant owner**; expected well under 1 s p95 at the current index size (~16k profiles, in-memory snapshot).
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
Response: `{ kind, ownerId, grant: { scope, version, tools, toolRefresh }, importCount,
imports: { uploaded, recoveredArchive }, legacyProfile: { profileId, name, revision } | null, publicIndexAvailable }`.
`importCount` counts every source of `owner_import` connections: uploaded imports
plus a recovered legacy archive (`imports.recoveredArchive`). Before 0.6.2 it
counted uploads only, so an owner whose contacts came from the recovered archive
read `importCount: 0` while `unlinked_list_connections` listed them.
`ownerId` is the stable identifier for fail-closed linkage verification.
`grant.toolRefresh` explains same-key tool refresh and explicit permissions; see the
[permission and tool-refresh policy](#optional-connection-actions).

### `GET /api/agent/v1/people?q&mode&presence&sort&cursor&limit` ⇄ `unlinked_list_people`
Deterministic listing of the published public People index.
`q` ≤ 200 chars; `mode` `best` (default) or `exact`; `presence` uses the
[public People presence contract](public-people-reader.md#historical-membership),
omitted for everyone. `sort` `best` (default: relevance
with `q`, else the stored name order), `name`, `name-desc` or `raw` (see
[Name ordering](#name-ordering)). The filter and sort are bound into the cursor.
Response: `{ kind, revision, sort? (when not best), total, match?, profiles: [{ id, name, headline?,
location?, presence?, connectionCount? }], nextCursor?, visibility: "public" }`.
`presence` and `connectionCount` (connections counted from both ends) are present
whenever the published snapshot names its members.

### `GET /api/agent/v1/people/{id}?connectionsCursor` ⇄ `unlinked_get_profile`
One published profile with its public connections page (50 per page).
Response: `{ kind, revision, visibility: "public", profile }`. The profile DTO
fields and bounds are owned by `detailSchema` in
`src/components/public-directory/contract.ts`; professional link sourcing and
privacy are owned by [profile details](profile-details.md).
Unknown id → `not_found`.

### `GET /api/agent/v1/connections?degree&q&sort&grouping&cursor&limit` ⇄ `unlinked_list_connections`
Deterministic owner-connections listing; see **Degree semantics**.
`q`, `sort` and `grouping` are bound into the cursor (reusing a cursor with
another value is `cursor_invalid`).

- `grouping` (degree 1) — `person` (default) returns **one entry per person**:
  records join only on exact identity evidence — the same published profile
  (the row's own published copy, a recorded path/invite/connection target, or
  the published profile with the same LinkedIn address; merged profiles are
  followed to their survivor) or the same canonical LinkedIn address
  (`linkedinRefHash`). A name is never evidence: two contacts called "Sam Lee"
  with different addresses stay two entries. Top-level fields come from the
  owner's import (the earliest import is primary, so the `id` stays stable when
  a re-import joins), filling gaps from the other sources; `connectedAt` /
  `importedAt` are the earliest known. `sources` lists every underlying record.
  `total` counts people. `q` matches any source's name, headline or company.
  `none` returns one row per source record in the pre-grouping shape (no
  `sources`, no dates), so the same person can appear more than once.
- `sort` — `name` (default), `raw`, `name-desc`, `connected` (most recently
  connected first, undated last), `imported` (most recently imported first),
  `company` (A–Z, no company last); ties fall back to name, then id. See
  [Name ordering](#name-ordering).

Response: `{ kind, degree, grouping (degree 1), sort, revision, total,
anchorId? (degree 2), connections: [{ id, name, headline?, company?,
linkedinUrl?, publishedProfileId?, linkedinRefHash?, connectedAt?, importedAt?,
provenance, visibility, sources: [{ id, name, provenance, visibility }] }],
nextCursor? }`. Grouped `provenance` is the primary source's; `visibility` is
`owner_private` when any source is. Every source `id` (and the entry `id`) is a
valid `connectionId` for `unlinked_lookup_contact`.

#### Name ordering
`name` compares a key that starts at the first Unicode letter or number
(`\p{L}\p{N}`), so leading emoji, symbols, quotes and punctuation do not move a
person (`🚀 Zoe` sorts under Z, `"Bob"` under B), with accent- and
case-insensitive, numeric-aware collation (`Émile` sorts as `emile`). Names are
always returned exactly as written. `raw` is plain Unicode code-point order of
the name as written (uppercase before lowercase, punctuation and digits first,
emoji last). Implementation: `src/utils/network-order.mjs`.

### `GET /api/agent/v1/connection-requests?direction` ⇄ `unlinked_list_connection_requests`
Read-only; availability follows [grant-scope normalization](#grant-scope-versioning-how-old-grants-keep-working). `direction` `received` (default: requests
waiting for the owner's answer) or `sent` (the owner's requests still pending;
a request the recipient ignored still reads as pending, as it does in the app).
Response: `{ kind, direction, total, requests: [{ id, direction, status, name,
profileId?, note?, createdAt }], visibility: "owner_private" }`. Sending, accepting, ignoring and withdrawing require the separate explicit opt-in connection scope in catalog v5.

### `GET /api/agent/v1/notifications?limit` ⇄ `unlinked_list_notifications`
Read-only; availability follows [grant-scope normalization](#grant-scope-versioning-how-old-grants-keep-working). Newest first, `limit` 1–50 (default 20).
Response: `{ kind, unseen, unread, notifications: [{ id, kind, actorName,
actorProfileId?, createdAt, read }], visibility: "owner_private" }`. Kinds:
`connection_request_received`, `connection_request_accepted`,
`invite_accepted`, `profile_claimed`. Reading here marks nothing seen or read.

### `POST /api/agent/v1/contacts/lookup` `{ connectionId | linkedinUrl | profileId | refHashes }` ⇄ `unlinked_lookup_contact`
Read-only, owner-scoped, catalog v6 (every scope). Resolves one of the owner's
own contacts without paging; give exactly one input:
- `connectionId`: an `id` from `unlinked_list_connections` (degree 1).
- `linkedinUrl`: a `linkedin.com/in/` address, with or without scheme.
- `profileId`: a published profile id; answers with the owner's connection to
  that person when there is one, otherwise the public profile only.
- `refHashes`: up to 100 `linkedinRefHash` values; answers the owner's contacts
  among them (`{ kind, contacts: [...] }`, unmatched hashes are omitted).

Response: `{ kind, contact: { connectionId | null, name, headline?, company?,
linkedinRefHash | null, publishedProfileId | null, provenance? }, visibility }`.
`linkedinRefHash` is the SHA-256 hex of the canonical LinkedIn slug
(`linkedinSlug()` in `src/utils/public-people/url-identity.mjs`: decoded,
lowercased) — the value of the Ideaflow people-overlay ref `linkedin:in:<hash>`
OpenChat uses for imported contacts (Noos `docs/PEOPLE_OVERLAY.md`).
`publishedProfileId` is set when the same person has a published profile (the
row's own published profile, or one with the same LinkedIn address).
`visibility` is `owner_private` when the answer comes from the owner's own
contacts and `public` when only a published profile matched. Only the caller's
own imports are ever read; nothing matching is typed `not_found`.

Notes and relations an agent saves about these people through the shared
Ideaflow connector (OpenChat private-people tools, keyed by the same refs) are
shown to the owner, and only the owner, on Unlinked person and contact pages;
see [private-context.md](private-context.md). With the private-notes permission
this API reads and writes them directly (next section).

### `POST /api/agent/v1/ai-search` `{ query, scope?, timeoutMs? }` ⇄ `unlinked_ai_search`
Explicit AI tool. `scope: "mine"` ranks only the owner's imported network
(works on every grant); `scope: "everyone"` ranks the published public index
and requires the public scope, else `scope_not_granted`. When `scope` is
omitted it defaults to the widest scope the grant covers (`everyone` on
public-scope grants, `mine` on owner-network grants).
Response (`mine`): `{ kind, scope, mode, considered, indexed, matches: [{
assertionId, sourceId, rowId, name, headline?, company?, reason,
visibility: "owner_private" }] }`.
Owner ranking treats a requested role as a constraint, rather than inferring it
from a domain match. For common explicit single-role requests (investor,
engineer/developer, recruiter, designer, founder, CEO), a local title-evidence
guard runs before model top-ten selection; domain-only records are omitted.
Investor evidence includes explicit investing titles or partner/principal/associate/
managing-director titles at an investment-named company. Founder/CEO titles
alone, including at a venture-named company, do not establish an investor role.
Ambiguous titles can therefore be omitted even when the person invests in real life.
Compound/exclusion queries and other roles remain semantic model ranking.
Reasons are conversational model-written one-liners grounded only in supplied
title/company/headline evidence, aiming for 140 characters or fewer. Unknown
sector focus is stated plainly (for example, “gaming focus isn't shown in their
title, worth asking”), without inventing a sector from a brand name. A cheap
local post-check uses the bounded title/company template only when a reason is
empty/whitespace or contains a whole-word hedge: likely, possibly, probably,
perhaps, maybe, potentially or potential (case-insensitive). Good model reasons
are preserved verbatim; the existing 512-character hard bound remains unchanged.
The post-check adds no model calls. No related-people
bucket is added, and existing grants, tool versions and response keys are unchanged.
`considered` still counts all owner connections evaluated, including local role
exclusions. The guard adds no model calls and retains four-way bounded ranking,
the existing retry policy, context bounds and final live consistency read.

Response (`everyone`): `{ kind, scope, mode, revision, considered,
lexicalMatches, modelCandidates, matches: [{ id, name, headline?, location?,
company?, reason }], visibility: "public" }`.

### `POST /api/agent/v1/search-network` `{ query, degree?, cursor? }` ⇄ `unlinked_search_network`
Launch tool. Without `degree` it is **text first**: when every query word
starts a word in a connection's name, company or position, it returns all such
connections at once with no model call (`mode: "text_match"`, sorted by name,
at most 500 rows with `total` and `truncated`, `reason` naming the matched
fields). Only a query with no literal match is AI-ranked (`mode:
"query_time_ai"`, top ten), within one 20 s deadline for the whole call, network reads included (below the shared connector's 25 s downstream timeout); a spent budget returns
`upstream_unavailable` naming the text-query and `list_connections`
alternatives. Ranking stops 4 s before that deadline and returns the best
matches ranked so far with `partial: true` (`considered` then counts only the
rows actually ranked); the error is returned only if nothing finished. The
owner-network ranking runs eight model calls at a time. With `degree` it reads recorded paths. On HTTP, failures are typed
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
  runtime restart. Browser session persistence is owned by
  [Durable Sessions](durable-sessions.md).
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
- **Settings auto-setup (`ensureGrant(owner)`):** reuses the newest live,
  non-OAuth credential with its existing scope and effective current catalog, including an opted-in
  write credential. With none, it prepares the deterministic default read
  grant unless that automatic grant was revoked. Explicit key selection reads
  only that existing key. Manual creation and selected-key lifecycle are owned
  by [Settings key management](agent-key-settings.md#independent-lifecycle).
- **Provisioning semantics (`ensureGrant(owner, { readOnly: true })`):**
  reuses the newest live, non-OAuth **read-only** grant of any catalog version for that owner.
  It never returns an opted-in write credential. Tokens are deterministically
  re-derived on reuse; other live grants are never clobbered. With no eligible read grant, it mints the
  deterministic automatic grant at the current catalog version and default
  read scope (public access when enabled), unless that automatic grant was
  revoked. If that automatic key is live but write-enabled, explicit read-only
  provisioning uses one stable per-account fallback, named Read-only provisioning
  key, with the automatic key's original read boundary. Show/Copy never creates
  this fallback. Replacement is reused; its tombstone or write-enabled state
  prevents further fallback issuance. An explicit new read-only Settings key can
  restore provisioning. See [key lifecycle](agent-key-settings.md).
  **Revoked stays revoked**: after the owner turns agent access off, provisioning answers `grant_revoked` until they
  re-enable it in Settings.
  "Read-only" here means **no connection actions**. Since catalog v7 the reused or
  minted key may carry the owner's default-on private-notes permission (the
  owner's own overlay data, which the provisioning app — OpenChat — already
  holds for that owner); the fallback keeps the automatic key's private-notes
  setting.
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
this same HTTP JSON API: an Unlinked people-context overlay (since built
differently: it reads the Noos people overlay directly, see
[private-context.md](private-context.md)) and a
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

## Optional connection actions

Historical catalogs remain immutable. V5 retains v4 read/public-write lists and
adds `owner_network_and_write` so an owner-only key can enable connection actions
without gaining public read tools. `owner_network_and_public_and_write` remains
supported. Both write scopes authorize exactly the four actions below.

The [Settings guide](agent-key-settings.md#permissions-and-connector-choice) owns
manual-key controls and connector choice. The browser requires a
session, exact CSRF, same origin, validated fields and durable owner checks. A CAS
updates scope/catalog while preserving jti, issuedAt and generation. It cannot
resurrect a revoked grant or overwrite a concurrent replacement. OAuth grants
cannot use this action; their existing consent flow still governs permission.

| MCP tool | HTTP POST route | JSON fields |
|---|---|---|
| `unlinked_send_connection_request` | `/api/agent/v1/connection-requests/send` | `profileId`, optional `note` |
| `unlinked_accept_connection_request` | `/api/agent/v1/connection-requests/accept` | `id` |
| `unlinked_ignore_connection_request` | `/api/agent/v1/connection-requests/ignore` | `id` |
| `unlinked_withdraw_connection_request` | `/api/agent/v1/connection-requests/withdraw` | `id` |

The [member connection rules](member-connections.md#connection-requests-mcp-servermember-connectionsmjs)
authorize the account and target and own the crossed-request, private-ignore,
daily-send and withdrawal-cooldown behavior.
An additional shared MCP/HTTP budget allows 20 writes per owner per minute,
independent of read/AI budgets. Failures use the [typed error vocabulary](#typed-errors).
Send returns `{ kind: "unlinked_connection_request_sent", status: "sent"|"accepted",
profileId, id?, visibility: "owner_private" }`; the other actions return
`{ kind: "unlinked_connection_request_update", id, status, visibility: "owner_private" }`
with status `accepted`, `ignored` or `withdrawn`. Removal remains browser-only.
MCP annotations mark these as writes. Messaging and posting are never available.

`whoami.grant` reports effective current scope/version/tools and a `toolRefresh`
instruction; the obsolete `update`/regenerate advice is gone. Revalidation checks
live token identity/generation and the requested tool, not whole-array equality.
Removing permission returns `scope_not_granted`; replacement/revocation returns
`grant_revoked`. Unrelated permission changes do not fail a read. Reads revalidate
before returning data; writes revalidate before execution (send also after target
lookup). An already-committed write reports success even if permission is changed
afterward. Auth and connection storage are not a cross-resource transaction;
in-flight operations authorized at their final check may finish.

## Private people notes & relations (catalog v7)

The direct Unlinked key and OAuth connector can record and read the owner's
**private people knowledge** — notes and relations such as "Alice knows Bob" —
under a **separate permission, "Private people notes & relations"**, which is
independent of "Send and manage connection requests".

- **What it is.** Owner-only private knowledge stored in the owner's Ideaflow
  people overlay (Noos `/api/overlay`, Noos `docs/PEOPLE_OVERLAY.md`), the same
  store OpenChat and the shared Ideaflow connector use. It is shown only to the
  owner, in Unlinked (person and contact pages, [private-context.md](private-context.md))
  and in OpenChat. It **never notifies anyone**, is **not a connection request**
  and is **not messaging**.
- **Default on.** New API keys have it on; pre-v7 API keys have it on with the
  same token (see [versioning](#grant-scope-versioning-how-old-grants-keep-working)).
  Settings → API keys → *Permissions for this key* has an On/Off switch beside
  "Send and manage connection requests" (same CAS edit: token, jti, issue time and
  generation never change). Off hides the tools from `tools/list` and refuses
  calls with `scope_not_granted`. OAuth apps consent with the `private_notes`
  checkbox (starts ticked); older connections reconnect to get it.
- **One semantic layer.** Unlinked never re-implements overlay rules. Names
  never merging (`ambiguous_name` + `candidates`), idempotent notes and links,
  `createNew` + `clientRequestId`, provenance, `relationType`, relation edits,
  search, neighbourhood, deletion and `ensureRefs` are all Noos. Unlinked only
  names people and states who is writing.
- **Naming people.** `subjectKind`/`toKind` `unlinked` takes a published profile
  id, a connection id from `unlinked_list_connections` (an imported LinkedIn
  contact) or a `linkedin.com/in/` address, resolved with the owner-scoped
  `unlinked_lookup_contact` (only the caller's own imports). Refs are
  `unlinked:person:<id>` for published profiles and `linkedin:in:<sha256 of the
  canonical slug>` for the owner's imports — never a plaintext address; both are
  joined on one entity with `ensureRefs`. `thing` takes an overlay entity id.
  `user` (OpenChat user id) works only for OpenChat people the owner already has
  private notes about; record new OpenChat people through the shared connector.
  Reads never create entities.
- **Provenance.** Every write records `author: "agent:<key name>"` (API keys; the
  default key is "Default key") or `"agent:<connected app>"` (OAuth), `source:
  "direct-key"` and `assertion` `stated` (default) or `inferred`. Unlinked and
  OpenChat label each agent-written note and relation with it.
- **Results** never include raw overlay refs: entity ends carry `profileId`,
  `linkedinRefHash` (+ `connectionId` when the owner imported them) or
  `openchatUserId`. Every result is `visibility: "owner_private"`.
- **Budgets.** Shared with the deterministic budget (120 calls per owner per
  minute). Writes revalidate the key before running and report a landed write
  as success.

| MCP tool (`unlinked_*`) | HTTP route (`/api/agent/v1/…`) | Fields | Shared connector equivalent (`openchat__…`) |
|---|---|---|---|
| `unlinked_get_person_private` | `GET private/person` | `profileId` (profile id, connection id or LinkedIn address) | `oc_get_unlinked_person_private` |
| `unlinked_get_private_thing` | `GET private/thing` | `thingId` | `oc_get_private_thing` |
| `unlinked_list_private_things` | `GET private/things` | `query?`, `kind?` | `oc_list_private_things` |
| `unlinked_search_private` | `GET private/search` | `query?`, `relationType?`, `kind?`, `limit?` (one of the first three) | `oc_search_private` (also covers `oc_list_private_links` with a query) |
| `unlinked_get_neighbourhood` | `GET private/neighbourhood` | `subjectKind`, `subjectId`, `depth?` (1–2) | `oc_get_neighbourhood` |
| `unlinked_save_private_thing` | `POST private/things` | `kind`, `name`, `createNew?`, `clientRequestId?` | `oc_save_private_thing` |
| `unlinked_add_private_note` | `POST private/notes` | `subjectKind`, `subjectId`, `text` (≤4,000), `assertion?` | `oc_add_private_note` |
| `unlinked_delete_private_note` | `POST private/notes/delete` | `noteId` | `oc_delete_private_note` |
| `unlinked_add_private_link` | `POST private/links` | `subjectKind`, `subjectId`, `relation` (≤60), `toKind`, `toId?` / `toName?`, `createNew?`, `clientRequestId?`, `assertion?` | `oc_add_private_link` |
| `unlinked_update_private_link` | `POST private/links/update` | `linkId`, `relation`, `assertion?` | `oc_update_private_link` |
| `unlinked_delete_private_link` | `POST private/links/delete` | `linkId` | `oc_delete_private_link` |
| `unlinked_delete_private_thing` | `POST private/things/delete` | `thingId` | `oc_delete_private_thing` |

Not on the direct key: `oc_get_person_private` / `oc_set_person_private` /
`oc_list_catch_up` (OpenChat people and their catch-up cadence) — use the shared
connector. Agents can switch between the two surfaces by dropping the
`openchat__oc_` prefix for `unlinked_` and using `subjectKind: "unlinked"`.

**Three separate things.** Messaging = OpenChat, through the shared Ideaflow
connector (`https://id.ideaflow.app/mcp`) with the OpenChat permission; it is not
available on Unlinked keys. Connection requests = the "Send and manage connection
requests" switch. Private notes and relations = this permission.

**Tool refresh.** The new tools arrive on the existing key: refresh the
client's cached `tools/list` (in claude.ai, disconnect and reconnect the
connector, or start a new conversation). Do not replace or regenerate the key
for this.

## Shared connector delegation

The public shared endpoint is `https://id.ideaflow.app/mcp` (setup at `/agents` on that host). The gateway forwards authorized calls to `POST /api/connector/mcp` with a dedicated `IDEAFLOW_CONNECTOR_SECRET` HS256 assertion, never a personal API key. Assertions bind the exact UTF-8 JSON body hash, `https://www.unlinked.ai/mcp` audience, Ideaflow issuer/subject, consented `unlinked:read` and optional `unlinked:write`, unique jti, and at most 60 seconds. Invalid/replayed assertions fail before account lookup. No account or linking is created by a call. The existing account tool service and live owner authorization are reused; write permission exposes only existing connection actions, never messaging or raw archives. Gateway disconnect revokes future assertions; in-flight authorized operations can finish. Deploy the per-service secret in the runtime env with the release; absence keeps the internal endpoint disabled.


### Named manual keys

See [Settings key management](agent-key-settings.md) for manual setup, Muse field
formats, independent key lifecycle, compatibility and generation-aware rollback.

## Request diagnostics

When operator-enabled, direct REST/MCP responses include a server-generated X-Request-ID. For a failed query, report that response ID, time/timezone, endpoint or tool, status/error, elapsed time and query length; never send credentials, private query text or results. Diagnostics is off by default and does not prove host setup or fix earlier failures. See [the private diagnostics contract](request-diagnostics.md) for field semantics, retention, trusted gateway correlation limits and operator lookup. The JSON response schemas, permissions and status mappings are unchanged.
