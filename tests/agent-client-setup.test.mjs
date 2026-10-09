import test from 'node:test'
import assert from 'node:assert/strict'
import { agentClientSetups, claudeDesktopConfiguration, scopedSetupConfiguration, MCP_REMOTE_PACKAGE, CLAUDE_DESKTOP_AUTH_ENV } from '../src/utils/private-import/scoped-setup.mjs'
import { renderSettings, renderAgents } from '../mcp-server/private-onboarding-views.mjs'

const endpoint = 'https://www.unlinked.ai/mcp', accessToken = 'synthetic.grant-token_value~1'
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const field = (content, id) => { const match = content.match(new RegExp(`<textarea id="${id}"[^>]*>([\\s\\S]*?)</textarea>`)); return match ? decode(match[1]) : decode(content.match(new RegExp(`<input id="${id}"[^>]*value="([^"]*)"`))?.[1] ?? '') }

// Claude Desktop rejects remote entries in claude_desktop_config.json
// ("not valid MCP server configurations and were skipped"): every entry must
// be a local stdio launch with command/args/env and nothing else.
function assertValidClaudeDesktopConfig(config) {
  assert.deepEqual(Object.keys(config), ['mcpServers'])
  const entries = Object.entries(config.mcpServers)
  assert.ok(entries.length > 0)
  for (const [name, entry] of entries) {
    assert.match(name, /^[A-Za-z0-9_-]+$/)
    assert.equal(typeof entry.command, 'string')
    assert.ok(entry.command.length > 0)
    assert.ok(Array.isArray(entry.args) && entry.args.every(arg => typeof arg === 'string'))
    for (const key of Object.keys(entry)) assert.ok(['command', 'args', 'env'].includes(key), `unexpected key ${key}`)
    assert.ok(!('url' in entry) && !('type' in entry) && !('headers' in entry) && !('serverUrl' in entry))
    if (entry.env) for (const value of Object.values(entry.env)) assert.equal(typeof value, 'string')
  }
}

test('Claude Desktop setup is a stdio mcp-remote bridge with the credential in env, never a url entry', () => {
  const config = claudeDesktopConfiguration({ endpoint, accessToken })
  assertValidClaudeDesktopConfig(config)
  const entry = config.mcpServers.unlinked
  assert.equal(entry.command, 'npx')
  assert.deepEqual(entry.args, ['-y', MCP_REMOTE_PACKAGE, endpoint, '--header', `Authorization:\${${CLAUDE_DESKTOP_AUTH_ENV}}`])
  assert.match(MCP_REMOTE_PACKAGE, /^mcp-remote@\d+\.\d+\.\d+$/, 'bridge version is pinned')
  // Claude Desktop on Windows does not escape spaces inside args.
  for (const arg of entry.args) assert.doesNotMatch(arg, /\s/)
  assert.deepEqual(entry.env, { [CLAUDE_DESKTOP_AUTH_ENV]: `Bearer ${accessToken}` })
  assert.ok(!entry.args.some(arg => arg.includes(accessToken)), 'token is not a process argument')
})

test('the old url/headers configuration is exactly what Claude Desktop rejects', () => {
  assert.throws(() => assertValidClaudeDesktopConfig(scopedSetupConfiguration({ endpoint, accessToken })))
})

test('every client setup derives from one validated grant', () => {
  const setups = agentClientSetups({ endpoint, accessToken })
  assert.equal(setups.url, endpoint)
  assert.equal(setups.authorization, `Bearer ${accessToken}`)
  assert.equal(setups.claudeCode, `claude mcp add --transport http unlinked ${endpoint} --header "Authorization: Bearer ${accessToken}"`)
  assert.deepEqual(setups.generic.mcpServers['unlinked-private'], { url: endpoint, headers: { Authorization: `Bearer ${accessToken}` } })
  assertValidClaudeDesktopConfig(setups.claudeDesktop)
  for (const bad of [{ endpoint: 'http://www.unlinked.ai/mcp', accessToken }, { endpoint: `${endpoint}?token=x`, accessToken }, { endpoint, accessToken: 'has space' }, { endpoint, accessToken: 'quote"inject' }])
    assert.throws(() => agentClientSetups(bad), /scoped_https_setup_required/)
  const loopback = claudeDesktopConfiguration({ endpoint: 'http://127.0.0.1:7123/mcp', accessToken, allowLoopbackStaging: true })
  assert.equal(loopback.mcpServers.unlinked.args.at(-1), '--allow-http')
})

