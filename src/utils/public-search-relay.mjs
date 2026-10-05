const origin = 'https://www.unlinked.ai'
const keys = new Set(['q', 'mode', 'presence', 'cursor'])
const maxBytes = 256 * 1024
const headers = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'strict-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
}

// One fixed anonymous endpoint, with no account headers, redirects, stored
// publication, model calls, private routes or request-selected upstream host.
export function createPublicSearchRelay({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  return async function relay(request) {
    const fail = (status, error) => new Response(request.method === 'HEAD' ? null : JSON.stringify({ error }), {
      status, headers: { ...headers, 'Content-Type': 'application/json' },
    })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } })
    const url = new URL(request.url)
    if (url.pathname !== '/search-public') return fail(404, 'public_search_not_found')
    const parameters = url.searchParams
    if ([...parameters.keys()].some(key => !keys.has(key) || parameters.getAll(key).length !== 1)
      || (parameters.get('q') ?? '').length > 200
      || (parameters.has('mode') && !['best', 'exact'].includes(parameters.get('mode')))
      || (parameters.has('presence') && !['member', 'shadow'].includes(parameters.get('presence')))
      || (parameters.has('cursor') && (!/^[A-Za-z0-9_-]+$/.test(parameters.get('cursor')) || parameters.get('cursor').length > 2048))) {
      return fail(400, 'public_search_input_invalid')
    }
    const target = new URL('/search-public', origin)
    target.search = parameters.toString()
    try {
      const upstream = await fetchImpl(target, {
        method: request.method, headers: { Accept: 'text/html' },
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      })
      if (upstream.status !== 200) {
        await upstream.body?.cancel()
        const response = fail([400, 429, 503].includes(upstream.status) ? upstream.status : 503, 'public_search_unavailable')
        const retryAfter = upstream.headers.get('retry-after')
        if (upstream.status === 429 && retryAfter !== null
          && ((/^\d{1,16}$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter)))
            || (retryAfter.length === 29 && new Date(retryAfter).toUTCString() === retryAfter))) {
          response.headers.set('Retry-After', retryAfter)
        }
        return response
      }
      if (upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html'
        || Number(upstream.headers.get('content-length')) > maxBytes) {
        await upstream.body?.cancel()
        return fail(503, 'public_search_unavailable')
      }
      if (request.method === 'HEAD') {
        await upstream.body?.cancel()
        return new Response(null, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (!upstream.body) return fail(503, 'public_search_unavailable')
      const reader = upstream.body.getReader(), chunks = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > maxBytes) { await reader.cancel(); return fail(503, 'public_search_unavailable') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const data = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      // Preserve search/pagination on this transport. Profile and navigation
      // links use the canonical public app, not the historical Next.js UI.
      const document = new TextDecoder('utf-8', { fatal: true }).decode(data)
        .replaceAll('href="/people/', `href="${origin}/people/`)
        .replaceAll('href="/people?', `href="${origin}/people?`)
        .replaceAll('href="/agents"', `href="${origin}/agents"`)
        .replaceAll('href="/"', `href="${origin}/"`)
      return new Response(document, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
    } catch { return fail(503, 'public_search_unavailable') }
  }
}
