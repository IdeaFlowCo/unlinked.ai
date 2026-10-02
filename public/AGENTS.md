# Unlinked agent guide

Use https://www.unlinked.ai/login for Ideaflow ID sign-in; /settings holds your automatically prepared agent setup (view/copy, revoke or regenerate it there). No setup click is needed, repeated visits never mint duplicate grants, and a revoked automatic setup stays revoked until the owner regenerates.
On a signed recovered-account match, the browser may ask once whether to continue with the old Unlinked profile.
Import a full LinkedIn ZIP or Connections-only ZIP/CSV, maximum 64 MiB.
The server processes imports durably; /profile and /network show progress.

Current MCP endpoint: https://www.unlinked.ai/mcp (Streamable HTTP).
Current durable account tools: `unlinked_search_network` and `unlinked_search_everyone`; base input is `{ "query": "professional people search" }`.
For `unlinked_search_network`, optional `degree: 1|2` and `cursor` select recorded public paths from your explicitly linked recovered profile; “my second-degree connections” also selects two hops. Unknown profile anchors are denied rather than inferred. Signed browser GET /api/my-connections supports degree, q and cursor.
An explicit account grant authorizes current/future owner imports, same-owner sanitized recovered Connections observations and the published professional index until revoked in Settings.
Never derive owner authority from typed email, archive fields, profile IDs or a URL.
The backend binds signed Ideaflow issuer/subject to the owner; recovered-profile confirmation uses only server-held signed email evidence plus CSRF and can be revoked.
It enforces owner/publication/grant state on each call.
Raw archives, recovered original files, contact emails and phone numbers are excluded. OpenAI receives bounded relevant professional details.
Everyone browsing is public at GET /api/people?q=&mode=&cursor= and GET /api/people/:id. The default mode `best` matches every word in any form and order ("investors" finds "investor"), and returns people who match some of the words when nobody has them all; the response's `match` is `all`, `some` or `none`. `mode=exact` matches the typed phrase as written.
Everyone AI retrieval considers all public profiles, then ranks at most200 matching professional candidates. No archive is required.
Old single-tool grants retain their original narrower scope.
A downloaded/copied configuration is setup; a successful authenticated MCP call proves connection.

Anonymous discovery, professional People browsing and Meet are public. Owner data, uploads, settings, status and MCP require their specific authentication.
/meet scans Unlinked profile cards and OpenChat cards and always stops at an explicit confirm step; scanning never adds a contact or grants access. Signed-in members show their QR business card at /card; its target is their already-public profile URL. The web app is installable (manifest at /manifest.webmanifest); the service worker precaches only fixed public shell assets and never caches member content.
Legacy Supabase APIs and legacy stdio tools remain historical code, not current onboarding instructions.

Recovered original LinkedIn files are browser-only under Settings after explicit recovered-account confirmation. GET /api/legacy-files lists your files; GET /legacy-files/:objectId downloads your original. Agents cannot retrieve raw files. Sanitized recovered Connections observations participate in the same owner network search; unknown legacy owners remain inaccessible.
