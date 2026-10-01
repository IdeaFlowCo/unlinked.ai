# unlinked.ai — for agents

Private archive import, scoped hosted setup and AI search remain unavailable in the deployed product. No live invitation URL is advertised. See https://github.com/IdeaFlowCo/unlinked.ai/blob/main/docs/private-noos-staging.md for the default-off staging contract, consent and release gates; synthetic receipts do not verify this legacy backend.

This is the agent-facing brief served at `/AGENTS.md` for autonomous agents arriving at unlinked.ai over HTTP. For agents and developers working inside this repository, see `AGENTS.md` at the repo root.

## What this is

See the repository [README](https://github.com/IdeaFlowCo/unlinked.ai/blob/main/README.md) for current product behavior and availability. The API and MCP instructions below describe the legacy backend surface; they do not expose the new [private archive parser/job foundation](https://github.com/IdeaFlowCo/unlinked.ai/blob/main/docs/private-archive-import.md).

Any MCP-aware client (Claude Desktop, Claude Code, Cursor, Cline, Codex CLI) or HTTP agent can interact with unlinked.ai programmatically using an agent key.

## Scoping Guarantee

Every agent API request is authenticated server-side to the user owning the agent key.

- **Strict isolation:** An agent key can only access the caller's own profile and their direct connections. It can never view, search, or infer the network of any other user.
- **Server-side resolution:** No request parameter ever specifies whose network is searched. The target network is resolved server-side from the authenticated key.
- **Privacy by 404:** Requesting an unrelated profile ID via `/api/profiles/[id]` returns `404 Not Found` (identical to a nonexistent profile), never confirming whether an unrelated profile exists.
- **Read-only intro drafting:** Drafting an intro via `/api/draft-intro` generates a candidate message in memory and writes nothing to the database.

## Authentication

1. **Minting a Key:** Sign in to unlinked.ai and navigate to **Settings -> Agent keys** (`https://www.unlinked.ai/settings/agent-keys`).
2. **Format:** Agent keys start with the prefix `ul_` followed by base64url-encoded random bytes (e.g. `ul_...`).
3. **Storage:** The plaintext key is shown exactly once upon creation. Server-side, only a SHA-256 hash is stored.
4. **Usage:** Provide the key in the HTTP `Authorization` header:
   ```http
   Authorization: Bearer ul_your_key_here
   ```
5. **Revocation:** Keys can be revoked at any time from **Settings -> Agent keys**. Key management endpoints require an interactive browser session; agent keys cannot mint or revoke other agent keys.

## Quick Start: MCP Server

unlinked.ai provides a Model Context Protocol server under `@unlinked/mcp-server` that connects any MCP-aware client to your network. It is not published to npm; run it from a local build.

### Build the server

```bash
git clone https://github.com/IdeaFlowCo/unlinked.ai
cd unlinked.ai/mcp-server
npm install && npm run build
```

In the snippets below, replace `/absolute/path/to/unlinked.ai` with the absolute path of your clone.

### Claude Code

```bash
claude mcp add unlinked \
  --env UNLINKED_API_KEY=ul_your_key_here \
  -- node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Manual Start

```bash
UNLINKED_API_KEY=ul_your_key_here node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js
```

### Credentials File Fallback

If `UNLINKED_API_KEY` is not set in the environment, the MCP server checks `~/.unlinked/credentials.json`:

```json
{
  "apiKey": "ul_your_key_here",
  "baseUrl": "https://www.unlinked.ai"
}
```

## MCP Tools Reference

| Tool | Parameters | Description |
|---|---|---|
| `unlinked_me` | None | Returns the caller's profile and count of connections and uploads. |
| `unlinked_search_contacts` | `query` (string, required), `limit` (integer 1-25, default 10) | Semantic search restricted to the caller's direct connections with similarity score and explanation. |
| `unlinked_get_profile` | `profileId` (string UUID, required) | Read a profile. Returns caller's own profile or a direct connection's profile; unrelated profiles return not-found. |
| `unlinked_list_imports` | None | List LinkedIn archive uploads and count of ingested graph records. |
| `unlinked_draft_intro` | `contactProfileId` (string UUID, required), `context` (string, max 2000 chars, optional) | Draft a short, forwardable intro to a direct connection (read-only). |

## HTTP REST API Reference

Base URL: `https://www.unlinked.ai`

### 1. Get My Profile
`GET /api/me`

```bash
curl -s -H "Authorization: Bearer ul_your_key_here" \
  https://www.unlinked.ai/api/me
```

Response:
```json
{
  "profile": {
    "id": "e4b2d3c1-...",
    "full_name": "Jane Doe",
    "headline": "Software Engineer",
    "industry": "Computer Software",
    "positions": [...],
    "education": [...],
    "skills": [...]
  },
  "counts": {
    "connections": 412,
    "uploads": 1
  },
  "auth": {
    "via": "agent-key"
  }
}
```

### 2. Search Direct Contacts
`POST /api/search-contacts`

```bash
curl -s -X POST https://www.unlinked.ai/api/search-contacts \
  -H "Authorization: Bearer ul_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"query": "distributed systems engineers in San Francisco", "limit": 5}'
```

Response:
```json
{
  "results": [
    {
      "profile": {
        "id": "a1b2c3d4-...",
        "full_name": "Alex Smith",
        "headline": "Staff Distributed Systems Engineer",
        "industry": "Internet"
      },
      "score": 0.842,
      "reason": "Staff engineer leading distributed storage infrastructure."
    }
  ]
}
```

### 3. Read Profile
`GET /api/profiles/{id}`

Only accessible for your own profile or direct connections. Unrelated profile IDs return 404.

```bash
curl -s -H "Authorization: Bearer ul_your_key_here" \
  https://www.unlinked.ai/api/profiles/a1b2c3d4-...
```

Response:
```json
{
  "profile": {
    "id": "a1b2c3d4-...",
    "full_name": "Alex Smith",
    "headline": "Staff Distributed Systems Engineer",
    "summary": "...",
    "industry": "Internet",
    "positions": [...],
    "education": [...],
    "skills": [...]
  },
  "relationship": "direct-connection"
}
```

### 4. Draft Intro
`POST /api/draft-intro`

Read-only: Generates an intro draft without modifying any data.

```bash
curl -s -X POST https://www.unlinked.ai/api/draft-intro \
  -H "Authorization: Bearer ul_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"contactProfileId": "a1b2c3d4-...", "context": "Discussing low-latency databases"}'
```

Response:
```json
{
  "draft": "Alex, hope you're doing well! I'm reaching out because...",
  "contact": {
    "id": "a1b2c3d4-...",
    "full_name": "Alex Smith",
    "headline": "Staff Distributed Systems Engineer"
  }
}
```

### 5. List Archive Imports
`GET /api/imports`

```bash
curl -s -H "Authorization: Bearer ul_your_key_here" \
  https://www.unlinked.ai/api/imports
```

Response:
```json
{
  "uploads": [
    {
      "id": "f5e4d3c2-...",
      "file_name": "Basic_LinkedInDataExport_12-25-2024.zip",
      "file_path": "uploads/.../archive.zip",
      "created_at": "2024-12-27T06:15:00.000Z"
    }
  ],
  "ingested": {
    "connections": 412,
    "positions": 8,
    "education": 2,
    "skills": 35
  },
  "note": "ingested counts are account-wide; the schema records no per-upload provenance"
}
```

## Service Availability

unlinked.ai's agent interface contracts and schemas are versioned and documented here. The backend database and embedding services run on hosted infrastructure; API responses depend on current backend deployment status.
