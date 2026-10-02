import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const ROOT = process.cwd()
const read = file => fs.readFileSync(path.join(ROOT, file))

test('manifest, icons and offline page satisfy installability and reference only committed assets', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest').toString())
  assert.equal(manifest.name, 'Unlinked')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#4349c4')
  const sizes = manifest.icons.map(icon => icon.sizes).sort()
  assert.deepEqual(sizes, ['192x192', '512x512', '512x512'])
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'))
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png')
    const bytes = read(`public${icon.src}`)
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon.src} is a PNG`)
    const expected = Number(icon.sizes.split('x')[0])
    assert.equal(bytes.readUInt32BE(16), expected, `${icon.src} width`)
    assert.equal(bytes.readUInt32BE(20), expected, `${icon.src} height`)
  }
  const offline = read('public/offline.html').toString()
  assert.match(offline, /You’re offline/)
  // The precached offline page must contain no personal or member content hooks.
  assert.doesNotMatch(offline, /csrf|session|Signed in|fetch\(|<script/i)
})

test('service worker precaches only the fixed public shell and never caches at runtime', async () => {
  const source = read('public/sw.js').toString()
  // Static guarantees: the only cache writes are the install-time addAll of the shell.
  assert.doesNotMatch(source, /cache\.put|caches\.put/)
  assert.equal((source.match(/addAll/g) ?? []).length, 1)

  const listeners = {}
  const cacheStore = new Map()
  const cache = {
    addAll: async paths => { for (const value of paths) cacheStore.set(value, `cached:${value}`) },
    match: async key => cacheStore.get(key),
  }
  const context = {
    self: { addEventListener: (name, fn) => { listeners[name] = fn }, skipWaiting: async () => {}, clients: { claim: async () => {} }, location: { origin: 'https://www.unlinked.ai' } },
    caches: { open: async () => cache, match: async key => cacheStore.get(key), keys: async () => ['unlinked-public-shell-v0', 'unlinked-public-shell-v1'], delete: async key => { assert.notEqual(key, 'unlinked-public-shell-v1'); return true } },
    fetch: async request => { if (context.networkDown) throw new TypeError('offline'); return `network:${request.url ?? request}` },
    Response: { error: () => 'response-error' },
    URL, console,
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  await new Promise(resolve => listeners.install({ waitUntil: promise => promise.then(resolve) }))
  assert.ok(cacheStore.has('/offline.html'))
  assert.ok(cacheStore.has('/manifest.webmanifest'))
  await new Promise(resolve => listeners.activate({ waitUntil: promise => promise.then(resolve) }))

  const dispatch = request => {
    let responded = null
    listeners.fetch({ request, respondWith: promise => { responded = Promise.resolve(promise) } })
    return responded
  }
  // Non-GET, cross-origin and plain same-origin requests are left to the network untouched.
  assert.equal(dispatch({ method: 'POST', url: 'https://www.unlinked.ai/upload', mode: 'navigate' }), null)
  assert.equal(dispatch({ method: 'GET', url: 'https://fonts.gstatic.com/font.woff2', mode: 'no-cors' }), null)
  assert.equal(dispatch({ method: 'GET', url: 'https://www.unlinked.ai/api/people?q=x', mode: 'cors' }), null)
  assert.equal(dispatch({ method: 'GET', url: 'https://www.unlinked.ai/export', mode: 'cors' }), null)
  // Shell assets come from the precache.
  assert.equal(await dispatch({ method: 'GET', url: 'https://www.unlinked.ai/app-icon-192.png', mode: 'no-cors' }), 'cached:/app-icon-192.png')
  // Navigations hit the network; their responses are never stored.
  const sizeBefore = cacheStore.size
  assert.match(await dispatch({ method: 'GET', url: 'https://www.unlinked.ai/network', mode: 'navigate' }), /^network:/)
  assert.equal(cacheStore.size, sizeBefore, 'no runtime cache writes')
  // Only when the network fails does a navigation fall back to the static offline page.
  context.networkDown = true
  assert.equal(await dispatch({ method: 'GET', url: 'https://www.unlinked.ai/settings', mode: 'navigate' }), 'cached:/offline.html')
  assert.equal(cacheStore.size, sizeBefore)
  // An evicted precache degrades to a plain network error, never a broken undefined response.
  cacheStore.delete('/offline.html')
  assert.equal(await dispatch({ method: 'GET', url: 'https://www.unlinked.ai/settings', mode: 'navigate' }), 'response-error')
})

test('journey pages carry the manifest, worker registration and the extended-but-strict CSP', async t => {
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: `https://127.0.0.1:${server.address().port}`,
    login: { begin: async () => ({ location: 'https://x.invalid', transaction: {} }), finish: async () => ({}) },
    resolveOwner: async () => null, getBackend: async () => { throw new Error('unexpected') } })
  // The worker script itself is never HTTP-cacheable, so VERSION bumps reach clients.
  const worker = await fetch(`${endpoint}/sw.js`)
  assert.equal(worker.status, 200)
  assert.equal(worker.headers.get('cache-control'), 'no-store')
  // The worker executes under /sw.js's OWN CSP. It must allow the worker's
  // same-origin fetches (precache addAll + network pass-through) and nothing
  // else; the page default (no connect-src) would block every fetch inside
  // the worker and break installability.
  const workerCsp = worker.headers.get('content-security-policy')
  assert.match(workerCsp, /default-src 'none'/)
  assert.match(workerCsp, /connect-src 'self'/)
  assert.doesNotMatch(workerCsp, /unsafe-inline|data:|https:/)
  // Everything the worker fetches is same-origin, which connect-src 'self' covers.
  const swSource = read('public/sw.js').toString()
  for (const match of swSource.matchAll(/'(\/[a-z0-9.\-]+)'/gi)) assert.ok(!match[1].includes('//'), 'precache paths are same-origin')
  const page = await fetch(endpoint)
  const csp = page.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /manifest-src 'self'/)
  assert.match(csp, /worker-src 'self'/)
  // Icons (rel=icon, apple-touch-icon and the manifest's PNGs) are governed by
  // img-src on the installing page; without it the install prompt has no icon.
  assert.match(csp, /img-src 'self'/)
  assert.doesNotMatch(csp, /data:|unsafe-eval/)
  const html = await page.text()
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/)
  assert.match(html, /<link rel="apple-touch-icon" href="\/app-icon-192.png">/)
  assert.match(html, /<meta name="theme-color" content="#4349c4">/)
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'\)/)
  // The registration script runs under the page nonce, not an unsafe allowance.
  const nonce = html.match(/<script nonce="([^"]+)">/)[1]
  assert.ok(csp.includes(`'nonce-${nonce}'`))
})
