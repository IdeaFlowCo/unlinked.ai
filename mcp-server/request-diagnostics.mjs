import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

// This is an allowlist projection, never a request/error/body logger.
const context = new AsyncLocalStorage()
const TOOLS = new Set(['unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_search_network', 'unlinked_search_everyone', 'unlinked_list_connection_requests', 'unlinked_list_notifications', 'unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request', 'unlinked_read_import', 'unlinked_search_import'])
const ERRORS = new Set(['not_linked', 'grant_revoked', 'invalid_input', 'cursor_invalid', 'client_unauthorized', 'scope_not_granted', 'not_found', 'degree_unproven', 'result_too_large', 'rate_limited', 'upstream_unavailable', 'not_a_member', 'already_connected', 'request_pending', 'request_unavailable', 'cooldown_active', 'account_link_required', 'protocol_error', 'internal_error'])
const METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'])
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : undefined
const bytes = (value, encoding) => typeof value === 'string' ? Buffer.byteLength(value, typeof encoding === 'string' ? encoding : undefined) : ArrayBuffer.isView(value) ? value.byteLength : 0
export const diagnosticAccountId = ownerId => createHash('sha256').update('unlinked-diagnostics-owner-v1\0').update(ownerId).digest('hex')
const noop = Object.freeze({ route() {}, authenticated() {}, authType() {}, denied() {}, tool() {}, input() {}, result() {}, failure() {}, rpc() {}, rpcResult() {}, gateway() {} })
export const requestDiagnostic = () => context.getStore() ?? noop

export function diagnosticTransport(pathname) {
  if (pathname === '/mcp') return 'direct_mcp'
  if (pathname === '/api/connector/mcp') return 'gateway_mcp'
  if (pathname === '/api/agent' || pathname.startsWith('/api/agent/')) return 'rest'
  return null
}

