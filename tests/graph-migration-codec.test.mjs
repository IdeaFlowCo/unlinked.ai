import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { encode, decode, digest, validateSnapshot } from '../deploy/private-pilot/graph-migration.mjs'

// Run the native codec contract without resetting a database. The same explicit
// reviewed driver checkout as the cross-version fixture is required.
const root = process.env.MIGRATION_NEO4J_MODULE_ROOT
test('migration snapshot JSON preserves native values without database writes', { skip: !root }, () => {
  const neo4j = createRequire(root + '/package.json')('neo4j-driver')
  const values = [neo4j.int('-9223372036854775808'), neo4j.int('9223372036854775807'),
    0, -0, 1.5, Infinity, -Infinity, NaN, true, 'fixture', new Int8Array([-128, 0, 127]),
    [neo4j.int(1), neo4j.int(2)], new neo4j.types.Date(2026, 10, 7),
    new neo4j.types.LocalTime(3, 4, 5, 6), new neo4j.types.Time(3, 4, 5, 6, -7200),
    new neo4j.types.LocalDateTime(2026, 10, 7, 3, 4, 5, 6),
    new neo4j.types.DateTime(2026, 10, 7, 3, 4, 5, 6, 3600),
    new neo4j.types.DateTime(2026, 10, 7, 3, 4, 5, 6, undefined, 'Europe/London'),
    new neo4j.types.Duration(1, 2, 3, 4), new neo4j.types.Point(4326, 1, 2),
    new neo4j.types.Point(4979, 1, 2, 3)]
  for (const value of values) {
    const properties = encode({ value }, neo4j)
    const payload = { version: 1, nodes: [{ sourceId: 'fixture', label: 'OperationalResource', properties }], schema: [], relationshipCount: 0 }
    const snapshot = JSON.parse(JSON.stringify({ ...payload, manifestHash: digest(payload) }))
    assert.equal(validateSnapshot(snapshot), digest(payload))
    assert.deepEqual(encode(decode(snapshot.nodes[0].properties, neo4j), neo4j), properties)
    snapshot.nodes[0].properties = encode({ value: 'tampered' }, neo4j)
    assert.throws(() => validateSnapshot(snapshot), /snapshot_hash_mismatch/)
  }
})
