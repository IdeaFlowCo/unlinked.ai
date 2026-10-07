# Unlinked agent guide

## Connect or search now

The default is one **Ideaflow connection** for Unlinked, OpenChat and Thoughtstream Vision, with separate app permissions. Start at https://id.ideaflow.app/agents?app=unlinked and read https://id.ideaflow.app/agents/guide. Shared MCP: https://id.ideaflow.app/mcp. Client routes and evidence status: https://id.ideaflow.app/agents/clients.json.

- **Public people search:** https://www.unlinked.ai/search-public or GET https://www.unlinked.ai/api/people?q=QUERY. No login, agent credential or LinkedIn export required. Verify the actual response before claiming the host can read it; reader compatibility is not established for every agent.
- **Private network:** reuse an existing connection; otherwise use the host's supported installation and authorization flow. Check identity and available data before suggesting an import. No export is required to establish a connection.
- **ChatGPT / dots:** install and enable the shared OAuth MCP plugin through the host's supported plugin flow. Reading a URL or pasting an API key into chat does not install a plugin. If the agent has no installation tool, identify the exact host setup step. See the shared guide; directory publication and actual dot acceptance are not established.
- **Meta Muse:** ask it to create a custom API connector from https://www.unlinked.ai/openapi.json. For private access use your Unlinked grant through its supported credential setup, with Authorization: Bearer on this origin only. First GET /api/agent/v1/whoami, then a read-only query. This is a documented integration approach, not a verified Muse installation. Native Muse MCP support is not assumed.
- **Claude, Claude Code, Codex, Gemini CLI, Cursor, Hermes and other agents:** use the exact host guide above. Prefer shared OAuth where compatible; scoped per-app API credentials remain alternatives. A model/brand name alone does not identify the host's tools or permissions.

Connection progress is: guide read → integration available in host → account authorized → read query verified. Report the actual stopping point; do not claim connected after copying configuration. In shared MCP, call get_profile and get_connection_status, then a consented app read. For Unlinked tools the shared prefix is unlinked__ (for example unlinked__unlinked_whoami); use tools/list for exact names. Direct Unlinked MCP tool names below have no shared prefix.

Keep missing authorization, permission denial, a missing app account, pending import, empty data, and zero query matches distinct. An import count of zero does not rule out recovered connections. If readiness is unknown, say so; never infer an empty network from one unsuccessful query. Honor cancellation and revocation. Never send messages or modify shared notes as a setup test. Supply credentials through the host's supported credential flow, not a copied setup prompt.


