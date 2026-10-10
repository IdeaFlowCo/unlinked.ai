import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'

// `map $uri $name { ~regex value; default value; }` blocks, evaluated the way
// nginx does for these configs: regexes in order, else the default.
function parseUriMaps(config) {
  const maps = new Map()
  for (const block of config.matchAll(/^\s*map\s+\$uri\s+\$([a-z_]+)\s*\{([^}]*)\}/gm)) {
    const rules = [], fallback = { value: undefined }
    for (const line of block[2].matchAll(/^\s*(\S+)\s+("[^"]*"|[^;\s]+)\s*;/gm)) {
      const value = line[2].startsWith('"') ? line[2].slice(1, -1) : line[2]
      if (line[1] === 'default') fallback.value = value
      else { assert.ok(line[1].startsWith('~'), 'only regex map keys are expected'); rules.push([new RegExp(line[1].slice(1)), value]) }
    }
    maps.set(block[1], uri => rules.find(([pattern]) => pattern.test(uri))?.[1] ?? fallback.value)
  }
  return maps
}

// The headers nginx adds for one path: variables resolved through their map;
// an empty value adds nothing.
function parseServerHeaders(config, uri = '/') {
  const headers = [], maps = parseUriMaps(config)
  for (const match of config.matchAll(/^\s*add_header\s+([A-Za-z0-9-]+)\s+([^;\s]+)\s+always\s*;/gm)) {
    const value = match[2].startsWith('$') ? maps.get(match[2].slice(1))?.(uri) : match[2]
    assert.notEqual(value, undefined, `unresolved header variable ${match[2]}`)
    if (value) headers.push([match[1], value])
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

test('rollback-host ingress keeps no-store; canonical ingress adds no cache header so the runtime owns back/forward-cache eligibility', async () => {
  for (const file of ['nginx.conf', 'nginx.canonical.conf']) {
    const config = await readFile(new URL(`../deploy/private-pilot/${file}`, import.meta.url), 'utf8')
    const cache = uri => parseServerHeaders(config, uri).filter(([name]) => name.toLowerCase() === 'cache-control').map(([, value]) => value)
    // A second no-store from nginx would disable the browser's back/forward
    // cache on the canonical host even after the runtime allows it.
    const expected = file === 'nginx.canonical.conf' ? [] : ['no-store']
    for (const uri of ['/', '/people', '/people/aaaaaaaa-1111-4111-8111-111111111111', '/api/people/aaaaaaaa-1111-4111-8111-111111111111', '/people/a/photo/x', '/people/photo', `/invite/${'a'.repeat(43)}`]) {
      assert.deepEqual(cache(uri), expected, `${file} ${uri}`)
    }
    assert.deepEqual(cache('/people/aaaaaaaa-1111-4111-8111-111111111111/photo'), [], file)
    // Every other security header still applies to photos.
    const names = parseServerHeaders(config, '/people/aaaaaaaa-1111-4111-8111-111111111111/photo').map(([name]) => name)
    assert.deepEqual(names, ['Strict-Transport-Security', 'Referrer-Policy', 'X-Content-Type-Options'], file)
  }
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

test('shared-Noos runtime keeps canonical private ingress restrictions', async () => {
  const options = { baseUrl: 'https://www.unlinked.ai', networkMode: 'shared-noos', host: '0.0.0.0', port: 9367, complete: async () => ({}), signup: 'invalid' }
  await assert.rejects(startPrivatePilot(options), /account_signup_configuration_required/)
  for (const change of [{ host: '127.0.0.1' }, { baseUrl: 'https://foreign.invalid' }, { baseUrl: 'https://www.unlinked.ai.evil.invalid' }, { port: 9368 }]) await assert.rejects(startPrivatePilot({ ...options, ...change }), /explicit_isolated_pilot_configuration_required/)
})
