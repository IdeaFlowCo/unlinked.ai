import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

// Product query history is deliberately separate from content-free diagnostics.
// No response bodies, headers, cookies, private notes, or result text enter it.
const context = new AsyncLocalStorage()
const TOOLS = new Set(['unlinked_ai_search', 'unlinked_search_network', 'unlinked_search_everyone', 'unlinked_search_import', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_list_person_targets', 'unlinked_search_private', 'unlinked_list_private_things', 'unlinked_export_network'])
const SCOPES = new Set(['everyone', 'mine', 'own', 'all', 'list', 'import', 'private'])
const SURFACES = new Set(['directory', 'public_search', 'public_api', 'suggestions', 'connections', 'company', 'private_list', 'network_connections', 'ai_search', 'import_search', 'download', ...TOOLS])
const FILTERS = ['location', 'company', 'pastCompany', 'title', 'school', 'industry', 'kind', 'relationType']
const ERRORS = new Set(['invalid_input', 'cursor_invalid', 'not_found', 'not_linked', 'grant_revoked', 'scope_not_granted', 'degree_unproven', 'rate_limited', 'result_too_large', 'upstream_unavailable', 'protocol_error', 'internal_error'])
const integer = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : undefined
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? '')
export const searchAccountId = ownerId => createHash('sha256').update('unlinked-search-owner-v1\0').update(ownerId).digest('hex')
// Bound encoded row size even for 4-byte Unicode; escape controls via JSON.
export function searchText(value, maxBytes = 2048) {
  if (typeof value !== 'string') return undefined
  let text = '', bytes = 2
  for (const char of value.slice(0, 1024).replace(/[\x00-\x1f\x7f]/g, ' ')) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2
    if (bytes + size > maxBytes) break
    text += char; bytes += size
  }
  return text
}

export function safeSearchRecord(value) {
  if (value?.schema !== 1 || value.event !== 'search_query' || !uuid(value.request_id) || !iso(value.at) || !SURFACES.has(value.surface) || !['browser', 'public_api', 'rest', 'direct_mcp', 'gateway_mcp'].includes(value.transport)) return null
  const row = { schema: 1, event: 'search_query', at: value.at, request_id: value.request_id, surface: value.surface, transport: value.transport }
  if (iso(value.completed_at)) row.completed_at = value.completed_at
  if (typeof value.query === 'string') row.query = searchText(value.query)
  if (typeof value.account_id === 'string' && /^[a-f0-9]{64}$/.test(value.account_id)) row.account_id = value.account_id
  const filters = {}
  for (const key of FILTERS) if (typeof value.filters?.[key] === 'string') filters[key] = searchText(value.filters[key], 120)
  if (Object.keys(filters).length) row.filters = filters
  if (SCOPES.has(value.scope)) row.scope = value.scope
  if (ERRORS.has(value.error_class)) row.error_class = value.error_class
  for (const key of ['query_chars', 'duration_ms', 'result_count', 'total', 'page_limit', 'degree', 'sink_dropped_since_last_write']) if (integer(value[key]) !== undefined) row[key] = integer(value[key])
  for (const key of ['query_truncated', 'cancelled', 'truncated', 'has_next_page', 'cursor_supplied']) if (typeof value[key] === 'boolean') row[key] = value[key]
  for (const [key, choices] of Object.entries({ mode: ['exact', 'best'], sort: ['best', 'name', 'rich', 'recent', 'raw'], presence: ['member', 'legacy', 'shadow'], format: ['csv', 'json', 'jsonl'] })) if (choices.includes(value[key])) row[key] = value[key]
  if (value.http_status === null || Number.isSafeInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599) row.http_status = value.http_status
  return row
}

function browserSurface(path) {
  if (['/network', '/people'].includes(path)) return 'directory'
  if (path === '/search-public') return 'public_search'
  if (path === '/api/people') return 'public_api'
  if (path === '/search-suggestions') return 'suggestions'
  if (path === '/api/my-connections') return 'network_connections'
  if (/^\/people\/[^/]+\/connections$/.test(path)) return 'connections'
  if (/^\/(?:api\/)?companies\/[^/]+$/.test(path)) return 'company'
  if (/^\/lists\/private\/[A-Za-z0-9_-]{1,80}$/.test(path)) return 'private_list'
  if (['/downloads/file', '/api/agent/v1/export'].includes(path)) return 'download'
  if (['/ask', '/search-account'].includes(path)) return 'ai_search'
  if (path === '/search') return 'import_search'
  return null
}
const noop = Object.freeze({ authenticated() {}, input() {}, tool() {}, result() {}, failure() {}, rpc() {}, rpcResult() {}, run: work => work() })
export const searchActivity = () => context.getStore() ?? noop

