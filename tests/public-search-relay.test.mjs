import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicSearchRelay } from '../src/utils/public-search-relay.mjs'
import { publicSearchDocument } from '../mcp-server/public-web-search.mjs'

const request = (query = '', options = {}) => new Request(`https://unlinked-ideaflowco.vercel.app/search-public${query}`, options)
const page = name => publicSearchDocument({ profiles: [{ id: 'published-1', name, headline: 'Games investor' }], nextCursor: 'next', total: 2 }, { query: 'games', mode: 'best' })
const html = content => new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

test('alternate public transport fetches only the fixed endpoint and strips all incoming credentials', async () => {
  const calls = []
  const relay = createPublicSearchRelay({ fetchImpl: async (target, options) => {
    calls.push({ target, options })
    const response = html(page('Published Example'))
    response.headers.set('Set-Cookie', 'secret=upstream-cookie')
    response.headers.set('Authorization', 'Bearer upstream-secret')
    return response
  } })
  const result = await relay(request('?q=games&mode=exact&presence=member&cursor=next', {
    headers: { Authorization: 'Bearer private-account', Cookie: 'account=private', 'X-Agent-Key': 'private-key' },
  }))
  assert.equal(result.status, 200)
  assert.equal(String(calls[0].target), 'https://www.unlinked.ai/search-public?q=games&mode=exact&presence=member&cursor=next')
  assert.deepEqual(calls[0].options.headers, { Accept: 'text/html' })
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(result.headers.get('set-cookie'), null)
  assert.equal(result.headers.get('authorization'), null)
  for (const header of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) assert.equal(result.headers.get(header), 'no-store')
  const document = await result.text()
  assert.match(document, /Published Example/)
  assert.match(document, /href="https:\/\/www.unlinked.ai\/people\/published-1"/)
  assert.match(document, /href="\/search-public\?/)
  assert.match(document, /action="\/search-public"/)
  assert.doesNotMatch(document, /private-account|private-key|upstream-secret|upstream-cookie/)
})

test('each read revalidates the live publication; revoked or unavailable content is never retained', async () => {
  let reads = 0, published = true
  const relay = createPublicSearchRelay({ fetchImpl: async () => {
    reads++
    return published ? html(page('Published Example')) : new Response('private provider failure', { status: 503 })
  } })
  assert.match(await (await relay(request('?q=games'))).text(), /Published Example/)
  published = false
  const revoked = await relay(request('?q=games'))
  assert.equal(reads, 2)
  assert.equal(revoked.status, 503)
  assert.deepEqual(await revoked.json(), { error: 'public_search_unavailable' })
})

test('invalid input, private paths and writes are denied before any upstream request', async () => {
  let reads = 0
  const relay = createPublicSearchRelay({ fetchImpl: async () => { reads++; return html(page('Example')) } })
  for (const query of ['?q=a&q=b', '?q=' + 'x'.repeat(201), '?mode=private', '?presence=private', '?cursor=%2Fsettings', '?cursor=' + 'a'.repeat(2049), '?url=https://private.example', '?owner=private']) {
    assert.equal((await relay(request(query))).status, 400, query)
  }
  assert.equal((await relay(new Request('https://example.com/settings'))).status, 404)
  assert.equal((await relay(request('', { method: 'POST' }))).status, 405)
  assert.equal(reads, 0)
})

test('HEAD preserves public availability without returning content or cookies', async () => {
  const relay = createPublicSearchRelay({ fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'HEAD')
    return html(null)
  } })
  const result = await relay(request('?q=games', { method: 'HEAD' }))
  assert.equal(result.status, 200)
  assert.equal(await result.text(), '')
  assert.equal(result.headers.get('set-cookie'), null)
})

test('upstream failures, redirects and non-HTML never become results or leak upstream content', async () => {
  for (const status of [400, 401, 302, 429, 500, 503]) {
    const relay = createPublicSearchRelay({ fetchImpl: async () => new Response('private error', { status, headers: { Location: 'https://private.example', 'Set-Cookie': 'private' } }) })
    const result = await relay(request())
    assert.equal(result.status, [400, 429, 503].includes(status) ? status : 503)
    assert.equal(result.headers.get('location'), null)
    assert.doesNotMatch(await result.text(), /private error|private.example/)
  }
  const relay = createPublicSearchRelay({ fetchImpl: async () => new Response('{"private":"data"}', { headers: { 'Content-Type': 'application/json' } }) })
  assert.equal((await relay(request())).status, 503)
})

test('responses are bounded even when streamed without content-length', async () => {
  let cancelled = false
  const relay = createPublicSearchRelay({ fetchImpl: async () => html(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) },
    cancel() { cancelled = true },
  })) })
  const result = await relay(request())
  assert.equal(result.status, 503)
  assert.equal(cancelled, true)
  const declared = createPublicSearchRelay({ fetchImpl: async () => new Response('body', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(256 * 1024 + 1) } }) })
  assert.equal((await declared(request())).status, 503)
})

test('timeouts and client cancellation abort the upstream and return an unavailable response', async () => {
  const relay = createPublicSearchRelay({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  // Keep the test process alive while AbortSignal.timeout uses its unref timer.
  const keepalive = setInterval(() => {}, 1000)
  try {
    assert.equal((await relay(request())).status, 503)
    const controller = new AbortController()
    controller.abort()
    assert.equal((await relay(request('', { signal: controller.signal }))).status, 503)
  } finally { clearInterval(keepalive) }
})
