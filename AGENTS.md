# unlinked.ai — Repository Agent Memory

Next.js 15 (App Router) + React 19 + Radix UI Themes + Supabase + Pinecone + OpenAI.
Hosted on Vercel at **https://www.unlinked.ai**.

This file is the repo-internal guide for autonomous agents and contributors working *in* this codebase. For agents arriving at unlinked.ai over HTTP, see the public brief at `public/AGENTS.md` (served at `/AGENTS.md`).

## Architecture & Core Invariants

- **Legacy Authentication & Agent Keys:**
  - Browser sessions authenticate via Supabase cookies.
  - Agent and MCP requests authenticate via `Authorization: Bearer ul_<key>`.
  - Keys start with `ul_` followed by 32 base64url random bytes. Stored as SHA-256 hashes in `agent_keys` with owner-only RLS.
  - Handled in `src/utils/agent-auth.ts`: Bearer tokens mint a short-lived user JWT (15 min) rather than using a service-role client, ensuring Postgres RLS enforces isolation.
  - Agent key management (`/api/agent-keys`, `/api/agent-keys/[id]`) requires browser session cookies (`allowAgentKey: false`). Agent keys cannot mint or revoke other agent keys.
- **Server-Side Scoping Guarantee:**
  - For agent-facing endpoints, the caller's profile is resolved server-side from the authenticated token via `resolveCallerProfile(caller)`.
  - Endpoints (`/api/search-contacts`, `/api/profiles/[id]`, `/api/draft-intro`) strictly verify direct connections (`isDirectConnection`).
  - `/api/profiles/[id]` returns 404 (never 403) for an unrelated profile ID, preventing enumeration of whether an unrelated profile exists.
  - Drafting intros (`/api/draft-intro`) is read-only and never writes to the database.
- **Legacy MCP Server:**
  - Package `@unlinked/mcp-server` lives in `mcp-server/`. Runs as a stdio server (`@modelcontextprotocol/sdk`).
  - Reads `UNLINKED_API_KEY` or `~/.unlinked/credentials.json`.
  - Exposes 5 tools: `unlinked_me`, `unlinked_search_contacts`, `unlinked_get_profile`, `unlinked_list_imports`, and `unlinked_draft_intro`.
- **Internal Cron:**
  - `/api/cron/embed` is an internal Vercel Cron job guarded by `CRON_SECRET`. It is not an agent-facing route.
- **Backend Deployment Note:**
  - The Supabase backend is hosted on a free plan and may be paused. Local builds and tests should not depend on live database uptime.

## Public entry availability

See [README.md](README.md#import-linkedin-archive) for the public export-first journey and availability, and its [Getting Started](README.md#getting-started) section for backend-independent public routes. Legacy API schemas remain historical reference documentation.

## Private archive foundation

The default-off private Noos/OIDC browser/scoped AI and hosted setup slice and its immutable combined upload consent (private retention and bounded OpenAI browser/search-only agent processing), fail-closed legacy import behavior, and production gates are documented in `docs/private-noos-staging.md`.
The trusted invited-owner browser callback and direct Noos claim/readback wiring are documented in `docs/private-invited-browser.md`; they never infer ownership from email or imported profile data.
The standalone private runtime composition and guarded deployment/recovery commands are in `mcp-server/private-composition.mjs` and `deploy/private-pilot/README.md`; they remain unmounted in the public Next.js application.

See `docs/private-archive-import.md` for the bounded parser/job adapter contract, the test adapter boundary and links to live activation gates; see `README.md` for the public archive entry.

## Directory Structure

- `src/app/`: Next.js App Router pages and API routes (`src/app/api/`).
- `src/app/agents/`: Human-readable setup availability page for agent users (served at `/agents`).
- `src/app/network/` and `src/app/search/`: Public private-feature availability pages that avoid legacy backend calls.
- `src/components/`: Reusable React components (Radix UI Themes).
- `src/utils/agent-auth.ts`: Agent key hashing, JWT minting, caller resolution, and scoping helpers.
- `src/utils/contact-search.ts`: Scoped connection filtering and OpenAI LLM re-ranking.
- `src/utils/ai-search.ts`: Pinecone vector search and OpenAI embedding generation.
- `mcp-server/`: Standalone `@unlinked/mcp-server` package.
- `public/`: Static discovery assets (`llms.txt`, `AGENTS.md`, `openapi.json`, `robots.txt`, `sitemap.xml`, `.well-known/`).

## Common Commands

```bash
# Web application
npm run dev           # Next.js dev server with Turbopack
npm run build         # Next.js production build

# Tests
npm test              # Run verification tests with node --test

# MCP server
cd mcp-server
npm install
npm run build         # TypeScript build into dist/
npm start             # Start MCP server on stdio
```

See `README.md` for focused lint validation.

## Discovery Surface & Parity Rule

When modifying agent endpoints, tools, or authentication, always update the full discovery inventory in the same PR:
1. `public/llms.txt` — llmstxt.org index
2. `public/AGENTS.md` — HTTP agent brief
3. `public/.well-known/unlinked.json` — machine-readable product descriptor
4. `public/.well-known/mcp/server-card.json` — MCP server card
5. `public/openapi.json` — OpenAPI 3.1.0 specification
6. `src/app/agents/page.tsx` — human-readable setup availability page at `/agents`
7. Root `AGENTS.md` — repo-internal agent memory

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