export function createSearchLog({ emit, now = () => new Date(), monotonic = () => performance.now() }) {
  if (typeof emit !== 'function') throw Error('search_log_configuration_invalid')
  return {
    run(request, response, base, work) {
      const url = new URL(request.url, base), path = url.pathname
      const transport = path === '/mcp' ? 'direct_mcp' : path === '/api/connector/mcp' ? 'gateway_mcp' : path.startsWith('/api/agent/') ? 'rest' : path.startsWith('/api/') || path === '/search-suggestions' ? 'public_api' : 'browser'
      const row = { schema: 1, event: 'search_query', at: now().toISOString(), request_id: randomUUID(), transport }
      const tick = monotonic(), surface = browserSurface(path)
      let finished = false
      const trace = {
        run: work => context.run(trace, work),
        authenticated(ownerId) { if (typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 256) row.account_id = searchAccountId(ownerId) },
        input(input) {
          if (finished) return
          const text = input?.query ?? input?.q
          if (typeof text === 'string') { row.query = searchText(text); row.query_chars = text.length; row.query_truncated = row.query !== text }
          const filters = {}
          for (const key of FILTERS) if (typeof input?.[key] === 'string') filters[key] = searchText(input[key], 120)
          if (Object.keys(filters).length) row.filters = filters
          if (SCOPES.has(input?.scope)) row.scope = input.scope
          if (input?.cursor !== undefined || input?.after !== undefined) row.cursor_supplied = true
          for (const key of ['limit', 'degree']) if (integer(input?.[key]) !== undefined) row[key === 'limit' ? 'page_limit' : key] = integer(input[key])
          for (const key of ['mode', 'sort', 'presence', 'format']) if (typeof input?.[key] === 'string') row[key] = input[key]
        },
        tool(name, input) {
          // Internal list pagination must not overwrite a browser search or an outer export.
          if (!TOOLS.has(name) || row.surface && row.surface !== name) return
          row.surface = name
          trace.input(input)
        },
        result(result, source) {
          if (!result || finished || source && source !== row.surface) return
          for (const key of ['matches', 'profiles', 'people', 'connections', 'items', 'rows', 'entities']) if (Array.isArray(result[key])) { row.result_count = result[key].length; break }
          if (integer(result.total) !== undefined) row.total = result.total
          if (typeof result.truncated === 'boolean') row.truncated = result.truncated
          if (Object.hasOwn(result, 'nextCursor')) row.has_next_page = Boolean(result.nextCursor)
        },
        failure(error) { row.error_class = ERRORS.has(error?.code) ? error.code : 'upstream_unavailable' },
        rpc(message) { if (message?.method === 'tools/call') trace.tool(message.params?.name, message.params?.arguments) },
        rpcResult(message) {
          if (message?.error) row.error_class = 'protocol_error'
          if (message?.result?.isError) {
            let code
            try { code = JSON.parse(message.result.content?.[0]?.text).error?.code } catch {}
            trace.failure({ code: code ?? 'protocol_error' })
          } else if (row.surface && message?.result?.content?.[0]?.type === 'text') {
            // Read only our bounded tool JSON; result() persists scalar counts alone.
            const text = message.result.content[0].text
            if (typeof text === 'string' && text.length <= 1024 * 1024) { try { trace.result(JSON.parse(text)) } catch {} }
          }
        },
      }
      // No HEAD probes, blank landing pages, identity URLs, or message searches.
      if (request.headers.host === base.host && request.method === 'GET' && surface && (url.searchParams.has('q') || url.searchParams.has('query') || ['directory', 'public_api', 'network_connections', 'download'].includes(surface))) {
        row.surface = surface
        trace.input({ ...Object.fromEntries([...FILTERS, 'scope', 'mode', 'sort', 'presence', 'format'].map(key => [key, url.searchParams.get(key)])), query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '', ...(url.searchParams.has('cursor') ? { cursor: true } : {}), ...(url.searchParams.has('after') ? { after: true } : {}), ...(url.searchParams.has('degree') ? { degree: Number(url.searchParams.get('degree')) } : {}) })
      }
      // Forms are parsed once by the existing bounded/CSRF-protected handler.
      if (request.headers.host === base.host && request.method === 'POST' && ['/ask', '/search-account', '/search'].includes(path) && request.headers.origin === base.origin) row.surface = surface
      const finish = () => {
        if (finished) return
        finished = true
        if (!row.surface || request.method === 'HEAD') return
        row.completed_at = now().toISOString(); row.duration_ms = Math.max(0, Math.round(monotonic() - tick))
        row.http_status = response.headersSent ? response.statusCode : null; row.cancelled = !response.writableFinished
        if (!row.error_class && row.http_status >= 400) row.error_class = ({ 400: 'invalid_input', 401: 'not_linked', 403: 'scope_not_granted', 404: 'not_found', 413: 'result_too_large', 429: 'rate_limited' })[row.http_status] ?? 'upstream_unavailable'
        try { const safe = safeSearchRecord(row); if (safe) Promise.resolve(emit(safe)).catch(() => {}) } catch { /* Search availability never depends on log IO. */ }
      }
      response.once('finish', finish); response.once('close', finish)
      return context.run(trace, work)
    },
  }
}
