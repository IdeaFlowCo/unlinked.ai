Unlinked helps people carry an in-person introduction into a lasting connection. The public landing and `/meet` work independently of the paused legacy Supabase backend. The existing profile and agent features remain behind their legacy backend.

## Meet someone

`/meet` accepts only `https://chat.globalbr.ai/c/<24-letter-or-digit-token>` and `https://chat.ideaflow.app/c/<24-letter-or-digit-token>` card URLs. It offers live camera scanning, pasted URLs, and a phone camera photo fallback. A valid payload opens the public OpenChat card page on the same host as the scanned or pasted URL, where the visitor can review the card and choose whether to send a friend request. OpenChat owns sign-in return, account checks, friend status, and the actual request. Opening a card does not itself send a request.

The page displays the legacy network's unavailable state without querying Supabase. No live profiles or cards are imported into Unlinked.

## Import LinkedIn archive

**Import LinkedIn archive** remains visible beside Meet and opens `/import-linkedin`. The page displays an unavailable state and accepts no uploads. Keep your original LinkedIn archive while the private service is being restored.

See the [private archive foundation contract](docs/private-archive-import.md) for the parser/job scope, adapter requirements and activation gates.

## Core Features & Technologies

- Next.js web application with React for a modern, fast user interface
- Supabase authentication system for secure user management
- Tailwind CSS for responsive and maintainable styling
- Radix UI components for accessible interface elements
- Client-side and server-side authentication for robust security

## Agent & MCP Surface

unlinked.ai provides a Model Context Protocol (MCP) server and REST API for autonomous agents:

- **Quick start & setup:** [`/agents`](https://www.unlinked.ai/agents) (or see [`mcp-server/README.md`](mcp-server/README.md))
- **Machine discovery:** [`/llms.txt`](https://www.unlinked.ai/llms.txt), [`/.well-known/unlinked.json`](https://www.unlinked.ai/.well-known/unlinked.json), [`/.well-known/mcp/server-card.json`](https://www.unlinked.ai/.well-known/mcp/server-card.json), and [`/openapi.json`](https://www.unlinked.ai/openapi.json)
- **Developer & contributor notes:** [`AGENTS.md`](AGENTS.md) (repo-internal) and [`public/AGENTS.md`](public/AGENTS.md) (HTTP agent brief)
- **MCP Server package:** [`@unlinked/mcp-server`](mcp-server/) — stdio server supporting Claude Desktop, Claude Code, Cursor, and any MCP client
- **Agent Keys:** Mint keys starting with `ul_` at **Settings -> Agent keys** (`/settings/agent-keys`)
- **Strict isolation:** Every tool call and agent API request is resolved server-side to the authenticated user. An agent key can only access the owner's profile and direct connections.

## Private Unipile Preview Lab

See the [private lab guide](docs/unipile-lab.md) for tester usage, stage configuration, and preview limitations.

## Getting Started

For the public landing, Meet flow and archive availability page, install dependencies and run the development server on an available high port:

```bash
npm ci
npm run dev -- --port 7743
```

Open [http://localhost:7743](http://localhost:7743), `/meet` and `/import-linkedin`. These public entry points bypass legacy session refresh, including the trailing-slash forms of `/meet` and `/import-linkedin`, and need no Supabase environment variables or database access. Existing API and data routes retain their middleware and require the existing Supabase settings and a reachable backend.

Run `npm test` and `npx tsc --noEmit` for focused verification. To smoke test backend isolation, start the server with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` unset and confirm `/`, `/meet`, `/import-linkedin` and `/import-linkedin/` return 200 (following redirects for trailing-slash normalization). A card token with valid syntax can still be revoked or unknown; OpenChat reports that on its card page. Live own-card, friend, and account-state tests require separate OpenChat test accounts and are not covered by this repository's fixtures.

For lint validation, run `npx eslint` with the changed JavaScript or TypeScript file paths. The existing `npm run lint` invokes unsupported `next lint`; ESLint is configured in `eslint.config.mjs`. No separate formatter is configured.

The landing page lives at `src/app/page.tsx`; the Meet UI lives at `src/app/meet/`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

The isolated private Noos adapter, bounded publication journal, OIDC browser controller, scoped query-time AI tools and setup download are documented in [Private Noos staging](docs/private-noos-staging.md). Production setup and AI search remain unavailable.
