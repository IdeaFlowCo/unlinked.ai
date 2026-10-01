import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

function parseServerHeaders(config) {
  const headers = []
  for (const match of config.matchAll(/^\s*add_header\s+([A-Za-z0-9-]+)\s+([^;\s]+)\s+always\s*;/gm)) {
    headers.push([match[1], match[2]])
  }
  return headers
}

test('private pilot ingress emits strict-origin referrer policy on proxied responses', async t => {
  const config = await readFile(new URL('../deploy/private-pilot/nginx.conf', import.meta.url), 'utf8')
  const configuredHeaders = parseServerHeaders(config)
  const server = createServer((req, res) => {
    for (const [name, value] of configuredHeaders) res.setHeader(name, value)
    res.end('runtime response')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/invite/${'a'.repeat(43)}`)
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(configuredHeaders.filter(([name]) => name.toLowerCase() === 'referrer-policy'), [['Referrer-Policy', 'strict-origin']])
})
