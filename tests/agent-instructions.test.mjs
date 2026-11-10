// Agent setup instructions a member pastes into an agent's chat (unlinked-40dg):
// complete on their own, with no key, so the agent never needs the web page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { agentInstructionsText, renderAgents, renderSettings, UNLINKED_MCP_URL } from '../mcp-server/private-onboarding-views.mjs'

const owner = { ownerId: 'liberate-owner', userId: 'liberate-user' }

async function site(t) {
  let handler, ownerReads = 0
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'verified-subject', verifiedEmail: 'robin@example.invalid', displayName: 'Robin Fictional' }),
  }, resolveOwner: async identity => identity.subject === 'verified-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async () => { ownerReads++; return backend } })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async () => {
    const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { request, signIn, ownerReads: () => ownerReads }
}

test('the copied instructions stand alone: URL, per-client steps, first calls, and no secret or "read the page"', () => {
  const text = agentInstructionsText()
  assert.match(text, /you do not need to open any web page/)
  assert.ok(text.includes(`Unlinked MCP server URL: ${UNLINKED_MCP_URL}`))
  assert.match(text, /Claude \(claude\.ai, Claude Desktop or mobile\): you cannot add a connector from inside a chat/)
  assert.ok(text.includes(`claude mcp add --transport http unlinked ${UNLINKED_MCP_URL}`))
  assert.match(text, /ChatGPT: open https:\/\/chatgpt.com\/plugins/)
  assert.match(text, /Cursor or another client with an MCP config file/)
  assert.match(text, /whoami/)
  assert.match(text, /never ask me for my password/)
  assert.doesNotMatch(text, /Bearer|test-grant|token=|\/agents|see the page|visit|https:\/\/www\.unlinked\.ai\/(?!mcp)/)
  assert.doesNotMatch(text, /<|&amp;/, 'plain text, not HTML')
  assert.ok(agentInstructionsText('https://staging.example/mcp').includes('https://staging.example/mcp'))
})

test('/agents leads with the copyable instructions and wires the copy button under the page nonce', async t => {
  const app = await site(t)
  const response = await app.request('/agents')
  assert.equal(response.status, 200)
  const page = await response.text(), csp = response.headers.get('content-security-policy')
  assert.ok(page.indexOf('Paste this into your agent') < page.indexOf('Set up your agent'))
  assert.match(page, /<textarea id="agent-instructions" readonly rows="12"/)
  assert.match(page, /data-copy-target="agent-instructions"/)
  const nonce = csp.match(/'nonce-([^']+)'/)[1]
  assert.ok(page.includes(`<script nonce="${nonce}">for(const button of document.querySelectorAll('[data-copy-target]')`))
  // The rendered text decodes back to exactly the instructions.
  const field = page.match(/<textarea id="agent-instructions"[^>]*>([\s\S]*?)<\/textarea>/)[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  assert.equal(field, agentInstructionsText())
  assert.equal(renderAgents().content.match(/id="agent-instructions-help"/g).length, 1, 'one status line')
})

test('Settings shows the same keyless instructions above API keys', () => {
  const view = renderSettings({ accountLabel: 'Robin', displayName: 'Robin', csrf: 'x', agentConfiguration: { mcpServers: { 'unlinked-private': { url: UNLINKED_MCP_URL, headers: { Authorization: 'Bearer secret-token-value' } } } } }).content
  const section = view.match(/<section aria-label="Instructions for your agent">([\s\S]*?)<\/section>/)[1]
  assert.match(section, /settings-agent-instructions/)
  assert.doesNotMatch(section, /secret-token-value|Bearer/)
  assert.ok(view.indexOf('Instructions for your agent') < view.indexOf('id="api-keys"'))
})
