# unlinked.ai — Repository Agent Memory

Next.js 15 (App Router) + React 19 + Radix UI Themes + Supabase + Pinecone + OpenAI.
The canonical beta at **https://www.unlinked.ai** runs the standalone Noos-backed runtime; Next.js retains historical/public source routes.

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

See [README.md](README.md#import-linkedin-archive) for the canonical export-first journey and availability, and its [Getting Started](README.md#getting-started) section for the distinction between Next.js source routes and standalone-runtime anonymous discovery. Legacy API schemas remain historical reference documentation.

## Private archive foundation

The default-off private Noos/OIDC browser/scoped AI and hosted setup slice and its immutable combined upload consent (private retention and bounded OpenAI browser/search-only agent processing), fail-closed legacy import behavior, and production gates are documented in `docs/private-noos-staging.md`.
The trusted invited-owner browser callback and direct Noos claim/readback wiring are documented in `docs/private-invited-browser.md`; they never infer ownership from email or imported profile data.
The open-account private runtime adds issuer/subject signup, durable profile-first archive processing, recovered legacy-account confirmation, owner-wide network search and persistent account-scoped MCP grants; see `docs/durable-archive-import.md`, `docs/private-pilot-release-plan.md` and `deploy/private-pilot/ACCOUNT-LAUNCH.md`.
The exact canonical-host callback/runtime transition is documented in `deploy/private-pilot/CANONICAL-HOST.md`.
The standalone private runtime composition and guarded deployment/recovery commands are in `mcp-server/private-composition.mjs` and `deploy/private-pilot/README.md`; the canonical beta uses that runtime at `https://www.unlinked.ai` while the public Next.js application retains historical/source routes.

See `docs/private-archive-import.md` for the bounded parser/job adapter contract, `docs/durable-archive-import.md` for the default-off background worker/status/profile behavior, the test adapter boundary and links to live activation gates; see `README.md` for the public archive entry.

## Directory Structure

- `src/app/`: Next.js App Router pages and API routes (`src/app/api/`).
- `src/app/agents/`: Human-readable setup availability page for agent users (served at `/agents`).
- `src/app/network/` and `src/app/search/`: Public private-feature availability pages that avoid legacy backend calls.
- `src/components/`: Reusable React components (Radix UI Themes).
- `src/utils/agent-auth.ts`: Agent key hashing, JWT minting, caller resolution, and scoping helpers.
- `src/utils/contact-search.ts`: Scoped connection filtering and OpenAI LLM re-ranking.
- `src/utils/ai-search.ts`: Pinecone vector search and OpenAI embedding generation.
- `src/utils/private-import/account-network.mjs`: Owner-wide import discovery/search for the default-off account runtime.
- `src/utils/public-people/member-projection.mjs`: Shared public People projection, including live recovered-profile overlays for confirmed owners.
- `mcp-server/legacy-account-*.mjs`: Offline hash-only recovered-account manifest and operator helpers.
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

The provenance-backed one/two-hop reader, signed HTTP API and account MCP degree inputs are documented in `docs/private-pilot-release-plan.md`; an explicitly confirmed recovered profile is currently required as the graph anchor.

## Canonical anonymous discovery

`mcp-server/public-discovery.mjs` mounts exact GET/HEAD discovery/import/Meet routes before session resolution; its fixed asset map never exposes owner data or request-selected files.

Shared public People/API/AI and backward-compatible account grant behavior are documented in `docs/shared-people-beta.md`; no raw private import or identity data is projected publicly.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
