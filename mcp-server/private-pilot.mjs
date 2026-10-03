import { createServer } from 'node:http'
import { hkdfSync } from 'node:crypto'
import { generateKeyPair } from 'jose'
import { createPrivateBrowserHandler } from './private-browser.mjs'
import { createPrivateHostedHandler } from './private-hosted.mjs'
import { createPrivateGrantService } from './private-grants.mjs'
import { createAccountGrantService } from './account-grants.mjs'
import { createAccountHostedHandler } from './account-hosted.mjs'
import { createAccountAgentApiHandler } from './account-api.mjs'
import { createAccountToolService } from './account-tools.mjs'
import { createOAuthServer } from './oauth-server.mjs'

// Explicitly invoked isolated runtime. Never imported by the production app.
// getBackend must revalidate the immutable ownerId/userId binding for every
// invocation; no operational credential or provider token is sent to clients.
export async function startPrivatePilot({ baseUrl, login, resolveOwner, claimInvitation, signup, memberInvitations, memberConnections, notifications, contactCards, sessionStore, memberEmail, lookupCompanyFacts, accountForProfile, ownProfileId, notifyProfileClaimed, legacyAccount, selfClaims, signupLookup, accountGrantKey, getBackend, complete, readPublishedSnapshot, revokeLegacyLink, removeOwnerAssets, provisionAgentClients = [], backgroundImports = false, audit, port, host = '127.0.0.1', networkMode = 'loopback', dataMode = 'synthetic', profilePhotos }) {
  const base = new URL(baseUrl)
  const privateHost = networkMode === 'loopback' ? host === '127.0.0.1' : networkMode === 'isolated-container' && host === '0.0.0.0' && ['https://private.unlinked.ai', 'https://www.unlinked.ai'].includes(base.origin) && port === 9367
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !Number.isSafeInteger(port) || port < 7000 || port > 9999 || !privateHost || typeof complete !== 'function') throw new Error('explicit_isolated_pilot_configuration_required')
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 })
  if (signup !== undefined && (typeof signup !== 'function' || !(accountGrantKey instanceof Uint8Array) || accountGrantKey.length < 32)) throw new Error('account_signup_configuration_required')
  const grants = createPrivateGrantService({ issuer: base.origin, ...keys, getBackend })
  const accountGrants = signup ? createAccountGrantService({ issuer: base.origin, signingKey: accountGrantKey, getBackend, publicSearchEnabled: typeof readPublishedSnapshot === 'function' }) : null
  // OAuth connector sign-in for /mcp (docs/agent-api.md, "OAuth connector"):
  // on whenever account grants are, since its tokens are account grants. The
  // client-registration MAC key is derived from, and separate from, the grant key.
  const oauth = accountGrants ? createOAuthServer({ origin: base.origin, resourcePath: '/mcp', publicSearchEnabled: typeof readPublishedSnapshot === 'function',
    clientKey: new Uint8Array(hkdfSync('sha256', accountGrantKey, 'unlinked-oauth', 'client-registration-v1', 32)),
    issueGrant: accountGrants.issueGrant, revokeConnectionToken: accountGrants.revokeConnectionToken, audit }) : null
  const browser = createPrivateBrowserHandler({ baseUrl, login, resolveOwner, claimInvitation, signup, memberInvitations, memberConnections, notifications, contactCards, sessionStore, memberEmail, accountForProfile, ownProfileId, notifyProfileClaimed, legacyAccount, selfClaims, signupLookup, getBackend, complete, readPublishedSnapshot,
    issueAccountGrant: accountGrants?.issueGrant, ensureAccountGrant: accountGrants?.ensureGrant, revokeAccountGrant: accountGrants?.revoke, revokeLegacyLink, removeOwnerAssets,
    issueGrant: grants.issueGrant, mcpEndpoint: new URL('/mcp', base).href, dataMode, backgroundImports, audit,
    oauth: oauth ?? undefined, listAccountGrants: accountGrants?.listGrants, ...(lookupCompanyFacts ? { lookupCompanyFacts } : {}), profilePhotos })
  // One tool service instance backs both agent surfaces, so the MCP tools and
  // the HTTP agent API (docs/agent-api.md) share semantics and rate budgets.
  const toolService = accountGrants ? createAccountToolService({ getBackend, complete, readPublishedSnapshot, memberConnections, notifications, accountForProfile, ownProfileId, memberInvitations }) : null
  const mcp = accountGrants ? createAccountHostedHandler({ authenticateGrant: accountGrants.authenticateGrant, getBackend, complete, readPublishedSnapshot, origin: base.origin, service: toolService, challenge: oauth?.challenge }) : createPrivateHostedHandler({ authenticateGrant: grants.authenticateGrant, complete, allowedHosts: [base.host], allowedOrigins: [base.origin],
    readResource: async (grant, type, id) => (await getBackend(grant)).readResource(type, id),
    readAsset: async (grant, sha256) => (await getBackend(grant)).readAsset(sha256),
  })
  if (!Array.isArray(provisionAgentClients) || provisionAgentClients.length > 16) throw new Error('account_agent_provisioning_configuration_required')
  // A configured allow list on a runtime without account grants is operator
  // error; refuse loudly at startup instead of silently answering 404.
  if (provisionAgentClients.length && !accountGrants) throw new Error('account_agent_provisioning_configuration_required')
  // Server-to-server grant provisioning stays off unless the operator supplied
  // a non-empty allow list (see docs/agent-api.md, "Grant provisioning").
  const provisioning = accountGrants && provisionAgentClients.length ? { clients: provisionAgentClients, resolveOwner, ensureGrant: accountGrants.ensureGrant, audit } : undefined
  const agentApi = accountGrants ? createAccountAgentApiHandler({ authenticateGrantDetailed: accountGrants.authenticateGrantDetailed, authenticateGrant: accountGrants.authenticateGrant, service: toolService, origin: base.origin, provisioning }) : null
  const server = createServer((request, response) => {
    let pathname
    try { pathname = new URL(request.url, base).pathname } catch { response.writeHead(400).end(); return }
    void (pathname === '/mcp' ? mcp(request, response) : oauth?.isEndpoint(pathname) ? oauth.handle(request, response) : agentApi && (pathname === '/api/agent' || pathname.startsWith('/api/agent/')) ? agentApi(request, response) : browser(request, response)).catch(() => {
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
