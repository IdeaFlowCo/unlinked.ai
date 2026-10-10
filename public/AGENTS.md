# Unlinked agent guide

## Set up your agent

For compatible hosts wanting several apps or messages, start with the [shared Ideaflow connector](https://id.ideaflow.app/agents) and `https://id.ideaflow.app/mcp`. Consent to each app's permissions separately. Existing direct Unlinked Claude/ChatGPT OAuth connections remain supported; no migration is required. Messages need separate **OpenChat** permissions, not Unlinked connection-request permission.

For a manual Unlinked API key, including Muse's observed custom API form:

1. Sign in and open [Settings → API keys](https://www.unlinked.ai/settings#api-keys). API keys appear **before** client-specific setup instructions. No archive is needed to connect.
2. Select the prepared key, or **Create API key** and give it a name such as Muse. Named keys are independent: renaming, replacing or revoking one leaves the others and OAuth connections intact.
3. **Show/Hide** and **Copy API key** work repeatedly, including after revisiting Settings. Viewing or copying never generates or rotates a key. **Copy agent setup** remains available for the selected key and copies ready-to-use MCP URL/headers JSON; advanced client configurations remain under **Setup instructions and advanced formats**.
4. In Muse, ask for a custom API connector using `https://www.unlinked.ai/openapi.json`. Paste **only the key** into an API-key/access-token field: no JSON and no `Bearer` prefix. A full **Authorization** header value instead needs `Bearer ` followed by the key. Use this credential only with Unlinked. Muse OAuth compatibility is **unverified**.
5. Verify identity with `GET /api/agent/v1/whoami` and then a small read query. Copying setup is not proof that the client saved or used a connection.

### Change permissions without changing the key

Under the selected key's **Permissions**, turn **Send and manage connection requests** on or off, then **Save permissions**. The same key immediately uses the saved permission; other keys are unaffected. New keys default to read-only with an explicit creation choice for connection actions. These actions send, accept, ignore or withdraw connection requests; they neither send OpenChat messages nor record private “X knows Y” relationships. Owner-only keys retain their narrower read boundary.

### Private people notes & relations

Under the same **Permissions**, **Private people notes & relations** is a separate switch, **on by default** for API keys (new and existing; no new key needed). It lets the agent record and read your own private notes and relations about people — for example that two of your imported contacts know each other (“X knows Y”) — with `unlinked_get_person_private`, `unlinked_get_private_thing`, `unlinked_list_private_things`, `unlinked_search_private`, `unlinked_get_neighbourhood`, `unlinked_save_private_thing`, `unlinked_add_private_note`, `unlinked_delete_private_note`, `unlinked_add_private_link`, `unlinked_update_private_link`, `unlinked_delete_private_link`, `unlinked_delete_private_thing`. These are owner-only: shown only to you on Unlinked person and contact pages and in OpenChat, labelled with the key’s name as the author, and they never notify anyone. They are **not** connection requests and **not** messaging. Turn the switch off and **Save permissions** to hide the tools from the same key. OAuth apps get a **Private people notes & relations** checkbox (ticked) on the consent page; apps connected earlier reconnect to add it.

Three separate things: **messaging** is OpenChat through the shared Ideaflow connector (https://id.ideaflow.app/mcp, OpenChat permission); **connection requests** are the **Send and manage connection requests** switch; **private notes and relations** are this switch. After the tools arrive, refresh the agent’s cached `tools/list` (in claude.ai, reconnect the connector); do not replace the key.

New tools within an already enabled permission work with the **existing token**, including valid older keys. Do **not** regenerate or reconnect just because tools were added. If an agent caches its catalog, refresh its `tools/list`; this stateless POST-only MCP transport does not push tool-change notifications. Adding OAuth permissions requires consent/reconsent through the connector, not the manual-key switch.

**Replace this key** deliberately invalidates that selected secret; **Revoke this key** stops its access. Neither is needed to copy again or refresh tools. Settings preserves existing prepared credentials, and revoked automatic access stays revoked until you explicitly create a key.

For connector-free public search, use [the public search page](https://www.unlinked.ai/search-public). The contract and web-fetch verification requirement are owned by `docs/public-directory.md` in the repository. An experimental alternate public transport is https://unlinked-ideaflowco.vercel.app/search-public?q=gaming%20investors. Ordinary ChatGPT reader access is not established; see the alternate transport section of that contract.

On a signed recovered-account match, the browser may ask once whether to continue with the old Unlinked profile.
Import a full LinkedIn ZIP or Connections-only ZIP/CSV, maximum 64 MiB.
The server processes imports durably; /profile and /network show progress.

Current MCP endpoint: https://www.unlinked.ai/mcp (Streamable HTTP).
Current durable account tools: `unlinked_search_network` and `unlinked_search_everyone`; base input is `{ "query": "professional people search" }`.
Current grants also expose `unlinked_whoami` (stable owner id for fail-closed linkage), deterministic `unlinked_list_people` / `unlinked_list_connections` / `unlinked_get_profile` (opaque cursors, max 50 per page, typed error codes; `unlinked_list_connections` returns one entry per person with `sources[]` — grouped only on exact published-profile or LinkedIn-address evidence, never names — or one row per source with `grouping: none`, and both list tools take `sort`, where `name` ignores leading emoji/punctuation and `raw` is code-point order) and the explicit AI tool `unlinked_ai_search(query, scope: everyone|mine)`. Read-only tools include `unlinked_list_connection_requests(direction: received|sent)`, `unlinked_list_notifications(limit)` and `unlinked_lookup_contact(connectionId | linkedinUrl | profileId | refHashes)` (one of the owner's own contacts without paging, with its `linkedinRefHash` and any published profile id); connection actions require explicit opt-in, and reading notifications marks nothing seen. The same tools are served as a grant-authenticated HTTP JSON API under /api/agent/v1/; the versioned contract is `docs/agent-api.md` in the repository. Contract v1.1 adds POST /api/agent/v1/provision-grant: server-to-server grant provisioning for operator-allow-listed confidential clients, keyed on the verified OIDC issuer+subject binding (never email; typed `client_unauthorized` for client-credential failures; disabled unless configured; revoked access stays revoked). Degree 1 includes owner-imported contacts; degree 2 returns only recorded public paths with the proving path, never inferred. Grant catalog v7 adds the private people notes & relations tools under their own default-on permission (above); HTTP routes are under /api/agent/v1/private/.
For `unlinked_search_network`, optional `degree: 1|2` and `cursor` select recorded public paths from your explicitly linked recovered profile; “my second-degree connections” also selects two hops. Unknown profile anchors are denied rather than inferred. Signed browser GET /api/my-connections supports degree, q and cursor.
An explicit account grant authorizes current/future owner imports, same-owner sanitized recovered Connections observations and the published professional index until revoked in Settings.
Never derive owner authority from typed email, archive fields, profile IDs or a URL.
The backend binds signed Ideaflow issuer/subject to the owner; recovered-profile confirmation uses only server-held signed email evidence plus CSRF and can be revoked.
It enforces owner/publication/grant state on each call.
Raw archives, recovered original files, contact emails and phone numbers are excluded. OpenAI receives bounded relevant professional details.
Everyone browsing is public at GET /api/people?q=&mode=&cursor= and GET /api/people/:id. The default mode `best` matches every word in any form and order ("investors" finds "investor"), and returns people who match some of the words when nobody has them all; the response's `match` is `all`, `some` or `none`. `mode=exact` matches the typed phrase as written. A person with an operator-published profile photo carries `photo`, a same-origin versioned URL of GET /people/:id/photo (JPEG, PNG or WebP; 404 when there is none).
Everyone AI retrieval considers all public profiles, then ranks at most200 matching professional candidates. No archive is required.
Old single-tool grants retain their original narrower scope.
A downloaded/copied configuration is setup; a successful authenticated MCP call proves connection.
Direct Unlinked-only OAuth for Claude or ChatGPT (also supported alongside the shared connector): add a custom connector with the URL https://www.unlinked.ai/mcp, choose Connect, sign in to Unlinked and Allow — no token to copy. Claude: Settings → Connectors → Add custom connector. ChatGPT: developer-mode connector with OAuth. Claude Code: `claude mcp add --transport http unlinked https://www.unlinked.ai/mcp`, then `/mcp` to sign in. Discovery: /mcp answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://www.unlinked.ai/.well-known/oauth-protected-resource/mcp"`; authorization server metadata at /.well-known/oauth-authorization-server (PKCE S256, public clients, Client ID Metadata Documents for Claude's, Claude Code's and ChatGPT's published client ids, or dynamic registration at /oauth/register; redirect URIs limited to the Claude/ChatGPT connector callbacks and http://localhost / 127.0.0.1 loopback). Scopes: `network`, `people`, and optional `connections` (unchecked by default on consent). Each connection is a revocable account grant listed under Settings → Connected apps; tokens do not expire and are revoked there or at /oauth/revoke.
Header alternative for clients that cannot sign in: Streamable HTTP with header `Authorization: Bearer <grant>`. Claude Desktop/claude.ai: custom connector (Customize → Connectors, Authentication "No sign in", request header Authorization). claude_desktop_config.json accepts only local stdio servers, so use `{"command":"npx","args":["-y","mcp-remote@0.1.38","https://www.unlinked.ai/mcp","--header","Authorization:${UNLINKED_AUTH_HEADER}"],"env":{"UNLINKED_AUTH_HEADER":"Bearer <grant>"}}` there, never a url/headers entry. Claude Code: `claude mcp add --transport http unlinked https://www.unlinked.ai/mcp --header "Authorization: Bearer <grant>"`.

Owner-network AI search requires supplied title/position evidence for a requested role, omits domain-only matches, and gives short conversational reasons grounded in supplied fields, stating when sector focus is unknown; response shapes and grant versions are unchanged.

Anonymous discovery, professional People browsing and Meet are public. Owner data, uploads, settings, status and MCP require their specific authentication.
/meet scans Unlinked profile cards and OpenChat cards and always stops at an explicit confirm step; scanning never adds a contact or grants access. Signed-in members show their QR business card at /card; its contact version opens a revocable contact link, while the public-only version opens their published profile. The web app is installable (manifest at /manifest.webmanifest); the service worker precaches only fixed public shell assets and never caches member content.
Legacy Supabase APIs and legacy stdio tools remain historical code, not current onboarding instructions.

Recovered original LinkedIn files are browser-only under Settings after explicit recovered-account confirmation. GET /api/legacy-files lists your files; GET /legacy-files/:objectId downloads your original. Agents cannot retrieve raw files. Sanitized recovered Connections observations participate in the same owner network search; unknown legacy owners remain inaccessible.

Grant catalog v5 supports optional `owner_network_and_public_and_write`: `unlinked_send_connection_request(profileId, note?)`, `unlinked_accept_connection_request(id)`, `unlinked_ignore_connection_request(id)`, `unlinked_withdraw_connection_request(id)`. These require explicit opt-in in Settings or OAuth consent; existing read-only grants and default issuance stay read-only. Owner-only grants can enable actions without gaining public reads. Direct Unlinked grants cannot send messages or post; use separate OpenChat permissions through the shared connector, or a direct OpenChat key, for messaging and Context. The route, limits and grant-update contract is owned by `docs/agent-api.md` in the repository.

## Connection browsing and page depth

Public People summaries expose detailLevel (basic or detailed), derived from visible content independently of membership. Profile pages link to /people/{id}/connections for search and richer-first or alphabetical browsing of published connections. See docs/connection-browsing.md in source.

OpenChat messaging uses the same Ideaflow account. Profile recipients resolve on the server; unclaimed people use an invitation. `/api/messaging/v1/recipient` is a confidential service endpoint, not available to browser sessions or agent grants. Messages require an explicit Send; public profile publication remains opt-in.

Unlinked web Messages (`/messages`) uses the same OpenChat inbox. Its `/messages/api` JSON and event stream are browser-session only (same origin, CSRF on writes); Unlinked's server holds the member's OpenChat credential and never returns it. It is not an agent-grant endpoint. Live profile membership is shown separately from imported profile detail. See docs/openchat-message.md.

Professional profile details, outbound links and their privacy boundaries are documented in `docs/profile-details.md` in source.

## Direct OpenChat credentials

For direct OpenChat setup, use https://chat.globalbr.ai/agents: API keys,
MCP configurations, REST examples, conversation Context and troubleshooting.
OpenChat and Unlinked share an Ideaflow identity and inbox; their **direct service credentials**
are separate (the shared Ideaflow connector above provides one consented account connection). An Unlinked grant does not send messages. Use an
OpenChat `oc_` key for both messages and Context with read/write scopes and
conversation membership. In OpenChat: Settings → Agent keys → New API key.
Existing keys can be revealed and copied repeatedly; Copy setup with this key
reuses the selected key. Settings → Copy agent setup creates a fresh key.
OpenChat machine-readable docs: https://chat.globalbr.ai/AGENTS.md and
https://chat.globalbr.ai/api/openapi.json. The maintained OpenChat MCP adapter
is in https://github.com/IdeaFlowCo/OpenChat/tree/main/apps/mcp-server (local
stdio, same API key); OpenChat has no live hosted /mcp endpoint.

## Shared Ideaflow connector

Connect an agent at https://id.ideaflow.app/agents using one account connection for Unlinked, OpenChat and Thoughtstream Vision. The shared MCP URL is https://id.ideaflow.app/mcp. Each app has separate consented read/write scopes; adding another app never silently expands an existing grant. Direct Unlinked MCP/API credentials remain supported. The internal request-bound adapter at `/api/connector/mcp` resolves only existing issuer/subject account bindings and accepts no ordinary user bearer tokens. Deployment requires a dedicated `IDEAFLOW_CONNECTOR_SECRET` shared only with the gateway.

Manual-key controls and connector choice: docs/agent-key-settings.md. Historical-grant normalization, tool refresh and OAuth permission consent: docs/agent-api.md (repository).

For compatible hosts needing several apps or messages, use https://id.ideaflow.app/agents and its separate OpenChat permissions. Existing direct Claude/ChatGPT sign-in remains supported. Muse’s observed manual form uses the direct Unlinked key; Muse OAuth is unverified. Connection requests do not record private “X knows Y” relationships; those are saved with the direct key’s private notes & relations tools (above) or the connector’s OpenChat private-people tools — one shared store — and shown only to their owner on Unlinked person and contact pages (“Your private context”) and in OpenChat.

Browser-only card joining is not an agent capability. The repository guide `docs/contact-card.md` owns card sharing, signup and privacy boundaries.

## Troubleshooting request failures

When operator-enabled, direct REST/MCP responses include a server-generated X-Request-ID. For a failed query, report that response ID, time/timezone, endpoint or tool, status/error, elapsed time and query length; never send credentials, private query text or results. Diagnostics is off by default and does not prove host setup or fix earlier failures.
