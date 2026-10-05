Unlinked helps people carry their network into useful introductions. The canonical beta at https://www.unlinked.ai runs the standalone Noos-backed runtime for sign-in, import, owner-network search, settings, scoped MCP and Meet. Next.js retains the historical public pages and legacy Supabase profile/API implementations, and hosts the [experimental alternate public search transport](docs/public-directory.md#alternate-public-transport).

## Meet someone

`/meet` accepts only `https://chat.globalbr.ai/c/<24-letter-or-digit-token>` and `https://chat.ideaflow.app/c/<24-letter-or-digit-token>` card URLs. The standalone runtime offers live camera scanning and pasted URLs using the checked-in OpenChat card parser and locked `jsqr` dependency. A valid payload opens the public OpenChat card page on the same host as the scanned or pasted URL, where the visitor can review the card and choose whether to send a friend request. OpenChat owns sign-in return, account checks, friend status, and the actual request. Opening a card does not itself send a request.

Meet is anonymous and does not resolve an Unlinked owner, read an archive, or import live profiles/cards into Unlinked.

## Import LinkedIn archive

The canonical app sign-in is https://www.unlinked.ai/login.
The home page, People search (`/people`, `/network?q=`) and profile pages (`/people/{id}`) need no sign-in; a member page opened without a session offers sign-in and returns there afterwards.
Anyone can sign in or create an account through Ideaflow ID; no invitation is needed.
If the signed Ideaflow email matches one of the privately seeded recovered legacy accounts, the standalone runtime may ask once whether to continue with that old Unlinked profile before showing `/profile`.
After that explicit recovered-account confirmation, Settings may also list preserved original LinkedIn files for browser-only download; those originals are not exposed through agent grants or public People.
At `/find-me`, enter your LinkedIn profile URL and review the matching card before choosing **Yes, that's me**. When the optional operator-configured profile lookup is enabled and no legacy profile matches, the card is labeled **from your public LinkedIn profile**; confirming it makes that profile public immediately. If lookup is unavailable, continue with your name and add your export later. See the [signup profile lookup guide](docs/signup-profile-lookup.md) for configuration and source precedence.
The older private.unlinked.ai host is a rollback/release-planning origin, not the current public onboarding URL.

