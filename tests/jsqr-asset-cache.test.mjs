// The QR decoder is versioned, immutable and deferred: an unversioned no-store
// render-blocking copy (257 KB) was fetched on every /scan and /meet view.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { JSQR_SRC, JSQR_VERSION } from '../mcp-server/public-discovery.mjs'

test('the jsQR decoder is served immutable only at its content version, and pages load it deferred', async t => {
  assert.match(JSQR_VERSION, /^[a-f0-9]{16}$/)
  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: `https://127.0.0.1:${server.address().port}`, login: { begin: async () => {}, finish: async () => {} }, resolveOwner: async () => null, getBackend: async () => { throw Error('unexpected_owner_read') } })
  const versioned = await fetch(endpoint + JSQR_SRC)
  assert.equal(versioned.status, 200)
  assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.match(await versioned.text(), /jsQR/)
  for (const path of ['/public-assets/jsqr.js', '/public-assets/jsqr.js?v=0000000000000000', `${JSQR_SRC}&x=1`]) {
    const response = await fetch(endpoint + path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('cache-control'), 'no-cache', path)
  }
  const meet = await (await fetch(endpoint + '/meet')).text()
  assert.ok(meet.includes(`src="${JSQR_SRC}" defer`))
  assert.ok(!meet.includes('src="/public-assets/jsqr.js"'))
  // Deferred classic scripts run before the (also deferred) module that reads globalThis.jsQR.
  assert.ok(meet.indexOf(JSQR_SRC) < meet.indexOf('type="module"'))
})
