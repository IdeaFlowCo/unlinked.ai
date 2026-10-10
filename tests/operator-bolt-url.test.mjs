import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { operatorBoltUrl } from '../mcp-server/operator-bolt-url.mjs'

test('operator scripts follow the runtime network mode to the private graph host', () => {
  assert.equal(operatorBoltUrl({ PILOT_NETWORK_MODE: 'shared-noos' }), 'bolt://noos_neo4j:7687')
  assert.equal(operatorBoltUrl({ PILOT_NETWORK_MODE: 'shared-noos', PILOT_BOLT_URL: 'bolt://noos_neo4j:7687' }), 'bolt://noos_neo4j:7687')
  assert.equal(operatorBoltUrl({ PILOT_NETWORK_MODE: 'isolated-container' }), 'bolt://graph:7687')
  assert.equal(operatorBoltUrl({ PILOT_NETWORK_MODE: 'loopback' }), 'bolt://127.0.0.1:9289')
  assert.equal(operatorBoltUrl({}), 'bolt://graph:7687')
  assert.throws(() => operatorBoltUrl({ PILOT_NETWORK_MODE: 'elsewhere' }), /operator_network_mode_invalid/)
  assert.throws(() => operatorBoltUrl({ PILOT_NETWORK_MODE: 'shared-noos', PILOT_BOLT_URL: 'bolt://evil:7687' }), /operator_bolt_url_mismatch/)
  assert.throws(() => operatorBoltUrl({ PILOT_NETWORK_MODE: 'shared-noos', PILOT_BOLT_URL: 'bolt://graph:7687' }), /operator_bolt_url_mismatch/)
})

test('no operator script hardcodes the retired graph container', () => {
  for (const name of ['legacy-account-operator', 'legacy-storage-operator', 'profile-decisions-operator', 'publish-company-facts', 'publish-enrichment-people', 'publish-legacy-people', 'publish-profile-photos', 'test-profile-claims-operator']) {
    const source = readFileSync(new URL(`../mcp-server/${name}.mjs`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /bolt:\/\/graph:7687/, name)
    assert.match(source, /neo4j\.driver\(operatorBoltUrl\(\),/, name)
  }
})
