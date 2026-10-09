import { createKnownConnectionsReader, knownConnectionQuery } from '../src/utils/public-people/known-connections.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { accountGrantTools } from './account-grants.mjs'
import { ACCOUNT_TOOL_DESCRIPTIONS, ACCOUNT_TOOL_SCHEMAS, AccountToolError, WRITE_TOOLS, createAccountToolService } from './account-tools.mjs'

// Tool failures carry sanitized typed causes (code/message plus an internal
// error identifier) so a provider or aggregation failure is distinguishable
// from real revocation. Only constant internal identifiers pass through —
// never raw exception text, which could carry request or profile data. The
// code vocabulary is the docs/agent-api.md contract (grant_revoked,
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
  if (error instanceof AccountToolError) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message } }) }] }
  const message = String(error?.message ?? '')
  const known = TOOL_FAILURES[message]
  const [code, text] = known ?? ['upstream_unavailable', 'The search could not finish upstream. The grant is still valid; retry, or narrow the query.']
  const cause = known ? undefined : /^(?:private|known|account|legacy|shared|public)_[a-z0-9_]{1,70}$/.test(message) ? message : 'internal_error'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: text, ...(cause ? { cause } : {}) } }) }] }
}

// Tools beyond the two launch tools are registered from the shared service so
// the MCP surface and the HTTP agent API (docs/agent-api.md) stay one contract.
const SERVICE_TOOLS = ['unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications',
  // Registered only for grants whose opt-in scope includes them.
  'unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request']

export function createAccountHostedHandler({ authenticateGrant, getBackend, complete, readPublishedSnapshot, origin, service, challenge }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || ![authenticateGrant, getBackend, complete].every(x => typeof x === 'function')) throw new Error('account_host_configuration_required')
  const toolService = service ?? createAccountToolService({ getBackend, complete, readPublishedSnapshot })
  return async (request, response, parsedBody) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.host !== base.host || request.headers.origin && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    // Unauthenticated requests get the OAuth challenge (RFC 9728) whatever the
    // method, so connectors can discover sign-in from their first request.
    const grant = await authenticateGrant(request)
    // Authentication resolves valid historical records to current permitted tools.
    const catalog = grant ? accountGrantTools(grant.version ?? 1, grant.scope) : null
    if (!grant || !catalog || !Array.isArray(grant.tools) || JSON.stringify(grant.tools) !== JSON.stringify(catalog)) {
      response.writeHead(401, typeof challenge === 'function' ? { 'WWW-Authenticate': challenge({ invalidToken: typeof request.headers.authorization === 'string' }) } : {}).end(); return
    }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    const revalidate = async name => {
      const current = await authenticateGrant(request)
      if (!current || current.grantId !== grant.grantId || current.ownerId !== grant.ownerId || current.userId !== grant.userId) throw new AccountToolError('grant_revoked', 'The grant was revoked or replaced.')
      if (!current.tools.includes(name)) throw new AccountToolError('scope_not_granted', 'This key no longer permits the requested tool.')
      return current
    }
    const server = new McpServer({ name: 'unlinked-account-network', version: '1.0.0' })
    server.registerTool('unlinked_search_network', {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description: 'Search all currently published LinkedIn observations owned by your authenticated Unlinked account. Every result retains archive provenance. With degree1/2 (or a second-degree query), read recorded public connection paths from your explicitly linked legacy profile. Unknown identity/relationship matches are not invented; no other owner/private fields are accessed.',
      inputSchema: { query: z.string().min(1).max(1024), degree: z.union([z.literal(1), z.literal(2)]).optional(), cursor: z.string().max(2048).optional() },
    }, async ({ query, degree, cursor }) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      try {
        await revalidate('unlinked_search_network')
        const connectionQuery = knownConnectionQuery(query, degree)
        if (cursor !== undefined && !connectionQuery.degree) throw new Error('account_cursor_requires_connection_mode')
        const result = connectionQuery.degree ? await createKnownConnectionsReader({ owner: grant, getBackend, readPublishedSnapshot })({ ...connectionQuery, cursor, signal }) : await createAccountNetwork({ owner: grant, getBackend, complete }).search({ query, signal })
        await revalidate('unlinked_search_network')
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('account_tool_result_limit')
        return { content: [{ type: 'text', text }] }
      } catch (error) { return typedToolFailure(error) }
    })
    if (grant.tools.includes('unlinked_search_everyone') && typeof readPublishedSnapshot === 'function') server.registerTool('unlinked_search_everyone', {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description: 'Search the complete published professional People index, including recovered public Unlinked profiles. No personal archive is required. All profiles are considered for bounded index retrieval before AI ranks up to200 professional candidates. Raw archives, contact email/phone and private imports are excluded.',
      inputSchema: { query: z.string().min(1).max(1024) },
    }, async ({ query }) => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      try {
        const valid = () => revalidate('unlinked_search_everyone')
        await valid()
        const result = await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal })
        await valid()
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) { return typedToolFailure(error) }
    })
    for (const name of SERVICE_TOOLS) {
      if (!grant.tools.includes(name)) continue
      // Clients that ask before acting see which tools change something.
      const annotations = WRITE_TOOLS.has(name) ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } : { readOnlyHint: true, openWorldHint: false }
      server.registerTool(name, { description: ACCOUNT_TOOL_DESCRIPTIONS[name], inputSchema: ACCOUNT_TOOL_SCHEMAS[name], annotations }, async input => {
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])
        response.once('close', () => { if (!response.writableFinished) controller.abort() })
        try {
          const { text } = await toolService.call({ grant, name, input, signal, revalidate: () => revalidate(name) })
          return { content: [{ type: 'text', text }] }
        } catch (error) {
          const typed = error instanceof AccountToolError ? error : new AccountToolError('upstream_unavailable', 'The tool could not finish; retry.')
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: typed.code, message: typed.message } }) }] }
        }
      })
    }
    // This POST-only, stateless transport cannot deliver list-change pushes.
    // Clients explicitly refresh tools/list after a permission change.
    server.server.registerCapabilities({ tools: { listChanged: false } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(request, response, parsedBody)
  }
}
