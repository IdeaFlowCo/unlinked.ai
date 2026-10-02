# Unlinked agent guide

Use https://www.unlinked.ai/login for Ideaflow ID sign-in and open /settings for agent setup.
Import a full LinkedIn ZIP or Connections-only ZIP/CSV, maximum 64 MiB.
The server processes imports durably; /profile and /network show progress.

Current MCP endpoint: https://www.unlinked.ai/mcp (Streamable HTTP).
Current durable account tool: `unlinked_search_network`, input `{ "query": "professional people search" }`.
An explicit account grant authorizes current and future owner imports until revoked in Settings.
Never derive owner authority from typed email, archive fields, profile IDs or a URL.
The backend binds verified Ideaflow issuer/subject to the owner; it enforces owner/publication/grant state on each call.
Raw archives, contact emails and phone numbers are excluded. OpenAI receives bounded relevant professional details.
Global search is not available through this current contract.
A downloaded/copied configuration is setup; a successful authenticated MCP call proves connection.

Anonymous discovery and Meet are public. Owner data, uploads, settings, status and MCP require their specific authentication.
Legacy Supabase APIs and legacy stdio tools remain historical code, not current onboarding instructions.