test('Settings shows a Claude connector, a valid claude_desktop_config.json entry and every other client', () => {
  const setups = agentClientSetups({ endpoint, accessToken })
  const { content } = renderSettings({ accountLabel: 'a@example.invalid', displayName: 'A', csrf: 'c', agentConfiguration: setups.generic, agentSetups: setups, agentSetupAutomatic: true, grants: [{ id: 'g' }] })
  assert.match(content, /Customize → Connectors/)
  assert.match(content, /No sign in/)
  assert.equal(field(content, 'agent-setup-url'), endpoint)
  assert.equal(field(content, 'agent-setup-claude-header'), `Bearer ${accessToken}`)
  const desktop = JSON.parse(field(content, 'agent-setup-claude-desktop'))
  assertValidClaudeDesktopConfig(desktop)
  assert.deepEqual(desktop, setups.claudeDesktop)
  assert.equal(field(content, 'agent-setup-claude-code'), setups.claudeCode)
  assert.equal(field(content, 'agent-setup-token'), accessToken)
  assert.deepEqual(JSON.parse(field(content, 'onboarding-agent-configuration')), setups.generic)
  // The generic url/headers JSON is labelled for config-file clients, not Claude Desktop.
  assert.match(content, /Not for Claude Desktop’s <code>claude_desktop_config.json<\/code>/)
  for (const id of ['agent-setup-url', 'agent-setup-claude-header', 'agent-setup-claude-desktop', 'agent-setup-claude-code', 'agent-setup-token', 'onboarding-agent-configuration'])
    assert.match(content, new RegExp(`data-copy-target="${id}"`))
  assert.doesNotMatch(content, /<script|onclick=/)
})

test('the public agents page leads with connector sign-in, and the config file only via mcp-remote', () => {
  const { content } = renderAgents({})
  assert.match(content, /Settings → Connectors → Add custom connector<\/b>, paste this address, choose <b>Connect<\/b>, sign in to Unlinked/)
  assert.match(content, /claude mcp add --transport http unlinked https:\/\/www\.unlinked\.ai\/mcp/)
  assert.match(content, /claude_desktop_config.json<\/code> \(via <code>mcp-remote<\/code>\)/)
})

test('with the OAuth connector, Settings puts keys first and retains sign-in instructions and connected apps', () => {
  const setups = agentClientSetups({ endpoint, accessToken })
  const grants = [{ id: 'conn1', issuedAt: 1790000000, scope: 'owner_network_and_public', connection: { app: 'Claude', clientName: 'Claude', redirectHost: 'claude.ai' } }, { id: 'manual1', issuedAt: 1780000000 }]
  const { content } = renderSettings({ accountLabel: 'a@example.invalid', displayName: 'A', csrf: 'c', agentConfiguration: setups.generic, agentSetups: setups, agentSetupAutomatic: true, grants, connector: { url: endpoint } })
  const connectorStart = content.indexOf('<section aria-label="Connect with sign-in">')
  const connectorPart = content.slice(connectorStart, content.indexOf('</section>', connectorStart))
  assert.ok(content.indexOf('<section id="api-keys">') < connectorStart)
  assert.match(connectorPart, /paste this address, then sign in/)
  assert.equal(field(content, 'agent-connector-url'), endpoint)
  assert.equal(field(content, 'agent-connector-claude-code'), `claude mcp add --transport http unlinked ${endpoint}`)
  assert.match(connectorPart, /Add custom connector/)
  assert.match(connectorPart, /Developer mode/)
  assert.equal(connectorPart.includes(accessToken), false, 'the connector path never shows a credential')
  assert.match(connectorPart, /<b>Claude<\/b> · connected 2026-09-21 · your network and People<\/p><button class="quiet">Disconnect<\/button>/)
  assert.match(connectorPart, /name="grantId" value="conn1"/)
  assert.equal(connectorPart.includes('value="manual1"'), false)
  // The key-based controls and advanced formats now appear first.
  const manualPart = content.slice(content.indexOf('<section id="api-keys">'), connectorStart)
  assert.match(manualPart, /custom connector with a request header instead of signing in/)
  assert.equal(field(content, 'agent-setup-claude-header'), `Bearer ${accessToken}`)
  assert.match(manualPart, /key=manual1/)
  assert.match(manualPart, /Copy API key/)
})
