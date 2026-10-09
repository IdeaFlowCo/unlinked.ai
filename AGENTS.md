# unlinked.ai — Repository Agent Memory

The canonical beta at **https://www.unlinked.ai** runs the standalone Noos-backed runtime (`mcp-server/private-composition.mjs`). Next.js 15 / React 19 / Radix UI retains historical/public source routes; its Supabase authentication and legacy agent keys below are not canonical onboarding.

This file is the repo-internal guide for autonomous agents and contributors working *in* this codebase. For agents arriving at unlinked.ai over HTTP, see the public brief at `public/AGENTS.md` (served at `/AGENTS.md`).

## Canonical agent setup and grant invariants

Settings presents API keys before client instructions: named independent keys, repeatable Show/Copy API key, retained Copy agent setup, and a compact per-key connection-action permission switch. Reveal/copy never issue or rotate credentials. Shared Ideaflow OAuth is recommended for compatible multi-app hosts; direct Unlinked OAuth and manual keys remain supported. Muse manual setup is documented; Muse OAuth is unverified. The authoritative UI/lifecycle contract is [docs/agent-key-settings.md](docs/agent-key-settings.md); authentication, tool normalization and provisioning are in [docs/agent-api.md](docs/agent-api.md).

- Historical `ACCOUNT_GRANT_TOOL_VERSIONS` lists are immutable validation records. Valid old grants resolve **current tools within their original enabled scope**; new tools do not require token rotation. Auth, discovery, whoami, Settings and execution must agree on effective capabilities.
- Manual permission edits preserve jti, issuedAt and generation (identical token bytes). Owner-only grants may enable connection actions without gaining public reads. OAuth additions require consent; connection actions do not grant messaging or private relationship assertions.
- Owner/session/CSRF checks and compare-and-set protect lifecycle edits. Replacement changes only the selected key's generation; revocation tombstones and generation checks prevent resurrection or reuse of replaced secrets. Revalidate the live identity/generation and requested tool, not entire tool-array equality. Retain generation/v5 validation on rollback.
- Read-only provisioning never returns a write-enabled Default key. If no eligible read-only grant exists and the deterministic Default is write-enabled, use the bounded independent read-only fallback while preserving the original read boundary and tombstones. Reauthentication at the end must check effective read-only scope as well as owner; a concurrent permission change must not return a write token.

## Legacy Next.js architecture (historical, not canonical runtime)

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
Account grant provisioning and OAuth isolation are owned by `docs/agent-api.md` ("Grant provisioning" and "OAuth connector"). Bearer tokens are re-derived from durable grant records and must never enter logs, audit events or error messages.
Members show a QR business card at `/card` (inline SVG from the dependency-free encoder `src/utils/qr-code.mjs`, round-trip tested with jsQR); its target is only a snapshot-verified public profile URL. The card's second version carries opt-in contact details (phone, WhatsApp, email, link) behind a random resettable link `/c/<token>`; those details must never reach public profiles, search, model context or agent tools (`docs/contact-card.md`). `/meet` classifies Unlinked profile and OpenChat QR codes through `src/utils/meet-scan.js` and always requires an explicit confirm before opening. The header search field's QR button opens `/scan` (`renderScan`): a Scan tab reusing the `/meet` scanner (`MEET_SCRIPT`, same element ids) and a My card tab; signed-in members get one `<details>` "Me" menu (`meMenu`) whose headline is filled per request via `fillMeHeadline`, enhanced by `TOP_BAR_SCRIPT` on every page's nonce. The PWA surface (`public/manifest.webmanifest`, `public/sw.js`, icons via `scripts/generate-pwa-icons.mjs`) precaches only fixed public shell assets — never member content; keep it that way when changing caching.

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

Owner-role evidence ranking and its compatibility/latency boundaries are documented in `docs/agent-api.md` (AI search). The local role guard and empty/hedged-reason fallback are `src/utils/private-import/search-evidence.mjs`; model-written conversational reasons are otherwise preserved; fictional regression fixtures and the opt-in model evaluation are in `tests/fixtures/private-search-people.mjs` and `scripts/eval-private-search-ranking.mjs`.

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

Company page facts (`/companies/<name>`) are the static list in `mcp-server/company-metadata.mjs` overlaid by the operator-published graph dataset `curated-companies-v1` (own labels, revoke-based rollback, static fallback on read errors); schema, publisher and rollback are in `docs/company-facts.md`.

Member-to-member connection requests (Connect, `/invitations`) and the per-account notification feed (`/notifications`, header bell and My Network badges filled per request via `fillNavAlerts`) are documented in `docs/member-connections.md`; graph labels `UnlinkedConnectionRequest` and `UnlinkedNotification`.

The versioned agent tool contract — hosted MCP tools plus the grant-authenticated HTTP JSON API under `/api/agent/v1/` (`mcp-server/account-tools.mjs`, `account-api.mjs`), typed error codes, grant-scope version catalog and old-grant compatibility — is `docs/agent-api.md`. Grant tool lists are versioned in `ACCOUNT_GRANT_TOOL_VERSIONS` (`mcp-server/account-grants.mjs`): add a new version to add tools; never mutate an existing version's list.

