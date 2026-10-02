// Structured download for one approved scoped grant. No credential in the URL.
// Real provider consent/registration and production setup remain explicit gates.
function validated({ endpoint, accessToken, allowLoopbackStaging = false }) {
  const url = new URL(endpoint)
  if ((url.protocol !== 'https:' && !(allowLoopbackStaging && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash || typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(accessToken)) throw new Error('scoped_https_setup_required')
  return url.toString()
}

// Streamable HTTP + bearer header shape (Cursor, Windsurf-style mcp.json and
// other clients that accept remote servers in their config file). Claude
// Desktop's claude_desktop_config.json does NOT accept this shape: it only
// launches local stdio servers and skips url/headers entries as invalid.
export function scopedSetupConfiguration({ endpoint, accessToken, allowLoopbackStaging = false }) {
  const url = validated({ endpoint, accessToken, allowLoopbackStaging })
  return { mcpServers: { 'unlinked-private': { url, headers: { Authorization: `Bearer ${accessToken}` } } } }
}

// mcp-remote bridges a local stdio client to a remote Streamable HTTP server.
// Pinned to the last release by its original maintainers (published
// 2026-02-05); later releases moved to a new maintainer in 2026-08.
export const MCP_REMOTE_PACKAGE = 'mcp-remote@0.1.38'
export const CLAUDE_DESKTOP_AUTH_ENV = 'UNLINKED_AUTH_HEADER'

// claude_desktop_config.json entry: a stdio command, never url/type/headers.
// The bearer value travels in env, not args: Claude Desktop on Windows does
// not escape spaces inside args, so the header arg itself has no spaces.
export function claudeDesktopConfiguration({ endpoint, accessToken, allowLoopbackStaging = false }) {
  const url = validated({ endpoint, accessToken, allowLoopbackStaging })
  const args = ['-y', MCP_REMOTE_PACKAGE, url, '--header', `Authorization:\${${CLAUDE_DESKTOP_AUTH_ENV}}`]
  if (url.startsWith('http:')) args.push('--allow-http')
  return { mcpServers: { unlinked: { command: 'npx', args, env: { [CLAUDE_DESKTOP_AUTH_ENV]: `Bearer ${accessToken}` } } } }
}

// Every client's setup from one grant. The token charset is [A-Za-z0-9._~-],
// so it is safe inside the double-quoted shell argument below.
export function agentClientSetups({ endpoint, accessToken, allowLoopbackStaging = false }) {
  const url = validated({ endpoint, accessToken, allowLoopbackStaging })
  return {
    url,
    authorization: `Bearer ${accessToken}`,
    accessToken,
    claudeDesktop: claudeDesktopConfiguration({ endpoint, accessToken, allowLoopbackStaging }),
    claudeCode: `claude mcp add --transport http unlinked ${url} --header "Authorization: Bearer ${accessToken}"`,
    generic: scopedSetupConfiguration({ endpoint, accessToken, allowLoopbackStaging }),
  }
}
