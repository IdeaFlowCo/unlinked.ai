import { createKnownConnectionsReader, knownConnectionQuery } from '../src/utils/public-people/known-connections.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'

// Tool failures carry sanitized typed causes (code/message plus an internal
// error identifier) so a provider or aggregation failure is distinguishable
// from real revocation. Only constant internal identifiers pass through —
// never raw exception text, which could carry request or profile data. The
// code vocabulary matches docs discussed in PR #52 (grant_revoked,
// invalid_input, cursor_invalid, degree_unproven, result_too_large,
// upstream_unavailable).
const TOOL_FAILURES = {
  account_grant_revoked: ['grant_revoked', 'The account grant was revoked or replaced. Sign in and create a new agent grant in Settings.'],
  account_cursor_requires_connection_mode: ['invalid_input', 'A cursor requires a degree-filtered connections query.'],
  known_connections_input_invalid: ['invalid_input', 'The search input was invalid (query, degree or cursor).'],
  private_search_query_limit: ['invalid_input', 'The query was empty or too long.'],
  shared_search_query_invalid: ['invalid_input', 'The query was empty or too long.'],
  known_connections_cursor_invalid: ['cursor_invalid', 'The cursor does not match the current listing; restart from the first page.'],
  known_connections_anchor_unavailable: ['degree_unproven', 'Recorded public paths require a confirmed legacy profile anchor; none is linked.'],
  account_tool_result_limit: ['result_too_large', 'The result exceeded 1 MiB; narrow the query.'],
}
export function typedToolFailure(error) {
  const message = String(error?.message ?? '')
  const known = TOOL_FAILURES[message]
  const [code, text] = known ?? ['upstream_unavailable', 'The search could not finish upstream. The grant is still valid; retry, or narrow the query.']
  const cause = known ? undefined : /^(?:private|known|account|legacy|shared|public)_[a-z0-9_]{1,70}$/.test(message) ? message : 'internal_error'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: text, ...(cause ? { cause } : {}) } }) }] }
}

export function createAccountHostedHandler({ authenticateGrant, getBackend, complete, readPublishedSnapshot, origin }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || ![authenticateGrant, getBackend, complete].every(x => typeof x === 'function')) throw new Error('account_host_configuration_required')
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.host !== base.host || request.headers.origin && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    const grant = await authenticateGrant(request)
    if (!grant || !['owner_network','owner_network_and_public'].includes(grant.scope) || !Array.isArray(grant.tools) || JSON.stringify(grant.tools) !== JSON.stringify(grant.scope === 'owner_network' ? ['unlinked_search_network'] : ['unlinked_search_network','unlinked_search_everyone'])) { response.writeHead(401).end(); return }
    const server = new McpServer({ name: 'unlinked-account-network', version: '1.0.0' })
    server.registerTool('unlinked_search_network', {
      description: 'Search all currently published LinkedIn observations owned by your authenticated Unlinked account. Every result retains archive provenance. With degree1/2 (or a second-degree query), read recorded public connection paths from your explicitly linked legacy profile. Unknown identity/relationship matches are not invented; no other owner/private fields are accessed.',
      inputSchema: { query: z.string().min(1).max(1024), degree: z.union([z.literal(1), z.literal(2)]).optional(), cursor: z.string().max(2048).optional() },
    }, async ({ query, degree, cursor }) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      try {
        const before = await authenticateGrant(request)
        if (!before || before.grantId !== grant.grantId || before.ownerId !== grant.ownerId || before.userId !== grant.userId) throw new Error('account_grant_revoked')
        const connectionQuery = knownConnectionQuery(query, degree)
        if (cursor !== undefined && !connectionQuery.degree) throw new Error('account_cursor_requires_connection_mode')
        const result = connectionQuery.degree ? await createKnownConnectionsReader({ owner: grant, getBackend, readPublishedSnapshot })({ ...connectionQuery, cursor, signal }) : await createAccountNetwork({ owner: grant, getBackend, complete }).search({ query, signal })
        const after = await authenticateGrant(request)
        if (!after || after.grantId !== grant.grantId || after.ownerId !== grant.ownerId || after.userId !== grant.userId) throw new Error('account_grant_revoked')
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('account_tool_result_limit')
        return { content: [{ type: 'text', text }] }
      } catch (error) { return typedToolFailure(error) }
    })
    if (grant.tools.includes('unlinked_search_everyone') && typeof readPublishedSnapshot === 'function') server.registerTool('unlinked_search_everyone', {
      description: 'Search the complete published professional People index, including recovered public Unlinked profiles. No personal archive is required. All profiles are considered for bounded index retrieval before AI ranks up to200 professional candidates. Raw archives, contact email/phone and private imports are excluded.',
      inputSchema: { query: z.string().min(1).max(1024) },
    }, async ({ query }) => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      try {
        const valid = async () => { const current = await authenticateGrant(request); if (!current || current.grantId !== grant.grantId || current.ownerId !== grant.ownerId || current.userId !== grant.userId || !current.tools.includes('unlinked_search_everyone')) throw new Error('account_grant_revoked') }
        await valid()
        const result = await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal })
        await valid()
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) { return typedToolFailure(error) }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  }
}
