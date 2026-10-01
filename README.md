Unlinked helps people carry their network into useful introductions. The public landing, network/search/setup availability pages, LinkedIn archive preparation page, Ideaflow ID sign-in status page, and `/meet` work independently of the paused legacy Supabase backend. Legacy profile and agent API implementations remain behind their backend and are preserved as historical reference.

## Meet someone

`/meet` accepts only `https://chat.globalbr.ai/c/<24-letter-or-digit-token>` and `https://chat.ideaflow.app/c/<24-letter-or-digit-token>` card URLs. It offers live camera scanning, pasted URLs, and a phone camera photo fallback. A valid payload opens the public OpenChat card page on the same host as the scanned or pasted URL, where the visitor can review the card and choose whether to send a friend request. OpenChat owns sign-in return, account checks, friend status, and the actual request. Opening a card does not itself send a request.

The page displays the legacy network's unavailable state without querying Supabase. No live profiles or cards are imported into Unlinked.

## Import LinkedIn archive

The homepage's primary action, **Start my LinkedIn export**, opens LinkedIn's data-export settings in a new tab and, with JavaScript enabled, takes the Unlinked tab to `/import-linkedin` for guidance. Request the export before login: on a personal computer, select **Connections only**, wait for LinkedIn's email, and keep the downloaded file. See [LinkedIn's current export guidance](https://www.linkedin.com/help/linkedin/answer/a1339364?lang=en) for delivery timing, download expiry and device availability. Unlinked cannot detect delivery or save your place.

The fictional homepage answer illustrates matching on company and title from connection fields; it is not a live search result and does not infer biographies or work history. The navigation offers Meet, For agents and Sign-in availability. Visitors who already have a file can go directly to `/import-linkedin#next`.

Login is the next step, using Ideaflow ID once the private account runtime is activated. Sign-in and uploads are not active on the public site yet; there is no live private account or invitation URL. The public site accepts no files, and private browsing, AI search and agent setup remain unavailable. Parser handling of Connections-only CSV or ZIP does not establish supported browser upload on the public site. Legacy account access remains paused.

See the [private archive foundation contract](docs/private-archive-import.md) for the parser/job scope, adapter requirements and activation gates.

## Core Features & Technologies

- Next.js web application with React for a modern, fast user interface
- Supabase authentication system for secure user management
- Tailwind CSS for responsive and maintainable styling
- Radix UI components for accessible interface elements
- Client-side and server-side authentication for robust security

## Agent & MCP Surface

unlinked.ai preserves a Model Context Protocol (MCP) server and REST API schema for autonomous agents. Live private sign-in, key creation and hosted MCP setup are unavailable today:

- **Setup status:** [`/agents`](https://www.unlinked.ai/agents) (or see historical implementation notes in [`mcp-server/README.md`](mcp-server/README.md))
- **Machine discovery:** [`/llms.txt`](https://www.unlinked.ai/llms.txt), [`/.well-known/unlinked.json`](https://www.unlinked.ai/.well-known/unlinked.json), [`/.well-known/mcp/server-card.json`](https://www.unlinked.ai/.well-known/mcp/server-card.json), and [`/openapi.json`](https://www.unlinked.ai/openapi.json)
- **Developer & contributor notes:** [`AGENTS.md`](AGENTS.md) (repo-internal) and [`public/AGENTS.md`](public/AGENTS.md) (HTTP agent brief)
- **MCP Server package:** [`@unlinked/mcp-server`](mcp-server/) — historical stdio server implementation supporting Claude Desktop, Claude Code, Cursor, and any MCP client
- **Agent Keys:** Historical keys start with `ul_`; no live key creation path is advertised.
- **Strict isolation:** Every legacy tool call and agent API request is resolved server-side to the authenticated user. An agent key can only access the owner's profile and direct connections.

## Private Unipile Preview Lab

See the [private lab guide](docs/unipile-lab.md) for tester usage, stage configuration, and preview limitations.

## Getting Started

For the public landing, Meet flow, availability pages and archive preparation page, install dependencies and run the development server on an available high port:

```bash
npm ci
npm run dev -- --port 7743
```

Open [http://localhost:7743](http://localhost:7743), `/meet`, `/import-linkedin`, `/network`, `/search`, `/agents`, `/auth/login`, and `/auth/signup`. These public GET/HEAD entry points bypass legacy session refresh, including trailing-slash forms, and need no Supabase environment variables or database access. Existing API and data routes retain their middleware and require the existing Supabase settings and a reachable backend.

Run `npm test` and `npx tsc --noEmit` for focused verification. To smoke test backend isolation, start the server with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` unset and confirm `/`, `/meet`, `/import-linkedin`, `/network`, `/search`, `/agents`, `/auth/login`, and `/auth/signup` return 200 or the expected signup redirect (following redirects for trailing-slash normalization). A card token with valid syntax can still be revoked or unknown; OpenChat reports that on its card page. Live own-card, friend, and account-state tests require separate OpenChat test accounts and are not covered by this repository's fixtures.

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

The isolated private Noos adapter, bounded publication journal, OIDC browser controller, scoped query-time AI tools and setup flows are documented in [Private Noos staging](docs/private-noos-staging.md). Production setup and AI search remain unavailable.

### Public network entry

See [Import LinkedIn archive](#import-linkedin-archive) for the export-first entry, navigation and private availability. `/auth/login` shows the Ideaflow ID path and current availability; `/auth/signup` returns there.
The default-off private runtime includes owner-wide multi-import browsing/search and account-scoped MCP grants, but it remains unmounted from the public app until the private release gates pass.