Sign-in is one "Sign in with Ideaflow" control with silent SSO; only an explicit sign-out, Switch account or an invitation binding asks Ideaflow ID for `prompt=select_account` (`docs/ideaflow-sign-in.md`). Do not add other sign-in options or `prompt=login`. Signed-out page views make one silent `prompt=none` hop per browser session (automatic sign-in; kill switch `UNLINKED_AUTO_SIGNIN=off`); a silent attempt creates only the private app record, never a public profile or confirmation step (same doc).

MCP clients connect with OAuth ("paste the URL and sign in"): `mcp-server/oauth-server.mjs` is the authorization server for `/mcp` (RFC 9728/8414 metadata, CIMD for three exact published client ids (Claude, Claude Code, ChatGPT) plus stateless HMAC-signed DCR client ids, redirect URIs limited to the Claude/ChatGPT callbacks and loopback, PKCE S256, consent at `/oauth/authorize` in `private-browser.mjs`). Its access token is an ordinary account grant carrying `payload.connection`; isolation from manual keys is owned by the contract: `docs/agent-api.md` ("OAuth connector").

The immutable private legacy Storage recovery, owner confirmation/download boundary and offline operator are documented in `docs/legacy-storage-recovery.md`; originals are excluded from agent grants and public projections.

Shared browser/agent connection authorization is in `mcp-server/connection-actions.mjs`; opt-in writes and grant update hints are documented in `docs/agent-api.md`.

Member email configuration, invite caps, export reminders, privacy and unsubscribe boundaries are owned by [docs/email.md](docs/email.md); implementation: `mcp-server/member-email.mjs`.

Operator-published profile photos (offline `mcp-server/publish-profile-photos.mjs`, read-only store `mcp-server/profile-photos.mjs`) live under `assets/profile-photos.public/` and are served same-origin at `GET/HEAD /people/<id>/photo`; views take `photo` only in the exact `PHOTO_URL` grammar and fall back to initials. Layout, publish/revoke host commands, the `hidden` precedence hook and the ingress Cache-Control map: `docs/profile-photos.md`.

The optional operator-configured signup profile lookup (default off; a private host adapter behind the contract in `mcp-server/signup-profile-lookup.mjs`), its durable quota/cache/confirmed source store and later export precedence are documented in `docs/signup-profile-lookup.md`; keep find-me provenance separate from recovered legacy claims and keep adapter specifics out of this repository.

## Connection browsing and page depth

Public People summaries expose detailLevel (basic or detailed), derived from visible content independently of membership. Profile pages link to /people/{id}/connections for search and richer-first or alphabetical browsing of published connections. See docs/connection-browsing.md in source.

## Connector-free web search

Connector-free public search, public HEAD behavior and the experimental anonymous Vercel transport are owned by [docs/public-directory.md](docs/public-directory.md); renderer: `mcp-server/public-web-search.mjs`. Ordinary ChatGPT reader access requires separate evidence.

Profile **Message with OpenChat** shared identity resolution, explicit Send and private-only fallback are documented in [docs/openchat-message.md](docs/openchat-message.md); link validator: `src/utils/openchat-profile-context.mjs`. Profile names/imported email never prove an OpenChat recipient.

Unlinked is the network and OpenChat its messenger. The confidential `/api/messaging/v1/recipient` service resolves published-profile ownership to a shared Ideaflow identity; it is not a browser/agent-grant endpoint. See docs/openchat-message.md.

Unlinked web Messages (`/messages`) uses the same OpenChat inbox. `/messages/session` is browser-session + same-origin CSRF only; it is not an agent-grant endpoint. Live profile membership is shown separately from imported profile detail. See docs/openchat-message.md.

## People directory controls

The standalone browser's progressive filtering, URL state, ordering and private date provenance are described in `docs/network-controls.md`. Browser ordering is not an agent API contract change; preserve existing agent defaults and keep owner relationship dates out of public profile projections.

Public setup links to the shared OpenChat + Unlinked agent hub at
`https://chat.globalbr.ai/agents`. Identity/inbox are shared; **direct service credentials**
remain separate (the shared Ideaflow connector below uses one consented account connection). OpenChat `oc_` keys cover messages and Context; Unlinked grants
retain their existing scopes. Never send an Unlinked grant to OpenChat.

## Shared Ideaflow connector

Connect an agent at https://id.ideaflow.app/agents using one account connection for Unlinked, OpenChat and Thoughtstream Vision. The shared MCP URL is https://id.ideaflow.app/mcp. Each app has separate consented read/write scopes; adding another app never silently expands an existing grant. Direct Unlinked MCP/API credentials remain supported. The internal request-bound adapter at `/api/connector/mcp` resolves only existing issuer/subject account bindings and accepts no ordinary user bearer tokens. Deployment requires a dedicated `IDEAFLOW_CONNECTOR_SECRET` shared only with the gateway.

Settings manual-key setup, lifecycle, compatibility and release/rollback constraints are owned by `docs/agent-key-settings.md`.
