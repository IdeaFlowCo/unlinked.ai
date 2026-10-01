import { createServer } from 'node:http'
import { generateKeyPair } from 'jose'
import { createPrivateBrowserHandler } from './private-browser.mjs'
import { createPrivateHostedHandler } from './private-hosted.mjs'
import { createPrivateGrantService } from './private-grants.mjs'

// Explicitly invoked isolated runtime. Never imported by the production app.
// getBackend must revalidate the immutable ownerId/userId binding for every
// invocation; no operational credential or provider token is sent to clients.
export async function startPrivatePilot({ baseUrl, login, resolveOwner, claimInvitation, getBackend, complete, port, host = '127.0.0.1', dataMode = 'synthetic' }) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !Number.isSafeInteger(port) || port < 7000 || port > 9999 || host !== '127.0.0.1' || typeof complete !== 'function') throw new Error('explicit_isolated_pilot_configuration_required')
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 })
  const grants = createPrivateGrantService({ issuer: base.origin, ...keys, getBackend })
  const browser = createPrivateBrowserHandler({ baseUrl, login, resolveOwner, claimInvitation, getBackend, complete, issueGrant: grants.issueGrant, mcpEndpoint: new URL('/mcp', base).href, dataMode })
  const mcp = createPrivateHostedHandler({ authenticateGrant: grants.authenticateGrant, complete, allowedHosts: [base.host], allowedOrigins: [base.origin],
    readResource: async (grant, type, id) => (await getBackend(grant)).readResource(type, id),
    readAsset: async (grant, sha256) => (await getBackend(grant)).readAsset(sha256),
  })
  const server = createServer((request, response) => {
    void (new URL(request.url, base).pathname === '/mcp' ? mcp(request, response) : browser(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(503).end()
      else response.end()
    })
  })
  server.requestTimeout = 120000
  server.headersTimeout = 15000
  server.maxHeadersCount = 32
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  return { server, revokeGrant: grants.revoke, stop: () => new Promise(resolve => server.close(resolve)) }
}
