# unlinked.ai MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) adapter for [unlinked.ai](https://www.unlinked.ai). Lets any MCP-aware client (Claude Desktop, Claude Code, Cursor, Cline, Codex CLI, …) search your network, look up profiles, draft intros, and list your LinkedIn imports.

**Scoped by design:** every tool call is resolved to your own account server-side. An agent key can only see your own profile and your direct connections -- never anyone else's network.

## 30-second setup

1. Sign in to unlinked.ai -> **Settings -> Agent keys -> create key**
2. Copy the key (starts with `ul_`)
3. Paste one of the snippets below into your MCP client's config

## Claude Code

```bash
claude mcp add unlinked \
  --env UNLINKED_API_KEY=ul_your_key_here \
  -- npx -y github:IdeaFlowCo/unlinked.ai --prefix mcp-server
```

Or, after cloning locally (see below), point directly at the built server:

```bash
claude mcp add unlinked \
  --env UNLINKED_API_KEY=ul_your_key_here \
  -- node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js
```

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

Restart Claude Desktop. You'll see the unlinked tools appear in the tools menu.

## Local clone (for development)

```bash
git clone https://github.com/IdeaFlowCo/unlinked.ai
cd unlinked.ai/mcp-server
npm install && npm run build
UNLINKED_API_KEY=ul_... npm start
```

## Authentication

Set the API key one of two ways (checked in this order):

1. `UNLINKED_API_KEY` environment variable
2. `~/.unlinked/credentials.json`:
   ```json
   { "apiKey": "ul_your_key_here", "baseUrl": "https://www.unlinked.ai" }
   ```

The server will fail tool calls with a clear error message if neither is set.

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
- Revoke a key any time from **Settings -> Agent keys**.
