import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const profile = (id, name) => ({ id, name, headline: 'Engineer at Example', positions: [], education: [], skills: [], email: 'private@example.invalid', ownerId: 'private-owner' })
const snapshot = () => ({ state: 'published', complete: true, revision: 'web-test-v1', profiles: Array.from({ length: 55 }, (_, index) => profile(`p${index}`, `Example ${String(index).padStart(2, '0')}`)), connections: [] })

async function runtime(t, readPublishedSnapshot = async () => snapshot()) {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: origin.replace('http:', 'https:'), readPublishedSnapshot,
    login: { begin: async () => { throw Error('login must not run') }, finish: async () => { throw Error('callback must not run') } },
    resolveOwner: async () => { throw Error('owner must not resolve') }, getBackend: async () => { throw Error('private backend must not read') },
  })
  return (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options })
}

test('connector-free public search is bounded HTML with escaped summaries and working pagination', async t => {
  const request = await runtime(t)
  const response = await request('/search-public?q=Example')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('set-cookie'), null)
  const page = await response.text()
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(page))
  assert.match(page, /50 on this page/)
  assert.doesNotMatch(page, /private@example|private-owner|<script|name="csrf"/)
  const next = page.match(/rel="next" href="([^"]+)"/)[1].replaceAll('&amp;', '&')
  const final = await request(next)
  assert.equal(final.status, 200)
  const last = await final.text()
  assert.match(last, /5 on this page/)
  assert.doesNotMatch(last, /rel="next"/)

  const malicious = await runtime(t, async () => ({ ...snapshot(), profiles: [{ ...profile('a/<"', '<img src=x onerror=alert(1)>'), headline: 'script engineer' }] }))
  const escaped = await (await malicious('/search-public?q=%3Cscript%3E')).text()
  assert.doesNotMatch(escaped, /<img|<script/)
  assert.match(escaped, /&lt;script&gt;/)
  assert.match(escaped, /&lt;img/)
  assert.match(escaped, /href="\/people\/a%2F%3C%22"/)
})

test('public HEAD probes succeed without bodies; private routes and unsupported methods stay denied', async t => {
  const request = await runtime(t)
  for (const path of ['/', '/people?q=Example', '/network?q=Example', '/search-public?q=Example', '/people/p0', '/people/p0/connections', '/api/people', '/api/people/p0']) {
    const head = await request(path, { method: 'HEAD' })
    assert.equal(head.status, 200, path)
    assert.equal(await head.text(), '')
    assert.equal(head.headers.get('set-cookie'), null)
  }
  assert.equal((await request('/people/missing', { method: 'HEAD' })).status, 404)
  for (const path of ['/settings', '/api/my-connections', '/imports/private', '/login', '/c/private']) {
    assert.equal((await request(path, { method: 'HEAD' })).status, 405, path)
  }
  assert.equal((await request('/search-public', { method: 'PUT' })).status, 405)
})

test('invalid public input and unavailable or revoked publications fail closed', async t => {
  const request = await runtime(t)
  for (const path of ['/search-public?q=a&q=b', '/search-public?q=' + 'x'.repeat(201), '/search-public?cursor=bad', '/search-public?mode=private', '/search-public?presence=private']) {
    assert.equal((await request(path)).status, 400, path)
  }
  let published = snapshot()
  const revocable = await runtime(t, async () => published)
  assert.equal((await revocable('/search-public')).status, 200)
  published = { ...published, state: 'revoked' }
  assert.equal((await revocable('/search-public')).status, 503)
  const unavailable = await runtime(t, async () => { throw Error('unavailable') })
  assert.equal((await unavailable('/search-public')).status, 503)
})

test('small fetch bursts share a snapshot read and remain bounded', async t => {
  let release, started, reads = 0
  const block = new Promise(resolve => { release = resolve })
  const begun = new Promise(resolve => { started = resolve })
  const request = await runtime(t, async () => { reads++; started(); await block; return snapshot() })
  const burst = Array.from({ length: 8 }, () => request('/search-public?q=Example'))
  await begun
  // All earlier requests are admitted or rejected before the ninth response.
  const ninth = await request('/search-public?q=Example')
  try {
    assert.equal(ninth.status, 429)
    assert.equal(ninth.headers.get('retry-after'), '10')
  } finally { release() }
  assert.deepEqual((await Promise.all(burst)).map(response => response.status), Array(8).fill(200))
  assert.equal(reads, 1)
})
