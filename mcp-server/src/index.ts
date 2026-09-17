#!/usr/bin/env node
/**
 * unlinked.ai MCP Server -- stdio entrypoint.
 *
 * Transport: stdio (the universal MCP transport for Claude Desktop / Claude Code).
 *
 * Env vars:
 *   UNLINKED_API_KEY    Bearer token, starts `ul_` (mint one at /settings/agent-keys)
 *   UNLINKED_BASE_URL   default https://www.unlinked.ai
 *
 * Credentials file (fallback if env vars are unset):
 *   ~/.unlinked/credentials.json  — { "apiKey": "ul_…", "baseUrl": "https://…" }
 *
 * Note: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getConfig } from "./api.js";
import { buildServer, VERSION } from "./server.js";

async function main() {
  const config = getConfig();
  console.error(
    `[unlinked-mcp] v${VERSION} -> ${config.baseUrl} ${
      config.apiKey ? "(authenticated)" : "(no api key -- most tools will fail)"
    }`
  );

  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[unlinked-mcp] listening on stdio");
}

main().catch((e) => {
  console.error("[unlinked-mcp] fatal:", e);
  process.exit(1);
});
