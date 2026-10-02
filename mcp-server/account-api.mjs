import { AccountToolError } from './account-tools.mjs'

// Grant-authenticated HTTP JSON surface for the same account tool service the
// hosted MCP endpoint uses. Versioned contract: docs/agent-api.md (v1). The
// MCP tools are thin wrappers over these semantics; names map 1:1.
const ROUTES = Object.freeze({
  'GET /api/agent/v1/whoami': { tool: 'unlinked_whoami', query: [] },
  'GET /api/agent/v1/people': { tool: 'unlinked_list_people', query: ['q', 'mode', 'presence', 'cursor', 'limit'], numbers: ['limit'] },
  'GET /api/agent/v1/connections': { tool: 'unlinked_list_connections', query: ['degree', 'q', 'cursor', 'limit'], numbers: ['degree', 'limit'] },
  'POST /api/agent/v1/ai-search': { tool: 'unlinked_ai_search', body: ['query', 'scope', 'timeoutMs'] },
  'POST /api/agent/v1/search-network': { tool: 'unlinked_search_network', body: ['query', 'degree', 'cursor'] },
  'POST /api/agent/v1/search-everyone': { tool: 'unlinked_search_everyone', body: ['query'] },
})

async function readJsonBody(request, limit = 8192) {
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type && type !== 'application/json') throw new AccountToolError('invalid_input', 'Send a JSON body with Content-Type: application/json.')
  const parts = []
  let size = 0
  for await (const part of request) {
    size += part.length
    if (size > limit) throw new AccountToolError('invalid_input', 'The request body exceeds 8 KiB.')
    parts.push(part)
  }
  if (!size) return {}
  let value
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new AccountToolError('invalid_input', 'The request body is not valid JSON.') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AccountToolError('invalid_input', 'The request body must be a JSON object.')
  return value
}

export function createAccountAgentApiHandler({ authenticateGrantDetailed, authenticateGrant, service, origin }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.origin !== origin || typeof authenticateGrantDetailed !== 'function' || typeof authenticateGrant !== 'function' || typeof service?.call !== 'function') throw new Error('account_agent_api_configuration_required')
  const send = (response, status, value, headers = {}) => {
    if (response.headersSent) { response.end(); return }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    response.end(JSON.stringify(value))
  }
  const failure = (response, error) => {
    const typed = error instanceof AccountToolError ? error : new AccountToolError('upstream_unavailable', 'The request could not finish; retry.')
    send(response, typed.status, { error: { code: typed.code, message: typed.message } }, typed.code === 'rate_limited' ? { 'Retry-After': '60' } : {})
  }
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'strict-origin')
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    if (request.headers.host !== base.host || request.headers.origin && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    try {
      const url = new URL(request.url, base)
      if (url.origin !== base.origin) { response.writeHead(403).end(); return }
      const detailMatch = url.pathname.match(/^\/api\/agent\/v1\/people\/([^/]+)$/)
      const profileMatch = request.method === 'GET' && detailMatch
      const suffix = url.pathname.slice('/api/agent/v1/'.length)
      const route = profileMatch ? { tool: 'unlinked_get_profile', query: ['connectionsCursor'] } : ROUTES[`${request.method} /api/agent/v1/${suffix}`]
      if (!url.pathname.startsWith('/api/agent/v1/') || !route) {
        const allowed = detailMatch ? 'GET' : ['GET', 'POST'].map(method => ROUTES[`${method} /api/agent/v1/${suffix}`] ? method : null).filter(Boolean).join(', ')
        if (allowed) { response.writeHead(405, { Allow: allowed }).end(); return }
        if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return }
        failure(response, new AccountToolError('not_found', 'Unknown agent API route. See docs/agent-api.md for the v1 contract.')); return
      }
      const detailed = await authenticateGrantDetailed(request)
      if (!detailed.grant) {
        const messages = {
          grant_revoked: 'The grant was revoked or its account was deleted; sign in at /settings and create a new agent grant.',
          upstream_unavailable: 'The grant could not be verified right now; retry with the same token.',
          not_linked: 'No linked Unlinked account: supply a valid account-grant bearer token issued at /settings. Linkage is never established by email matching.',
        }
        const code = Object.hasOwn(messages, detailed.error) ? detailed.error : 'not_linked'
        failure(response, new AccountToolError(code, messages[code]))
        return
      }
      const grant = detailed.grant
      const input = {}
      if (route.body) {
        const body = await readJsonBody(request)
        const unknown = Object.keys(body).find(key => !route.body.includes(key))
        if (unknown) throw new AccountToolError('invalid_input', `Unknown field: ${unknown}`)
        for (const key of route.body) if (body[key] !== undefined) input[key] = body[key]
      } else {
        const unknown = [...url.searchParams.keys()].find(key => !route.query.includes(key))
        if (unknown) throw new AccountToolError('invalid_input', `Unknown query parameter: ${unknown}`)
        for (const key of route.query) {
          const values = url.searchParams.getAll(key)
          if (values.length > 1) throw new AccountToolError('invalid_input', `Repeated query parameter: ${key}`)
          if (!values.length) continue
          if (route.numbers?.includes(key)) {
            const value = Number(values[0])
            if (!Number.isSafeInteger(value)) throw new AccountToolError('invalid_input', `${key} must be an integer.`)
            input[key] = value
          } else input[key] = values[0]
        }
        if (profileMatch) {
          try { input.id = decodeURIComponent(profileMatch[1]) } catch { throw new AccountToolError('invalid_input', 'The profile id is not valid percent-encoding.') }
        }
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      // The pre-call check already happened just above; revalidate only after
      // the tool body, so a mid-call revocation still never returns data.
      let checked = false
      const revalidate = async () => {
        if (!checked) { checked = true; return }
        const current = await authenticateGrant(request)
        if (!current || current.grantId !== grant.grantId || current.ownerId !== grant.ownerId || current.userId !== grant.userId || JSON.stringify(current.tools) !== JSON.stringify(grant.tools)) throw new AccountToolError('grant_revoked', 'The grant was revoked; sign in and create a new agent grant.')
      }
      const { text } = await service.call({ grant, name: route.tool, input, signal, revalidate })
      if (response.headersSent) { response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(text)
    } catch (error) { failure(response, error) }
  }
}
