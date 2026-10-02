# Unlinked agent guide

Use https://www.unlinked.ai/login for Ideaflow ID sign-in and open /settings for agent setup.
On a signed recovered-account match, the browser may ask once whether to continue with the old Unlinked profile.
Import a full LinkedIn ZIP or Connections-only ZIP/CSV, maximum 64 MiB.
The server processes imports durably; /profile and /network show progress.

Current MCP endpoint: https://www.unlinked.ai/mcp (Streamable HTTP).
Current durable account tools: `unlinked_search_network` and `unlinked_search_everyone`, input `{ "query": "professional people search" }`.
An explicit account grant authorizes current and future owner imports until revoked in Settings.
Never derive owner authority from typed email, archive fields, profile IDs or a URL.
The backend binds signed Ideaflow issuer/subject to the owner; recovered-profile confirmation uses only server-held signed email evidence plus CSRF and can be revoked.
It enforces owner/publication/grant state on each call.
Raw archives, contact emails and phone numbers are excluded. OpenAI receives bounded relevant professional details.
Everyone browsing is public at GET /api/people?q=&cursor= and GET /api/people/:id.
Everyone AI retrieval considers all public profiles, then ranks at most200 matching professional candidates. No archive is required.
Old single-tool grants retain their original narrower scope.
A downloaded/copied configuration is setup; a successful authenticated MCP call proves connection.

Anonymous discovery, professional People browsing and Meet are public. Owner data, uploads, settings, status and MCP require their specific authentication.
Legacy Supabase APIs and legacy stdio tools remain historical code, not current onboarding instructions.