In LinkedIn’s [data download settings](https://www.linkedin.com/mypreferences/d/download-my-data),
choose **Download larger data archive (recommended)** for the full LinkedIn ZIP;
Connections-only is also supported. LinkedIn lists up to 24 hours for the larger
archive and up to 48 hours for Connections. Download the file within **72 hours
after the archive becomes available**, using LinkedIn’s email link. Unlinked
cannot observe that email or calculate an exact expiry time. Your downloaded
file does not expire; keep it and upload it later if needed. If the link expires,
request another export. See [LinkedIn’s export guidance](https://www.linkedin.com/help/linkedin/answer/a1339364?lang=en).
New members without an upload can receive reminder emails; see
[reminder timing, eligibility and preferences](docs/email.md#linkedin-export-reminders).
`/import-linkedin` explains how to request and keep the export, then links to sign-in and upload.
`/login` starts Ideaflow ID sign-in in the standalone runtime, and `/agents` points to Settings for Agent setup.
The fictional homepage answer illustrates title/company matching, not a live search result or inferred biography.
Public People browsing, private upload, owner-network AI search, recovered-profile confirmation, Everyone AI search and agent setup live in the canonical beta; legacy Supabase APIs remain historical and are not the login path.

See the [private archive foundation contract](docs/private-archive-import.md) for the parser/job scope and adapter requirements, and [durable archive import](docs/durable-archive-import.md) for the default-off profile-first background worker.

Signed-in People rows offer state-aware connection controls. Open
[`/network?connected=1&presence=member`](https://www.unlinked.ai/network?connected=1&presence=member)
for your connections who have joined Unlinked. See the [member connection guide](docs/member-connections.md)
for controls, confirmed removal and preservation of imported observations.

## Core Features & Technologies

- Next.js web application with React for a modern, fast user interface
- Supabase authentication system for secure user management
- Tailwind CSS for responsive and maintainable styling
- Radix UI components for accessible interface elements
- Client-side and server-side authentication for robust security

## Agent & MCP Surface

unlinked.ai exposes a canonical account-scoped MCP endpoint from the standalone runtime. The legacy REST schema and stdio package remain historical reference:

- **Setup status:** [`/agents`](https://www.unlinked.ai/agents) describes current setup; signed-in users create/revoke grants in Settings.
- **Machine discovery:** [`/llms.txt`](https://www.unlinked.ai/llms.txt), [`/.well-known/unlinked.json`](https://www.unlinked.ai/.well-known/unlinked.json), [`/.well-known/mcp/server-card.json`](https://www.unlinked.ai/.well-known/mcp/server-card.json), and [`/openapi.json`](https://www.unlinked.ai/openapi.json)
- **Developer & contributor notes:** [`AGENTS.md`](AGENTS.md) (repo-internal) and [`public/AGENTS.md`](public/AGENTS.md) (HTTP agent brief)
- **Agent permissions:** Read-only by default; optionally enable connection-request actions in Settings when regenerating a credential, or on OAuth consent for each connected app. Messaging and posting remain unavailable. See the [agent contract](docs/agent-api.md#catalog-v4-optional-connection-actions).
- **Current MCP:** Streamable HTTP at `https://www.unlinked.ai/mcp`, versioned tools documented in the [agent contract](docs/agent-api.md), authorized by a revocable account-scoped bearer grant. `degree: 1|2` or "my second-degree connections" reads recorded public paths from the explicitly confirmed recovered profile; no confirmed legacy link means no graph anchor is inferred. Sanitized recovered Connections observations can participate in owner-network search for the same confirmed owner. Older single-tool grants remain owner-network only.
- **Signed connection API:** Browser sessions can call `GET /api/my-connections?degree=1|2&q=&cursor=` for bounded recorded first- or second-degree public paths with source revision and deterministic pagination.
- **MCP Server package:** [`@unlinked/mcp-server`](mcp-server/) — historical stdio server implementation supporting the legacy REST API when that backend is available.
- **Agent Keys:** Historical REST keys start with `ul_`; current Agent setup uses the standalone runtime's account grant.
- **Strict isolation:** Current MCP grants are scoped to the owner's current and future published imports, same-owner sanitized recovered Connections observations and the published professional People index until revoked. Raw archives, recovered original files, contact email addresses and phone numbers stay out of agent access and model-returned matches. Legacy tool calls and agent API requests are resolved server-side to the authenticated user and can only access that user's profile and direct connections.

For public search without a connector or account, open [a search link](https://www.unlinked.ai/search-public?q=Stanford), replace Stanford with your query, and share the link with your web assistant. See [the public search contract](docs/public-directory.md#search-links-for-web-assistants) for scope and web-fetch verification requirements.

You can also try an [experimental alternate search link](https://unlinked-ideaflowco.vercel.app/search-public?q=Stanford). Ordinary ChatGPT access is not established; see the [alternate transport contract](docs/public-directory.md#alternate-public-transport) for limits and evidence.

## Getting Started

For the historical Next.js public pages and archive preparation source routes, install dependencies and run the development server on an available high port:

```bash
npm ci
npm run dev -- --port 7743
```

Open [http://localhost:7743](http://localhost:7743), `/meet`, `/import-linkedin`, `/network`, `/search`, `/agents`, `/auth/login`, and `/auth/signup` to inspect the Next.js source routes. These local public GET/HEAD entry points bypass legacy session refresh, including trailing-slash forms, and need no Supabase environment variables or database access. In the standalone runtime, anonymous discovery is defined by the fixed map in `mcp-server/public-discovery.mjs`; public People, company and search GET/HEAD behavior is documented in [public-directory.md](docs/public-directory.md#search-links-for-web-assistants); owner data, uploads, settings, status, recovered-original routes and MCP stay authenticated. The exact GET/HEAD `/auth/callback/ideaflow` path also bypasses legacy refresh so the canonical callback can be preflighted against the private runtime; it is not a file-upload or archive proxy. Existing API and data routes retain their middleware and require the existing Supabase settings and a reachable backend.

Run `npm test` and `npx tsc --noEmit` for focused verification. To smoke test backend isolation in Next.js, start the server with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` unset and confirm `/`, `/meet`, `/import-linkedin`, `/network`, `/search`, `/agents`, `/auth/login`, and `/auth/signup` return 200 or the expected signup redirect (following redirects for trailing-slash normalization), and that GET `/auth/callback/ideaflow` reaches the configured external callback without invoking Supabase session refresh. To smoke test the standalone anonymous discovery guard, use `createPrivateBrowserHandler` and confirm the exact paths in the discovery map return 200 for GET/HEAD without owner reads while `/settings`, `/api/legacy-files`, `/legacy-files/:objectId`, import status, uploads and POST routes remain protected. A card token with valid syntax can still be revoked or unknown; OpenChat reports that on its card page. Live own-card, friend, and account-state tests require separate OpenChat test accounts and are not covered by this repository's fixtures.

For lint validation, run `npx eslint` with the changed JavaScript or TypeScript file paths. The existing `npm run lint` invokes unsupported `next lint`; ESLint is configured in `eslint.config.mjs`. No separate formatter is configured.

The landing page lives at `src/app/page.tsx`; the Meet UI lives at `src/app/meet/`; public private-feature status pages live at `src/app/network/`, `src/app/search/`, `src/app/agents/`, and `src/app/auth/login/`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

The isolated private Noos adapter, bounded publication journal, OIDC browser controller, scoped query-time AI tools and setup flows are documented in [Private Noos staging](docs/private-noos-staging.md). Those source gates and recovery notes remain the authority for changes to the standalone runtime.

### Public network entry

See [Import LinkedIn archive](#import-linkedin-archive) for the export-first entry, navigation and private availability. `/login` starts the current Ideaflow ID path in the standalone runtime; the Next.js `/auth/login` and `/auth/signup` pages remain local/historical source routes.
The standalone runtime includes durable profile-first archive processing, owner-wide multi-import browsing/search, browser-only recovered-original downloads and account-scoped MCP grants. The Next.js app still retains historical/public source routes rather than hosting that runtime.

The canonical landing page gives “Start my LinkedIn export” the same prominence
as “Create my profile.” Opening LinkedIn changes the export link to a quieter
green checked “Export page opened” state, remembered in that browser for four
days even before sign-in. This records only opening the settings page, never a confirmed export
request, account identity or the LinkedIn email’s arrival. Browser storage is
best-effort localStorage; when storage is blocked, the checked state lasts only
on the current page. The native outbound link works without JavaScript or storage.

The current app version is the root `package.json` version, shown unobtrusively
in the standalone runtime footer and the Next.js public shell footer. The
MCP package has its own release version; keep its package/lockfile metadata and
legacy stdio server version aligned when releasing that package.
