import test from 'node:test'
import assert from 'node:assert/strict'
import { startPrivatePilot } from '../mcp-server/private-pilot.mjs'

test('container wildcard binding requires explicit private origin, service port and mode', async () => {
  const options = { baseUrl: 'https://private.unlinked.ai', host: '0.0.0.0', port: 9367, complete: async () => {} }
  for (const change of [{}, { networkMode: 'unknown' }, { networkMode: 'isolated-container', baseUrl: 'https://public.invalid' }, { networkMode: 'isolated-container', port: 9368 }, { networkMode: 'isolated-container', host: '192.0.2.1' }]) {
    await assert.rejects(startPrivatePilot({ ...options, ...change }), /explicit_isolated_pilot_configuration_required/)
  }
})