export function createRequestDiagnostics({ emit, now = () => new Date(), monotonic = () => performance.now(), maxPerMinute = 600 } = {}) {
  if (typeof emit !== 'function' || !Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 600) throw new Error('diagnostics_configuration_invalid')
  let window = -1, emitted = 0, dropped = 0
  return {
    run(request, response, transport, work) {
      if (!['rest', 'direct_mcp', 'gateway_mcp'].includes(transport)) return work()
      const started = now(), tick = monotonic()
      const row = { schema: 1, event: 'agent_request', at: started.toISOString(), request_id: randomUUID(), transport,
        method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE', 'PUT', 'PATCH'].includes(request.method) ? request.method : 'other',
        route: transport === 'rest' ? '/api/agent/unknown' : transport === 'direct_mcp' ? '/mcp' : '/api/connector/mcp',
        auth_type: transport === 'gateway_mcp' ? 'gateway_assertion' : 'account_bearer', auth_outcome: 'not_evaluated',
        cancelled: false, timed_out: false, rate_limited: false }
      // Caller-supplied X-Request-ID, traceparent and JSON-RPC id never enter
      // diagnostics. The response ID is newly minted even on auth rejection.
      response.setHeader('X-Request-ID', row.request_id)
      let requestBytes = request.readableLength ?? 0, responseBytes = 0, ended = false
      const push = request.push
      request.push = function (chunk, encoding) { requestBytes += bytes(chunk, encoding); return push.call(this, chunk, encoding) }
      const write = response.write, end = response.end
      response.write = function (chunk, ...args) { responseBytes += bytes(chunk, args[0]); return write.call(this, chunk, ...args) }
      response.end = function (chunk, ...args) { responseBytes += bytes(chunk, args[0]); return end.call(this, chunk, ...args) }
      const trace = {
        // Routes are server constants, never URLs or caller-selected path IDs.
        route(value) { if (/^\/api\/agent\/v1\/(?:whoami|people|people\/\{id\}|connections|connection-requests(?:\/(?:send|accept|ignore|withdraw))?|notifications|ai-search|search-network|search-everyone|provision-grant)$/.test(value)) row.route = value },
        authType(type) { if (['account_bearer', 'private_bearer', 'gateway_assertion', 'provisioning_client'].includes(type)) row.auth_type = type },
        authenticated(ownerId, type) {
          if (typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 256) {
            row.account_id = diagnosticAccountId(ownerId); row.auth_outcome = 'accepted'
            if (['account_bearer', 'private_bearer', 'gateway_assertion', 'provisioning_client'].includes(type)) row.auth_type = type
          }
        },
        denied(code) { if (row.auth_outcome !== 'accepted') row.auth_outcome = code === 'upstream_unavailable' ? 'unavailable' : 'rejected'; trace.failure({ code }) },
        tool(name) { row.tool = TOOLS.has(name) ? name : 'unknown' },
        input(input) {
          if (typeof input?.query === 'string' || typeof input?.q === 'string') row.query_chars = count((input.query ?? input.q).length)
          if (input && Object.hasOwn(input, 'cursor')) row.cursor_supplied = true
          if (Number.isSafeInteger(input?.limit)) row.page_limit = count(input.limit)
          if (Number.isSafeInteger(input?.timeoutMs)) row.requested_timeout_ms = count(input.timeoutMs)
        },
        result(result) {
          if (!result || typeof result !== 'object') return
          for (const key of ['matches', 'profiles', 'people', 'connections', 'notifications', 'requests', 'items']) if (Array.isArray(result[key])) { row.result_count = count(result[key].length); break }
          if (Object.hasOwn(result, 'nextCursor')) row.has_next_page = typeof result.nextCursor === 'string' && result.nextCursor.length > 0
          if (typeof result.truncated === 'boolean') row.truncated = result.truncated
          for (const [key, field] of [['considered', 'considered'], ['indexed', 'indexed'], ['lexicalMatches', 'lexical_matches'], ['modelCandidates', 'model_candidates']]) if (count(result[key]) !== undefined) row[field] = count(result[key])
        },
        failure(error, signal) {
          if (ERRORS.has(error?.code)) row.error_class = error.code
          else if (!row.error_class) row.error_class = 'internal_error'
          if (error?.name === 'TimeoutError' || signal?.aborted && signal.reason?.name === 'TimeoutError') row.timed_out = true
          else if (error?.name === 'AbortError' || signal?.aborted) row.cancelled = true
          if (error?.code === 'rate_limited' || error?.code === 'cooldown_active') row.rate_limited = true
          if (error?.message === 'private_search_provider_http_429') row.failure_stage = 'provider_rate_limit'
          else if (/^private_search_provider_http_[45]\d\d$/.test(error?.message ?? '')) row.failure_stage = 'provider_http'
          else if (['private_search_context_limit', 'shared_search_context_limit'].includes(error?.message)) row.failure_stage = 'model_input_limit'
        },
        rpc(message) {
          row.rpc_method = METHODS.has(message?.method) ? message.method : 'other'
          if (message?.method === 'tools/call') { trace.tool(message.params?.name); trace.input(message.params?.arguments) }
        },
        rpcResult(message) {
          if (message?.error) trace.failure({ code: 'protocol_error' })
          // Only the bounded, known JSON tool contract is interpreted. Never
          // retain content or exception descriptions, including SDK messages.
          if (message?.result?.isError) {
            let code
            try { code = JSON.parse(message.result.content?.[0]?.text).error?.code } catch {}
            trace.failure({ code: ERRORS.has(code) ? code : row.error_class ?? 'protocol_error' })
          }
        },
        gateway(verifiedAssertion) {
          // Called only after signature/body/audience/replay verification. A
          // digest of the one-use jti correlates an operator's gateway trace;
          // it is not a caller-supplied trace header or a bearer credential.
          if (typeof verifiedAssertion?.jti === 'string') row.gateway_assertion_hash = createHash('sha256').update(verifiedAssertion.jti).digest('hex')
        },
      }
      const finish = () => {
        if (ended) return
        ended = true
        row.completed_at = now().toISOString()
        row.duration_ms = Math.max(0, Math.round(monotonic() - tick))
        row.http_status = response.headersSent ? response.statusCode : null
        row.request_bytes_observed = count(requestBytes); row.response_bytes = count(responseBytes)
        row.request_complete = request.complete === true; row.response_complete = response.writableFinished
        row.cancelled ||= !response.writableFinished
        if (!row.error_class && row.http_status >= 400) row.error_class = ({ 400: 'invalid_input', 401: 'not_linked', 403: 'scope_not_granted', 404: 'not_found', 413: 'result_too_large', 429: 'rate_limited', 503: 'upstream_unavailable' })[row.http_status] ?? 'protocol_error'
        row.rate_limited ||= row.http_status === 429
        const minute = Math.floor(now().getTime() / 60000)
        if (minute !== window) { window = minute; emitted = 0 }
        if (++emitted > maxPerMinute) { dropped++; return }
        row.dropped_since_last_emit = dropped; dropped = 0
        // Diagnostics must never change a response or create unhandled rejects.
        try { Promise.resolve(emit(Object.freeze({ ...row }))).catch(() => {}) } catch {}
      }
      response.once('finish', finish); response.once('close', finish)
      return context.run(trace, work)
    },
  }
}

