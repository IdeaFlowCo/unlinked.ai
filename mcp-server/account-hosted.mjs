import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'

export function createAccountHostedHandler({ authenticateGrant, getBackend, complete, origin }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || ![authenticateGrant, getBackend, complete].every(x => typeof x === 'function')) throw new Error('account_host_configuration_required')
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.host !== base.host || request.headers.origin && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    const grant = await authenticateGrant(request)
    if (!grant || grant.scope !== 'owner_network' || grant.tools?.length !== 1 || grant.tools[0] !== 'unlinked_search_network') { response.writeHead(401).end(); return }
    const server = new McpServer({ name: 'unlinked-account-network', version: '1.0.0' })
    server.registerTool('unlinked_search_network', {
      description: 'Search all currently published LinkedIn observations owned by your authenticated Unlinked account. Every result retains archive provenance. This does not claim unknown second-degree relationships or access other owners.',
      inputSchema: { query: z.string().min(1).max(1024) },
    }, async ({ query }) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      try {
        const before = await authenticateGrant(request)
        if (!before || before.grantId !== grant.grantId || before.ownerId !== grant.ownerId || before.userId !== grant.userId) throw new Error('account_grant_revoked')
        const result = await createAccountNetwork({ owner: grant, getBackend, complete }).search({ query, signal })
        const after = await authenticateGrant(request)
        if (!after || after.grantId !== grant.grantId || after.ownerId !== grant.ownerId || after.userId !== grant.userId) throw new Error('account_grant_revoked')
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('account_tool_result_limit')
        return { content: [{ type: 'text', text }] }
      } catch { return { isError: true, content: [{ type: 'text', text: 'Network unavailable or access revoked. Retry after signing in.' }] } }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  }
}