For connector-free public search, use [the public search page](https://www.unlinked.ai/search-public). The contract and web-fetch verification requirement are owned by `docs/public-directory.md` in the repository. An experimental alternate public transport is https://unlinked-ideaflowco.vercel.app/search-public?q=gaming%20investors. Ordinary ChatGPT reader access is not established; see the alternate transport section of that contract.

Use https://www.unlinked.ai/login for Ideaflow ID sign-in. Settings preserves your automatically prepared credential; revoked automatic access stays revoked until you explicitly create a key. No archive is needed to connect.

Manual keys: open [Settings → API keys](https://www.unlinked.ai/settings#api-keys) for **Copy API key** or **Copy agent setup**. See [key management](https://www.unlinked.ai/agents) for setup and Muse field formats; the lifecycle and release contract is `docs/agent-key-settings.md` in the repository.
On a signed recovered-account match, the browser may ask once whether to continue with the old Unlinked profile.
Import a full LinkedIn ZIP or Connections-only ZIP/CSV, maximum 64 MiB.
The server processes imports durably; /profile and /network show progress.

Current MCP endpoint: https://www.unlinked.ai/mcp (Streamable HTTP).
Current durable account tools: `unlinked_search_network` and `unlinked_search_everyone`; base input is `{ "query": "professional people search" }`.
Current grants also expose `unlinked_whoami` (stable owner id for fail-closed linkage), deterministic `unlinked_list_people` / `unlinked_list_connections` / `unlinked_get_profile` (opaque cursors, max 50 per page, typed error codes) and the explicit AI tool `unlinked_ai_search(query, scope: everyone|mine)`. Grants from catalog version 3 add read-only `unlinked_list_connection_requests(direction: received|sent)` and `unlinked_list_notifications(limit)`; connection actions require explicit opt-in, and reading notifications marks nothing seen. The same tools are served as a grant-authenticated HTTP JSON API under /api/agent/v1/; the versioned contract is `docs/agent-api.md` in the repository. Contract v1.1 adds POST /api/agent/v1/provision-grant: server-to-server grant provisioning for operator-allow-listed confidential clients, keyed on the verified OIDC issuer+subject binding (never email; typed `client_unauthorized` for client-credential failures; disabled unless configured; revoked access stays revoked). Degree 1 includes owner-imported contacts; degree 2 returns only recorded public paths with the proving path, never inferred.
For `unlinked_search_network`, optional `degree: 1|2` and `cursor` select recorded public paths from your explicitly linked recovered profile; “my second-degree connections” also selects two hops. Unknown profile anchors are denied rather than inferred. Signed browser GET /api/my-connections supports degree, q and cursor.
An explicit account grant authorizes current/future owner imports, same-owner sanitized recovered Connections observations and the published professional index until revoked in Settings.
Never derive owner authority from typed email, archive fields, profile IDs or a URL.
The backend binds signed Ideaflow issuer/subject to the owner; recovered-profile confirmation uses only server-held signed email evidence plus CSRF and can be revoked.
It enforces owner/publication/grant state on each call.
Raw archives, recovered original files, contact emails and phone numbers are excluded. OpenAI receives bounded relevant professional details.
Everyone browsing is public at GET /api/people?q=&mode=&cursor= and GET /api/people/:id. The default mode `best` matches every word in any form and order ("investors" finds "investor"), and returns people who match some of the words when nobody has them all; the response's `match` is `all`, `some` or `none`. `mode=exact` matches the typed phrase as written. A person with an operator-published profile photo carries `photo`, a same-origin versioned URL of GET /people/:id/photo (JPEG, PNG or WebP; 404 when there is none).
Everyone AI retrieval considers all public profiles, then ranks at most200 matching professional candidates. No archive is required.
Old single-tool grants retain their original narrower scope.
Optional direct Unlinked-only OAuth (shared Ideaflow setup above is the default): add a custom connector with the URL https://www.unlinked.ai/mcp, choose Connect, sign in to Unlinked and Allow — no token to copy. Claude: Settings → Connectors → Add custom connector. ChatGPT: developer-mode connector with OAuth. Claude Code: `claude mcp add --transport http unlinked https://www.unlinked.ai/mcp`, then `/mcp` to sign in. Discovery: /mcp answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://www.unlinked.ai/.well-known/oauth-protected-resource/mcp"`; authorization server metadata at /.well-known/oauth-authorization-server (PKCE S256, public clients, Client ID Metadata Documents for Claude's, Claude Code's and ChatGPT's published client ids, or dynamic registration at /oauth/register; redirect URIs limited to the Claude/ChatGPT connector callbacks and http://localhost / 127.0.0.1 loopback). Scopes: `network`, `people`, and optional `connections` (unchecked by default on consent). Each connection is a revocable account grant listed under Settings → Connected apps; tokens do not expire and are revoked there or at /oauth/revoke.
Header alternative for clients that cannot sign in: Streamable HTTP with header `Authorization: Bearer <grant>`. Claude Desktop/claude.ai: custom connector (Customize → Connectors, Authentication "No sign in", request header Authorization). claude_desktop_config.json accepts only local stdio servers, so use `{"command":"npx","args":["-y","mcp-remote@0.1.38","https://www.unlinked.ai/mcp","--header","Authorization:${UNLINKED_AUTH_HEADER}"],"env":{"UNLINKED_AUTH_HEADER":"Bearer <grant>"}}` there, never a url/headers entry. Claude Code: `claude mcp add --transport http unlinked https://www.unlinked.ai/mcp --header "Authorization: Bearer <grant>"`.

Owner-network AI search requires supplied title/position evidence for a requested role, omits domain-only matches, and gives short conversational reasons grounded in supplied fields, stating when sector focus is unknown; response shapes and grant versions are unchanged.

Anonymous discovery, professional People browsing and Meet are public. Owner data, uploads, settings, status and MCP require their specific authentication.
/meet scans Unlinked profile cards and OpenChat cards and always stops at an explicit confirm step; scanning never adds a contact or grants access. Signed-in members show their QR business card at /card; its target is their already-public profile URL. The web app is installable (manifest at /manifest.webmanifest); the service worker precaches only fixed public shell assets and never caches member content.
Legacy Supabase APIs and legacy stdio tools remain historical code, not current onboarding instructions.

Recovered original LinkedIn files are browser-only under Settings after explicit recovered-account confirmation. GET /api/legacy-files lists your files; GET /legacy-files/:objectId downloads your original. Agents cannot retrieve raw files. Sanitized recovered Connections observations participate in the same owner network search; unknown legacy owners remain inaccessible.

Grant catalog v4 adds optional `owner_network_and_public_and_write`: `unlinked_send_connection_request(profileId, note?)`, `unlinked_accept_connection_request(id)`, `unlinked_ignore_connection_request(id)`, `unlinked_withdraw_connection_request(id)`. These require explicit opt-in in Settings or OAuth consent; existing grants and default issuance remain read-only. For messaging permissions, see [shared setup](https://id.ideaflow.app/agents?app=unlinked). The route, limits and grant-update contract is owned by `docs/agent-api.md` in the repository.

## Connection browsing and page depth

Public People summaries expose detailLevel (basic or detailed), derived from visible content independently of membership. Profile pages link to /people/{id}/connections for search and richer-first or alphabetical browsing of published connections. See docs/connection-browsing.md in source.

OpenChat messaging uses the same Ideaflow account. Profile recipients resolve on the server; unclaimed people use an invitation. `/api/messaging/v1/recipient` is a confidential service endpoint, not available to browser sessions or agent grants. Messages require an explicit Send; public profile publication remains opt-in.

Unlinked web Messages (`/messages`) uses the same OpenChat inbox. `/messages/session` is browser-session + same-origin CSRF only; it is not an agent-grant endpoint. Live profile membership is shown separately from imported profile detail. See docs/openchat-message.md.

## Direct app API alternatives

The shared connection above is the default. Existing direct Unlinked grants and OpenChat `oc_` keys remain service-specific. An Unlinked grant cannot send OpenChat messages. OpenChat direct API and Context documentation: https://chat.ideaflow.app/agents. Never send one app's credential to another app. Original archive files remain browser-only.

## Shared Ideaflow connector

Connect an agent at https://id.ideaflow.app/agents using one account connection for Unlinked, OpenChat and Thoughtstream Vision. The shared MCP URL is https://id.ideaflow.app/mcp. Each app has separate consented read/write scopes; adding another app never silently expands an existing grant. Direct Unlinked MCP/API credentials remain supported. The internal request-bound adapter at `/api/connector/mcp` resolves only existing issuer/subject account bindings and accepts no ordinary user bearer tokens. Deployment requires a dedicated `IDEAFLOW_CONNECTOR_SECRET` shared only with the gateway.