export function instrumentMcpTransport(transport) {
  const trace = requestDiagnostic(), receive = transport.onmessage, send = transport.send
  transport.onmessage = (message, ...args) => { trace.rpc(message); return context.run(trace, () => receive?.(message, ...args)) }
  transport.send = function (message, ...args) { trace.rpcResult(message); return send.call(this, message, ...args) }
}

// Defense in depth for persistence and the operator reader: even accidental
// extra fields supplied by another internal caller cannot become log content.
export function safeDiagnosticRecord(value) {
  if (!value || value.schema !== 1 || value.event !== 'agent_request' || typeof value.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.request_id ?? '')) return null
  const result = { schema: 1, event: 'agent_request', request_id: value.request_id }
  for (const key of ['at', 'completed_at']) if (typeof value[key] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[key]) && Number.isFinite(Date.parse(value[key]))) result[key] = value[key]
  const choices = { transport: ['rest', 'direct_mcp', 'gateway_mcp'], method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE', 'PUT', 'PATCH', 'other'], auth_type: ['gateway_assertion', 'account_bearer', 'private_bearer', 'provisioning_client'], auth_outcome: ['not_evaluated', 'accepted', 'rejected', 'unavailable'], rpc_method: [...METHODS, 'other'], tool: [...TOOLS, 'unknown'], error_class: [...ERRORS], failure_stage: ['provider_rate_limit', 'provider_http', 'model_input_limit'] }
  for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(value[key])) result[key] = value[key]
  if (typeof value.route === 'string' && /^(?:\/mcp|\/api\/connector\/mcp|\/api\/agent\/unknown|\/api\/agent\/v1\/(?:whoami|people|people\/\{id\}|connections|connection-requests(?:\/(?:send|accept|ignore|withdraw))?|notifications|ai-search|search-network|search-everyone|provision-grant))$/.test(value.route ?? '')) result.route = value.route
  if (value.auth_outcome === 'accepted' && typeof value.account_id === 'string' && /^[a-f0-9]{64}$/.test(value.account_id ?? '')) result.account_id = value.account_id
  if (value.transport === 'gateway_mcp' && typeof value.gateway_assertion_hash === 'string' && /^[a-f0-9]{64}$/.test(value.gateway_assertion_hash ?? '')) result.gateway_assertion_hash = value.gateway_assertion_hash
  for (const key of ['duration_ms', 'query_chars', 'page_limit', 'requested_timeout_ms', 'request_bytes_observed', 'response_bytes', 'result_count', 'considered', 'indexed', 'lexical_matches', 'model_candidates', 'dropped_since_last_emit', 'sink_dropped_since_last_write']) if (count(value[key]) !== undefined) result[key] = count(value[key])
  for (const key of ['cancelled', 'timed_out', 'rate_limited', 'cursor_supplied', 'has_next_page', 'truncated', 'request_complete', 'response_complete']) if (typeof value[key] === 'boolean') result[key] = value[key]
  if (value.http_status === null || Number.isSafeInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599) result.http_status = value.http_status
  return result
}
