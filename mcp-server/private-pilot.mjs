import { createServer } from 'node:http'
import { generateKeyPair } from 'jose'
import { createPrivateBrowserHandler } from './private-browser.mjs'
import { createPrivateHostedHandler } from './private-hosted.mjs'
import { createPrivateGrantService } from './private-grants.mjs'
import { createAccountGrantService } from './account-grants.mjs'
import { createAccountHostedHandler } from './account-hosted.mjs'

// Explicitly invoked isolated runtime. Never imported by the production app.
// getBackend must revalidate the immutable ownerId/userId binding for every
// invocation; no operational credential or provider token is sent to clients.
export async function startPrivatePilot({ baseUrl, login, resolveOwner, claimInvitation, signup, accountGrantKey, getBackend, complete, port, host = '127.0.0.1', networkMode = 'loopback', dataMode = 'synthetic' }) {
  const base = new URL(baseUrl)
  const privateHost = networkMode === 'loopback' ? host === '127.0.0.1' : networkMode === 'isolated-container' && host === '0.0.0.0' && base.origin === 'https://private.unlinked.ai' && port === 9367
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !Number.isSafeInteger(port) || port < 7000 || port > 9999 || !privateHost || typeof complete !== 'function') throw new Error('explicit_isolated_pilot_configuration_required')
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 })
  if (signup !== undefined && (typeof signup !== 'function' || !(accountGrantKey instanceof Uint8Array) || accountGrantKey.length < 32)) throw new Error('account_signup_configuration_required')
  const grants = createPrivateGrantService({ issuer: base.origin, ...keys, getBackend })
  const accountGrants = signup ? createAccountGrantService({ issuer: base.origin, signingKey: accountGrantKey, getBackend }) : null
  const browser = createPrivateBrowserHandler({ baseUrl, login, resolveOwner, claimInvitation, signup, getBackend, complete,
    issueAccountGrant: accountGrants?.issueGrant, revokeAccountGrant: accountGrants?.revoke,
    issueGrant: grants.issueGrant, mcpEndpoint: new URL('/mcp', base).href, dataMode })
  const mcp = accountGrants ? createAccountHostedHandler({ authenticateGrant: accountGrants.authenticateGrant, getBackend, complete, origin: base.origin }) : createPrivateHostedHandler({ authenticateGrant: grants.authenticateGrant, complete, allowedHosts: [base.host], allowedOrigins: [base.origin],
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
  return { server, revokeGrant: accountGrants?.revoke ?? grants.revoke, stop: () => new Promise(resolve => server.close(resolve)) }
}
