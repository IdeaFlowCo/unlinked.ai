# unlinked.ai MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) adapter for the historical [unlinked.ai](https://www.unlinked.ai) agent API. It lets any MCP-aware client (Claude Desktop, Claude Code, Cursor, Cline, Codex CLI, ...) search a legacy private network, look up profiles, draft intros, and list LinkedIn imports when a valid legacy agent key and backend are available.

**Scoped by design:** every tool call is resolved to your own account server-side. An agent key can only see your own profile and your direct connections -- never anyone else's network.

## Current availability

Current sign-in, archive upload, owner-network search, Everyone search, public People browsing and hosted Agent setup run in the canonical beta at https://www.unlinked.ai. `/agents` and the machine discovery files describe that Streamable HTTP account MCP setup. The setup examples below are preserved as historical implementation notes for the legacy stdio server, recovery and local development.

The standalone runtime's hosted account MCP handler uses a separate bearer audience, exposes `unlinked_search_network` plus `unlinked_search_everyone` for new grants, searches all current owner imports plus future imports and the published professional People index until revoked, and is documented in `../deploy/private-pilot/ACCOUNT-LAUNCH.md`; it is not the legacy stdio server below. Older single-tool grants remain owner-network only.

## Historical setup reference

1. Sign in to a legacy private unlinked.ai account after that historical access is enabled -> **Settings -> Agent keys -> create key**
2. Copy the key (starts with `ul_`)
3. Build the server from a local clone (see **Local clone** below; it is not published to npm)
4. Paste one of the snippets below into your MCP client's config, replacing `/absolute/path/to/unlinked.ai` with your clone's path

## Claude Code

After cloning and building locally (see below), point directly at the built server:

```bash
claude mcp add unlinked \
  --env UNLINKED_API_KEY=ul_your_key_here \
  -- node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js
```

> **Not currently working:** `npx -y github:IdeaFlowCo/unlinked.ai --prefix mcp-server` fails with `could not determine executable to run` (the server is not published to npm). Use the local build above.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "unlinked": {
      "command": "node",
      "args": ["/absolute/path/to/unlinked.ai/mcp-server/dist/index.js"],
      "env": {
        "UNLINKED_API_KEY": "ul_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. With a valid legacy key and reachable backend, the unlinked tools appear in the tools menu.

## Local clone (for development)

```bash
git clone https://github.com/IdeaFlowCo/unlinked.ai
cd unlinked.ai/mcp-server
npm install && npm run build
UNLINKED_API_KEY=ul_... npm start
```

## Authentication

For the historical API, set the API key one of two ways (checked in this order):

1. `UNLINKED_API_KEY` environment variable
2. `~/.unlinked/credentials.json`:
   ```json
   { "apiKey": "ul_your_key_here", "baseUrl": "https://www.unlinked.ai" }
   ```

The server will fail tool calls with a clear error message if neither is set. A configured legacy client is not proof of access; current setup is confirmed by a successful scoped `unlinked_search_network` or `unlinked_search_everyone` call against `https://www.unlinked.ai/mcp` using the standalone runtime's account grant.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `UNLINKED_API_KEY` | — | Bearer token (`ul_…` agent key). Falls back to `~/.unlinked/credentials.json`. |
| `UNLINKED_BASE_URL` | `https://www.unlinked.ai` | unlinked.ai server URL. |

## Tools

| Tool | Description |
|---|---|
| `unlinked_me` | Your own profile plus connection / upload counts |
| `unlinked_search_contacts(query, limit?)` | Semantic search over your direct connections only (max 25 results) |
| `unlinked_get_profile(profileId)` | Read a profile -- yours or a direct connection's; anything else is not-found |
| `unlinked_list_imports` | Your LinkedIn archive uploads and ingested-record counts |
| `unlinked_draft_intro(contactProfileId, context?)` | Draft a short, forwardable intro to a direct connection (read-only, nothing is written) |

## Security

- Agent keys are stored server-side as a sha256 hash only; the plaintext key is shown once at creation time.
- Every request is resolved to the authenticated caller server-side -- no request parameter selects whose network is being searched.
- Revoke a legacy key from **Settings -> Agent keys** when historical private key management is enabled.
