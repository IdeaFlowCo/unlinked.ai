import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'

function parseServerHeaders(config) {
  const headers = []
  for (const match of config.matchAll(/^\s*add_header\s+([A-Za-z0-9-]+)\s+([^;\s]+)\s+always\s*;/gm)) {
    headers.push([match[1], match[2]])
  }
  return headers
}

function parseIngressHostPolicy(config) {
  const serverName = config.match(/^\s*server_name\s+([^;\s]+)\s*;/m)?.[1]
  const hostPattern = config.match(/^\s*if\s+\(\$http_host\s+!~\s+"([^"]+)"\)\s+\{\s+return\s+444;\s+\}/m)?.[1]
  const upstreamHost = config.match(/^\s*proxy_set_header\s+Host\s+([^;\s]+)\s*;/m)?.[1]
  assert.ok(serverName, 'server_name must be configured')
  assert.ok(hostPattern, 'Host guard must be configured')
  assert.ok(upstreamHost, 'upstream Host header must be configured')
  return { serverName, hostPattern: new RegExp(hostPattern), upstreamHost }
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

test('canonical ingress accepts only the canonical host and forwards that host upstream', async () => {
  const config = await readFile(new URL('../deploy/private-pilot/nginx.canonical.conf', import.meta.url), 'utf8')
  const policy = parseIngressHostPolicy(config)
  assert.equal(policy.serverName, 'www.unlinked.ai')
  assert.equal(policy.upstreamHost, 'www.unlinked.ai')
  assert.equal(policy.hostPattern.test('www.unlinked.ai'), true)
  assert.equal(policy.hostPattern.test('www.unlinked.ai:443'), true)
  assert.equal(policy.hostPattern.test('private.unlinked.ai'), false)
  assert.equal(policy.hostPattern.test('www.unlinked.ai.evil.invalid'), false)
})

test('private ingress remains restricted to the rollback private host', async () => {
  const config = await readFile(new URL('../deploy/private-pilot/nginx.conf', import.meta.url), 'utf8')
  const policy = parseIngressHostPolicy(config)
  assert.equal(policy.serverName, 'private.unlinked.ai')
  assert.equal(policy.upstreamHost, 'private.unlinked.ai')
  assert.equal(policy.hostPattern.test('private.unlinked.ai'), true)
  assert.equal(policy.hostPattern.test('private.unlinked.ai:443'), true)
  assert.equal(policy.hostPattern.test('www.unlinked.ai'), false)
  assert.equal(policy.hostPattern.test('private.unlinked.ai.evil.invalid'), false)
})


test('canonical isolated-runtime origin passes target validation but never bypasses account configuration', async () => {
  const options = { baseUrl: 'https://www.unlinked.ai', networkMode: 'isolated-container', host: '0.0.0.0', port: 9367,
    complete: async () => ({}), signup: 'invalid' }
  // Deliberately stop at the next validation boundary, before any listener.
  await assert.rejects(startPrivatePilot(options), /account_signup_configuration_required/)
  for (const change of [{ baseUrl: 'https://foreign.invalid' }, { baseUrl: 'https://www.unlinked.ai.evil.invalid' },
    { baseUrl: 'http://www.unlinked.ai' }, { baseUrl: 'https://www.unlinked.ai/path' }, { port: 9368 }, { networkMode: 'unknown' }]) {
    await assert.rejects(startPrivatePilot({ ...options, ...change }), /explicit_isolated_pilot_configuration_required/)
  }
})
