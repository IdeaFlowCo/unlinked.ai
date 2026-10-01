import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'
export { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'

// Staging-only factory, never mounted by the production Next app. authenticateGrant
// must verify a distinct tool audience + trusted grant record + live revocation.
// Operational access tokens, raw archives and assertion IDs are never exposed.
export function createPrivateHostedHandler({ authenticateGrant, readResource, readAsset, complete, allowedHosts, allowedOrigins = [] }) {
  if (typeof authenticateGrant !== 'function' || typeof readResource !== 'function' || !Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error('explicit_private_host_configuration_required')
  const hosts = new Set(allowedHosts), origins = new Set(allowedOrigins)
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return }
    let grant
    try { grant = await authenticateGrant(req) } catch { res.writeHead(503).end(); return }
    const availableTools = ['unlinked_read_import', ...(typeof complete === 'function' ? ['unlinked_search_import'] : [])]
    if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || typeof grant.ownerId !== 'string' || !Array.isArray(grant.importIds) || grant.importIds.length > 32 || grant.importIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || !Array.isArray(grant.tools) || !grant.tools.length || grant.tools.some(tool => !availableTools.includes(tool))) { res.writeHead(401).end(); return }
    const snapshot = { ownerId: grant.ownerId, importIds: [...grant.importIds] }
    const readImport = createScopedImportReader({ grant: snapshot, readResource: (type, id) => readResource(grant, type, id), ...(readAsset ? { readAsset: sha256 => readAsset(grant, sha256) } : {}) })
    const server = new McpServer({ name: 'unlinked-private-staging', version: '0.1.0' })
    const search = typeof complete === 'function' ? createPrivateSearch({ readImport, complete }) : null
    const invoke = (tool, work) => async input => {
      const { importId } = input
      try {
        // Revalidate even during a delayed tool call; revocation never depends on an MCP session cache.
        const current = await authenticateGrant(req)
        if (!current || current.expiresAt <= Date.now() || current.ownerId !== snapshot.ownerId ||
            !current.importIds.includes(importId) || !current.tools.includes(tool)) throw new Error('private_import_not_found')
        const result = await work(input)
        const finalGrant = await authenticateGrant(req)
        if (!finalGrant || finalGrant.expiresAt <= Date.now() || finalGrant.ownerId !== snapshot.ownerId ||
            !finalGrant.importIds.includes(importId) || !finalGrant.tools.includes(tool)) throw new Error('private_import_not_found')
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('private_tool_result_limit')
        return { content: [{ type: 'text', text }] }
      } catch { return { isError: true, content: [{ type: 'text', text: 'Private import unavailable or access revoked.' }] } }
    }
    if (grant.tools.includes('unlinked_read_import')) server.registerTool('unlinked_read_import', {
      description: 'Read observed assertions from one explicitly granted private LinkedIn archive.',
      inputSchema: { importId: z.string().regex(/^[a-f0-9]{64}$/) },
    }, invoke('unlinked_read_import', ({ importId }) => readImport(importId)))
    if (grant.tools.includes('unlinked_search_import') && search) server.registerTool('unlinked_search_import', {
      description: 'Search connection observations in one explicitly granted private LinkedIn archive using query-time AI. Results include source provenance; no shared index.',
      inputSchema: { importId: z.string().regex(/^[a-f0-9]{64}$/), query: z.string().min(1).max(1024) },
    }, invoke('unlinked_search_import', search))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}

// An authenticated owner can download one scoped configuration in one action.
// issueGrant is a trusted staging issuer, not a claim that the production
// Ideaflow provider supports granular delegation. No anonymous/link-token setup.
export function createScopedSetupHandler({ authenticateOwner, issueGrant, readResource, endpoint, allowedHosts, allowedOrigins = [], allowLoopbackStaging = false, tools = ['unlinked_read_import'] }) {
  if (![authenticateOwner, issueGrant, readResource].every(fn => typeof fn === 'function') || !Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error('explicit_scoped_setup_configuration_required')
  if (!Array.isArray(tools) || !tools.length || tools.some(tool => !['unlinked_read_import', 'unlinked_search_import'].includes(tool))) throw new Error('explicit_scoped_setup_tools_required')
  const grantedTools = [...tools]
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
      const accessToken = await issueGrant(owner, { importIds: [input.importId], tools: grantedTools })
      const config = scopedSetupConfiguration({ endpoint, accessToken, allowLoopbackStaging })
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', 'attachment; filename="unlinked-private-mcp.json"')
      res.end(JSON.stringify(config))
    } catch { if (!res.headersSent) res.writeHead(503).end() }
  }
}
