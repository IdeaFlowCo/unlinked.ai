import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'
export { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'

// Staging-only factory, never mounted by the production Next app. authenticateGrant
// must verify a distinct tool audience + trusted grant record + live revocation.
// Operational access tokens, raw archives and assertion IDs are never exposed.
export function createPrivateHostedHandler({ authenticateGrant, readResource, allowedHosts, allowedOrigins = [] }) {
  if (typeof authenticateGrant !== 'function' || typeof readResource !== 'function' || !Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error('explicit_private_host_configuration_required')
  const hosts = new Set(allowedHosts), origins = new Set(allowedOrigins)
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return }
    let grant
    try { grant = await authenticateGrant(req) } catch { res.writeHead(503).end(); return }
    if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || typeof grant.ownerId !== 'string' || !Array.isArray(grant.importIds) || grant.importIds.length > 32 || grant.importIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || !Array.isArray(grant.tools) || !grant.tools.includes('unlinked_read_import')) { res.writeHead(401).end(); return }
    const snapshot = { ownerId: grant.ownerId, importIds: [...grant.importIds] }
    const readImport = createScopedImportReader({ grant: snapshot, readResource: (type, id) => readResource(grant, type, id) })
    const server = new McpServer({ name: 'unlinked-private-staging', version: '0.1.0' })
    server.registerTool('unlinked_read_import', { description: 'Read observed assertions from one explicitly granted private LinkedIn archive. AI search is unavailable.',
      inputSchema: { importId: z.string().regex(/^[a-f0-9]{64}$/) } }, async ({ importId }) => {
      try {
        // Revalidate even during a delayed tool call; revocation never depends on an MCP session cache.
        const current = await authenticateGrant(req)
        if (!current || current.expiresAt <= Date.now() || current.ownerId !== snapshot.ownerId ||
            !current.importIds.includes(importId) || !current.tools.includes('unlinked_read_import')) throw new Error('private_import_not_found')
        const result = await readImport(importId)
        const finalGrant = await authenticateGrant(req)
        if (!finalGrant || finalGrant.expiresAt <= Date.now() || finalGrant.ownerId !== snapshot.ownerId ||
            !finalGrant.importIds.includes(importId) || !finalGrant.tools.includes('unlinked_read_import')) throw new Error('private_import_not_found')
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('private_tool_result_limit')
        return { content: [{ type: 'text', text }] }
      } catch { return { isError: true, content: [{ type: 'text', text: 'Private import unavailable or access revoked.' }] } }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}

// An authenticated owner can download one scoped configuration in one action.
// issueGrant is a trusted staging issuer, not a claim that the production
// Ideaflow provider supports granular delegation. No anonymous/link-token setup.
export function createScopedSetupHandler({ authenticateOwner, issueGrant, readResource, endpoint, allowedHosts, allowedOrigins = [], allowLoopbackStaging = false }) {
  if (![authenticateOwner, issueGrant, readResource].every(fn => typeof fn === 'function') || !Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error('explicit_scoped_setup_configuration_required')
  const hosts = new Set(allowedHosts), origins = new Set(allowedOrigins)
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return }
    try {
      const owner = await authenticateOwner(req)
      if (!owner || typeof owner.ownerId !== 'string') { res.writeHead(401).end(); return }
      let size = 0, body = ''
      for await (const bytes of req) {
        size += bytes.length
        if (size > 2048) { res.writeHead(413).end(); return }
        body += bytes.toString('utf8')
      }
      let input
      try { input = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      if (!input || Object.keys(input).length !== 1 || !/^[a-f0-9]{64}$/.test(input.importId)) { res.writeHead(400).end(); return }
      const publication = await readResource(owner, 'import', input.importId)
      if (!publication || publication.deleted || publication.sourceOwnerId !== owner.ownerId || !['partial', 'indexed'].includes(publication.payload?.status)) { res.writeHead(404).end(); return }
      const accessToken = await issueGrant(owner, { importIds: [input.importId], tools: ['unlinked_read_import'] })
      const config = scopedSetupConfiguration({ endpoint, accessToken, allowLoopbackStaging })
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', 'attachment; filename="unlinked-private-mcp.json"')
      res.end(JSON.stringify(config))
    } catch { if (!res.headersSent) res.writeHead(503).end() }
  }
}
