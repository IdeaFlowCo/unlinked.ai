import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { before, after, beforeEach, test } from 'node:test'
import { mkdtemp, rm, stat, readFile, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivatePilotDependencies } from '../mcp-server/private-composition.mjs'
import { createNeo4jCompanyFactsStore } from '../mcp-server/company-facts-store.mjs'
import { COMPANY_DATASET } from '../mcp-server/company-metadata.mjs'
import { encode, decode, digest, exportGraph, exportSharedGraph, importGraph, restoreIsolatedGraph, verifyGraph, rollbackGraph, validateSnapshot } from '../deploy/private-pilot/graph-migration.mjs'

const enabled = process.env.UNLINKED_MIGRATION_TEST === 'isolated-fixture'
const sourceUri = process.env.MIGRATION_TEST_SOURCE_URI || 'bolt://127.0.0.1:8967'
const targetUri = process.env.MIGRATION_TEST_TARGET_URI || 'bolt://127.0.0.1:8968'
let neo4j, source, target
before(async () => {
  if (!enabled) return
  neo4j = createRequire(process.env.MIGRATION_NEO4J_MODULE_ROOT + '/package.json')('neo4j-driver')
  const auth = neo4j.auth.basic('neo4j', 'unlinked-s21-fixture')
  source = neo4j.driver(sourceUri, auth)
  target = neo4j.driver(targetUri, auth)
  await source.verifyConnectivity(); await target.verifyConnectivity()
  for (const [driver, version] of [[source, '5.26.'], [target, '5.15.']]) {
    const component = await query(driver, "CALL dbms.components() YIELD name,versions WHERE name='Neo4j Kernel' RETURN versions[0] AS version")
    assert.ok(component.records[0].get('version').startsWith(version), 'only reviewed disposable cross-version fixtures may be reset')
  }
})
after(async () => { if (source) await source.close(); if (target) await target.close() })
async function query(driver, cypher, params = {}) { const s = driver.session(); try { return await s.run(cypher, params) } finally { await s.close() } }
beforeEach(async () => {
  if (!enabled) return
  for (const d of [source, target]) {
    await query(d, 'MATCH (n) DETACH DELETE n')
    for (const record of (await query(d, 'SHOW CONSTRAINTS YIELD name RETURN name')).records) await query(d, 'DROP CONSTRAINT `' + record.get('name').replaceAll('`', '``') + '`')
    for (const record of (await query(d, "SHOW INDEXES YIELD name,type WHERE type <> 'LOOKUP' RETURN name")).records) await query(d, 'DROP INDEX `' + record.get('name').replaceAll('`', '``') + '`')
  }
  await query(source, 'CREATE CONSTRAINT fixture_resource_id IF NOT EXISTS FOR (n:OperationalResource) REQUIRE n.id IS UNIQUE')
  await query(source, 'CREATE RANGE INDEX fixture_resource_owner IF NOT EXISTS FOR (n:OperationalResource) ON (n.owner)')
  for (const label of ['UnlinkedEmailInviteLock', 'UnlinkedEmailSend', 'UnlinkedEmailSuppression', 'UnlinkedMemberInvitation']) {
    await query(source, `CREATE CONSTRAINT empty_${label} FOR (n:${label}) REQUIRE n.id IS UNIQUE`)
  }
  await query(source, 'CREATE (n:OperationalResource) SET n=$p', { p: { id: 'private-note', owner: 'owner-one', text: 'Synthetic private fixture', count: neo4j.int('9223372036854775807'), date: new neo4j.types.Date(2026, 10, 7), bytes: new Int8Array([0, -1, 20]), tags: ['one', 'two'], score: 1.25 } })
  await query(target, "CREATE (n:Node {id:'existing-main-record',content:'Preserve me'})")
})
const check = (name, fn) => test(name, { skip: !enabled }, fn)
check('real shared composition activates verified 5.15 checkpoint before provisioning and fences rollback on restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'unlinked-activation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await exportGraph(source, neo4j)
  let provisioningCalls = 0
  const options = { root, baseUrl: 'https://www.unlinked.ai', host: '127.0.0.1', operationalPort: 9022,
    boltUrl: 'bolt://noos_neo4j:7687', networkMode: 'shared-noos', dataMode: 'synthetic',
    sharedGraphMigrationId: 'fixture-activation', sharedGraphManifestSha256: snapshot.manifestHash,
    config: { issuer: 'https://identity.invalid', clientId: 'synthetic', clientSecret: 'synthetic', graphPassword: 'synthetic', apiKey: 'synthetic' },
    modules: { neo4j: { ...neo4j, driver: () => ({ verifyConnectivity: () => target.verifyConnectivity(), session: options => target.session(options), close: async () => {} }) },
      OperationalStore: class {}, InvitedOwnerProvisioner: class { async initialize() { provisioningCalls++; throw new Error('intentional_provisioning_stop') } } } }
  await assert.rejects(createPrivatePilotDependencies(options), /shared_graph_verified_migration_required/)
  assert.equal(provisioningCalls, 0)
  await importGraph(target, neo4j, snapshot, 'fixture-activation')
  await assert.rejects(createPrivatePilotDependencies(options), /intentional_provisioning_stop/)
  const first = (await query(target, 'MATCH (m:UnlinkedGraphMigration {id:$id}) RETURN m.activatedAt AS activatedAt,m.status AS status', { id: 'fixture-activation' })).records[0]
  assert.ok(neo4j.isInt(first.get('activatedAt')))
  assert.equal(first.get('status'), 'verified')
  await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-activation'), /migration_conflict/)
  await assert.rejects(createPrivatePilotDependencies(options), /intentional_provisioning_stop/)
  const second = (await query(target, 'MATCH (m:UnlinkedGraphMigration {id:$id}) RETURN m.activatedAt AS activatedAt', { id: 'fixture-activation' })).records[0]
  assert.ok(first.get('activatedAt').equals(second.get('activatedAt')))
  assert.equal(provisioningCalls, 2)
})
check('codec survives JSON for all supported Neo4j property types', () => {
  const values = [neo4j.int('-9223372036854775808'), 0, -0, 1.5, Infinity, -Infinity, NaN, true, 'string', new Int8Array([-128, 0, 127]), [neo4j.int(1), neo4j.int(2)],
    new neo4j.types.Date(2026, 10, 7), new neo4j.types.LocalTime(3, 4, 5, 6), new neo4j.types.Time(3, 4, 5, 6, -7200),
    new neo4j.types.LocalDateTime(2026, 10, 7, 3, 4, 5, 6), new neo4j.types.DateTime(2026, 10, 7, 3, 4, 5, 6, 3600),
    new neo4j.types.DateTime(2026, 10, 7, 3, 4, 5, 6, undefined, 'Europe/London'), new neo4j.types.Duration(1, 2, 3, 4),
    new neo4j.types.Point(4326, 1, 2), new neo4j.types.Point(4979, 1, 2, 3)]
  for (const value of values) {
    const encoded = encode(value, neo4j)
    assert.deepEqual(encode(decode(JSON.parse(JSON.stringify(encoded)), neo4j), neo4j), encoded)
  }
})
check('5.26 snapshot restores exactly into5.15, retries, then rolls back without changing main data', async () => {
  const snapshot = JSON.parse(JSON.stringify(await exportGraph(source, neo4j)))
  const first = await importGraph(target, neo4j, snapshot, 'fixture-replay')
  assert.equal(first.status, 'verified')
  assert.deepEqual(await importGraph(target, neo4j, snapshot, 'fixture-replay'), first)
  assert.equal((await verifyGraph(target, neo4j, snapshot, 'fixture-replay')).parity, true)
  await rollbackGraph(target, neo4j, snapshot, 'fixture-replay')
  const result = await query(target, 'MATCH (n:Node) RETURN n.content AS content')
  assert.equal(result.records[0].get('content'), 'Preserve me')
  assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS n')).records[0].get('n').toNumber(), 0)
})
check('source unknown labels, multiple labels, relationships and tampering stop before migration', async () => {
  const snapshot = await exportGraph(source, neo4j)
  snapshot.nodes[0].properties[1].push(['tampered', ['string', 'bad']])
  assert.throws(() => validateSnapshot(snapshot), /hash_mismatch/)
  await query(source, 'CREATE (:User {id:"unexpected"})')
  await assert.rejects(exportGraph(source, neo4j), /unexpected_source_label/)
  await query(source, 'MATCH (n:User) DELETE n')
  await query(source, 'MATCH (n:OperationalResource) SET n:Node')
  await assert.rejects(exportGraph(source, neo4j), /unexpected_source_label/)
  await query(source, 'MATCH (n:OperationalResource) REMOVE n:Node CREATE (n)-[:UNEXPECTED]->(n)')
  await assert.rejects(exportGraph(source, neo4j), /unexpected_source_relationships/)
})
check('target-domain collisions never merge or overwrite existing identities', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await query(target, 'CREATE (:UnlinkedSession {id:"another-session"})')
  await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-collision'), /target_domain_exists/)
  assert.equal((await query(target, 'MATCH (n:UnlinkedSession) RETURN n.id AS id')).records[0].get('id'), 'another-session')
})
check('partial batch failure leaves a resumable ledger and supports bounded rollback', async () => {
  const snapshot = await exportGraph(source, neo4j), row = snapshot.nodes[0]
  snapshot.nodes = Array.from({ length: 27 }, (_, i) => ({ sourceId: String(i).padStart(3, '0'), label: row.label,
    properties: encode({ id: 'row-' + (i === 26 ? 0 : i), owner: 'one' }, neo4j) }))
  snapshot.manifestHash = digest({ version: 1, nodes: snapshot.nodes, schema: snapshot.schema, relationshipCount: 0 })
  await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-partial'))
  assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS n')).records[0].get('n').toNumber(), 25)
  await rollbackGraph(target, neo4j, snapshot, 'fixture-partial')
  assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS n')).records[0].get('n').toNumber(), 0)
})
check('later edits and activation fence destructive rollback', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-later-edit')
  await query(target, 'MATCH (n:OperationalResource) SET n.text="A later edit"')
  await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-later-edit'), /rollback_later_edit/)
  await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-later-edit'), /imported_record_changed/)
  await query(target, 'MATCH (m:UnlinkedGraphMigration) SET m.activatedAt="now"')
  await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-later-edit'), /migration_conflict/)
})
check('later relationships block rollback; missing schema fails verification', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-schema')
  await query(target, 'MATCH (n:OperationalResource),(other:Node) CREATE (n)-[:LATER_REFERENCE]->(other)')
  await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-schema'), /rollback_later_relationship/)
  await query(target, 'DROP INDEX fixture_resource_owner')
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-schema'), /target_schema_conflict/)
})

check('target schema rejects unexpected domain indexes during import and verification but permits unrelated schema', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await query(target, 'CREATE TEXT INDEX unrelated_text FOR (n:Node) ON (n.content)')
  for (const type of ['TEXT', 'RANGE']) {
    await query(target, `CREATE ${type} INDEX extra_domain FOR (n:OperationalResource) ON (n.text)`)
    await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-extra-schema'), /target_schema_conflict/)
    assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS count')).records[0].get('count').toNumber(), 0)
    await query(target, 'DROP INDEX extra_domain')
  }
  await importGraph(target, neo4j, snapshot, 'fixture-extra-schema')
  await query(target, 'CREATE TEXT INDEX extra_domain FOR (n:OperationalResource) ON (n.text)')
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-extra-schema'), /target_schema_conflict/)
  await query(target, 'DROP INDEX extra_domain')
  assert.equal((await verifyGraph(target, neo4j, snapshot, 'fixture-extra-schema')).parity, true)
  assert.deepEqual((await exportSharedGraph(target, neo4j, 'fixture-extra-schema')).schema, snapshot.schema)
})

check('rollback rejects malformed ledger edges and preserves their endpoints', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-ledger-edges')
  for (const edge of [
    'MATCH (n:OperationalResource),(other:Node) CREATE (n)-[:UNLINKED_IMPORTED_RECORD {later:true}]->(other)',
    'MATCH (n:OperationalResource),(other:Node) CREATE (other)-[:UNLINKED_IMPORTED_RECORD {later:true}]->(n)',
    'MATCH (n:OperationalResource) CREATE (:UnlinkedGraphMigrationRecord)-[:UNLINKED_IMPORTED_RECORD {later:true}]->(n)',
    "MATCH (n:OperationalResource) CREATE (:UnlinkedGraphMigrationRecord {migrationId:'foreign'})-[:UNLINKED_IMPORTED_RECORD {later:true}]->(n)",
    "MATCH (n:OperationalResource) CREATE (:Node {migrationId:'fixture-ledger-edges'})-[:UNLINKED_IMPORTED_RECORD {later:true}]->(n)",
    'MATCH (n:OperationalResource) CREATE (n)-[:UNLINKED_IMPORTED_RECORD {later:true}]->(n)',
    "MATCH (m:UnlinkedGraphMigrationRecord {migrationId:'fixture-ledger-edges'}),(other:Node {id:'existing-main-record'}) CREATE (m)-[:LATER_REFERENCE {later:true}]->(other)",
  ]) {
    await query(target, edge)
    await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-ledger-edges'), /rollback_later_relationship/)
    assert.equal((await query(target, 'MATCH ()-[r {later:true}]->() RETURN count(r) AS count')).records[0].get('count').toNumber(), 1)
    assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS count')).records[0].get('count').toNumber(), 1)
    assert.equal((await query(target, "MATCH (n:Node {id:'existing-main-record'}) RETURN n.content AS content")).records[0].get('content'), 'Preserve me')
    await query(target, 'MATCH ()-[r {later:true}]->() DELETE r')
  }
  await query(target, "MATCH (m:UnlinkedGraphMigrationRecord {migrationId:'fixture-ledger-edges'})-[:UNLINKED_IMPORTED_RECORD]->() SET m:Node")
  await assert.rejects(rollbackGraph(target, neo4j, snapshot, 'fixture-ledger-edges'), /rollback_later_relationship/)
  await query(target, "MATCH (m:UnlinkedGraphMigrationRecord {migrationId:'fixture-ledger-edges'}) REMOVE m:Node")
  assert.equal((await rollbackGraph(target, neo4j, snapshot, 'fixture-ledger-edges')).status, 'rolled-back')
})

check('company revocation removes migrated live pointers in shared and restored isolated graphs', async () => {
  const originalStore = createNeo4jCompanyFactsStore(source)
  await originalStore.initialize()
  const companies = [{ name: 'Synthetic Fixture Company', description: 'Operator-published fixture' }]
  const { revision } = await originalStore.publish(COMPANY_DATASET, companies, 'a'.repeat(64))
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-company')
  const reverse = await exportSharedGraph(target, neo4j, 'fixture-company')
  await query(source, 'MATCH (n) DETACH DELETE n')
  await restoreIsolatedGraph(source, neo4j, reverse, 'fixture-company-restored')
  for (const driver of [target, source]) {
    const store = createNeo4jCompanyFactsStore(driver)
    await store.initialize()
    assert.deepEqual((await store.read()).companies, companies)
    await store.revoke(COMPANY_DATASET, revision)
    assert.equal(await store.read(), null)
    assert.equal((await query(driver, 'MATCH (p:UnlinkedCompanyDataset) RETURN count(p) AS count')).records[0].get('count').toNumber(), 0)
    assert.equal((await query(driver, 'MATCH (r:UnlinkedCompanyRevision) RETURN r.state AS state')).records[0].get('state'), 'deleted')
    assert.equal((await query(driver, 'MATCH (c:UnlinkedCompanyChunk) RETURN count(c) AS count')).records[0].get('count').toNumber(), 1)
  }
  const revoked = await exportSharedGraph(target, neo4j, 'fixture-company')
  assert.equal(revoked.nodes.some(node => node.label === 'UnlinkedCompanyDataset'), false)
})

check('shared reverse backup preserves later edits, additions and deletions while excluding unrelated Noos data', async () => {
  await query(source, "CREATE (:UnlinkedNotification {id:'deleted-after-cutover',text:'original'})")
  const original = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, original, 'fixture-reverse')
  await query(target, "MATCH (m:UnlinkedGraphMigration) SET m.activatedAt=timestamp()")
  await query(target, "MATCH (n:OperationalResource) SET n.text='postactivation edit',n.tombstone=true")
  await query(target, "MATCH (n:UnlinkedNotification) DETACH DELETE n")
  await query(target, 'CREATE (n:UnlinkedSession) SET n=$properties', { properties: { id: 'postactivation-session', owner: 'owner-one', expiresAt: neo4j.int('99999999999999') } })
  await query(target, "CREATE CONSTRAINT unrelated_main_id FOR (n:Node) REQUIRE n.id IS UNIQUE")
  const reverse = JSON.parse(JSON.stringify(await exportSharedGraph(target, neo4j, 'fixture-reverse')))
  assert.equal(reverse.nodes.length, 2)
  assert.deepEqual(reverse.nodes.map(n => n.label).sort(), ['OperationalResource', 'UnlinkedSession'])
  assert.deepEqual(reverse.schema, original.schema)
  await assert.rejects(restoreIsolatedGraph(target, neo4j, reverse, 'fixture-restored'), /isolated_recovery_target_not_empty/)
  await query(source, 'MATCH (n) DETACH DELETE n')
  const restored = await restoreIsolatedGraph(source, neo4j, reverse, 'fixture-restored')
  assert.equal(restored.status, 'verified')
  assert.equal((await verifyGraph(source, neo4j, reverse, 'fixture-restored')).parity, true)
  assert.deepEqual(await restoreIsolatedGraph(source, neo4j, reverse, 'fixture-restored'), restored)
  await assert.rejects(rollbackGraph(source, neo4j, reverse, 'fixture-restored'), /migration_conflict/)
  const resource = (await query(source, 'MATCH (n:OperationalResource) RETURN n.text AS text,n.tombstone AS tombstone')).records[0]
  assert.equal(resource.get('text'), 'postactivation edit')
  assert.equal(resource.get('tombstone'), true)
  assert.equal((await query(source, 'MATCH (n:UnlinkedNotification) RETURN count(n) AS count')).records[0].get('count').toNumber(), 0)
  assert.equal((await query(target, 'MATCH (n:Node) RETURN n.content AS content')).records[0].get('content'), 'Preserve me')
})
check('shared export refuses wrong receipt, multi-labels, foreign or malformed ledger edges and scoped unsupported schema', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-scoped')
  await assert.rejects(exportSharedGraph(target, neo4j, 'missing'), /shared_export_verified_migration_required/)
  await query(target, 'MATCH (n:OperationalResource) SET n:Node')
  await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-scoped'))
  await query(target, 'MATCH (n:OperationalResource) REMOVE n:Node')
  for (const edge of [
    'MATCH (n:OperationalResource),(other:Node) CREATE (n)-[:OTHER]->(other)',
    'MATCH (n:OperationalResource) CREATE (record:UnlinkedGraphMigrationRecord)-[:UNLINKED_IMPORTED_RECORD]->(n)',
    "MATCH (n:OperationalResource) CREATE (:UnlinkedGraphMigrationRecord {migrationId:'another-run'})-[:UNLINKED_IMPORTED_RECORD]->(n)",
    'MATCH (n:OperationalResource) CREATE (n)-[:UNLINKED_IMPORTED_RECORD]->(n)',
  ]) {
    await query(target, edge)
    await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-scoped'), /unexpected_source_relationships/)
    await query(target, "MATCH (a)-[r]->(b) WHERE type(r) <> 'UNLINKED_IMPORTED_RECORD' OR NOT coalesce(a.migrationId='fixture-scoped',false) DELETE r")
  }
  await query(target, 'CREATE TEXT INDEX unsupported_private_text FOR (n:OperationalResource) ON (n.text)')
  await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-scoped'), /unsupported_schema/)
})
check('isolated recovery refuses malformed metadata and unrelated nodes without writing', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await query(target, 'MATCH (n) DETACH DELETE n CREATE (:UnlinkedGraphMigrationRecord)')
  await assert.rejects(restoreIsolatedGraph(target, neo4j, snapshot, 'fixture-empty'), /isolated_recovery_target_not_empty/)
  assert.equal((await query(target, 'MATCH (n:OperationalResource) RETURN count(n) AS count')).records[0].get('count').toNumber(), 0)
})

check('empty source email and invitation schema survives copy and supports later shared writes', async () => {
  const snapshot = await exportGraph(source, neo4j)
  const emptyLabels = ['UnlinkedEmailInviteLock', 'UnlinkedEmailSend', 'UnlinkedEmailSuppression', 'UnlinkedMemberInvitation']
  for (const label of emptyLabels) assert.ok(snapshot.schema.some(entry => entry.labelsOrTypes[0] === label))
  await importGraph(target, neo4j, snapshot, 'fixture-empty-schema')
  for (const label of emptyLabels) await query(target, `CREATE (:${label} {id:'postactivation'})`)
  const reverse = await exportSharedGraph(target, neo4j, 'fixture-empty-schema')
  for (const label of emptyLabels) {
    assert.ok(reverse.nodes.some(node => node.label === label))
    assert.ok(reverse.schema.some(entry => entry.labelsOrTypes[0] === label))
  }
})
check('operator CLI exports private shared snapshots and refuses overwrite or symlink inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'unlinked-operator-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-cli')
  const file = join(directory, 'reverse.private.json')
  const env = { ...process.env, MIGRATION_NEO4J_URI: targetUri, MIGRATION_NEO4J_USER: 'neo4j', MIGRATION_NEO4J_PASSWORD: 'unlinked-s21-fixture' }
  const run = (...args) => promisify(execFile)(process.execPath, ['deploy/private-pilot/graph-migration-cli.mjs', ...args], { env })
  const exported = await run('export-shared', file, 'fixture-cli')
  assert.deepEqual(Object.keys(JSON.parse(exported.stdout)).sort(), ['action', 'manifestHash', 'nodes'])
  assert.equal(JSON.parse(exported.stdout).nodes, 1)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const saved = await readFile(file, 'utf8')
  assert.equal(validateSnapshot(JSON.parse(saved)), JSON.parse(exported.stdout).manifestHash)
  await assert.rejects(run('export-shared', file, 'fixture-cli'))
  assert.equal(await readFile(file, 'utf8'), saved)
  const link = join(directory, 'snapshot-link.json')
  await symlink(file, link)
  await assert.rejects(run('verify', link, 'fixture-cli'), error => {
    assert.match(error.stderr, /private_regular_snapshot_required/)
    assert.ok(!error.stderr.includes('Synthetic private fixture'))
    return true
  })
})
check('verification and import retry reject foreign domain relationships before certifying a checkpoint', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-verification-edges')
  await query(target, 'MATCH (n:OperationalResource),(other:Node) CREATE (n)-[:OTHER]->(other)')
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-edges'), /unexpected_target_relationships/)
  await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-verification-edges'), /unexpected_target_relationships/)
  assert.equal((await query(target, 'MATCH (m:UnlinkedGraphMigration) RETURN m.status AS status')).records[0].get('status'), 'copying')
  await query(target, 'MATCH ()-[r:OTHER]->() DELETE r')
  await importGraph(target, neo4j, snapshot, 'fixture-verification-edges')
  assert.equal((await verifyGraph(target, neo4j, snapshot, 'fixture-verification-edges')).parity, true)
  await query(target, 'MATCH (m:UnlinkedGraphMigration),(other:Node) CREATE (m)-[:UNKNOWN]->(other)')
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-edges'), /unexpected_target_relationships/)
})
check('standalone verification requires exact verified receipt and authentic complete ledger', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-verification-ledger')
  for (const mutation of [
    "SET m.manifestHash='wrong-hash'", "SET m.status='copying'", "SET m.status='rolled-back'", 'SET m:Other',
  ]) {
    await query(target, `MATCH (m:UnlinkedGraphMigration) ${mutation}`)
    await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-ledger'), /migration_checkpoint_invalid/)
    await query(target, "MATCH (m:UnlinkedGraphMigration) SET m.manifestHash=$hash,m.status='verified' REMOVE m:Other", { hash: snapshot.manifestHash })
  }
  await query(target, "MATCH (m:UnlinkedGraphMigrationRecord) SET m.hash='wrong-hash'")
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-ledger'), /migration_ledger_invalid/)
  await query(target, 'MATCH (m:UnlinkedGraphMigrationRecord) SET m.hash=$hash,m:Other', { hash: digest(snapshot.nodes[0]) })
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-ledger'), /unexpected_target_relationships|migration_ledger_invalid/)
  await query(target, 'MATCH (m:UnlinkedGraphMigrationRecord) REMOVE m:Other')
  await query(target, "CREATE (:UnlinkedGraphMigrationRecord {migrationId:'fixture-verification-ledger',sourceId:'orphan',hash:'fake'})")
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-ledger'), /migration_ledger_invalid/)
  await query(target, "MATCH (m:UnlinkedGraphMigrationRecord {sourceId:'orphan'}) DELETE m")
  await query(target, "MATCH (m:UnlinkedGraphMigrationRecord) SET m.migrationId='foreign-receipt'")
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-verification-ledger'), /unexpected_target_relationships/)
})
check('shared recovery refuses unknown private domains and empty schema instead of dropping future writes', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-future-domain')
  await query(target, 'CREATE (:UnlinkedFuture {privateNote:"Do not silently discard"})')
  await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-future-domain'), /unexpected_private_domain_label/)
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-future-domain'), /unexpected_private_domain_label/)
  await query(target, 'MATCH (n:UnlinkedFuture) DELETE n')
  await query(target, 'CREATE RANGE INDEX future_private_schema FOR (n:OperationalFuture) ON (n.id)')
  await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-future-domain'), /unsupported_schema/)
  await assert.rejects(verifyGraph(target, neo4j, snapshot, 'fixture-future-domain'), /target_schema_conflict/)
})
check('OpenChat accepted-connection receipts are external: shared export, import and verification ignore and preserve them', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await importGraph(target, neo4j, snapshot, 'fixture-openchat-receipt')
  await query(target, 'CREATE CONSTRAINT unlinked_connection_sync_request IF NOT EXISTS FOR (receipt:UnlinkedConnectionSync) REQUIRE receipt.requestId IS UNIQUE')
  await query(target, "CREATE (:UnlinkedConnectionSync {requestId:'fixture-request', status:'synced'})")
  const shared = await exportSharedGraph(target, neo4j, 'fixture-openchat-receipt')
  assert.equal(shared.nodes.some(node => node.label === 'UnlinkedConnectionSync'), false)
  assert.equal(shared.schema.some(entry => entry.labelsOrTypes.includes('UnlinkedConnectionSync')), false)
  assert.equal((await verifyGraph(target, neo4j, snapshot, 'fixture-openchat-receipt')).parity, true)
  assert.equal((await query(target, 'MATCH (n:UnlinkedConnectionSync) RETURN n.requestId AS id')).records[0].get('id'), 'fixture-request')
  // A different unknown Unlinked label is still refused.
  await query(target, 'CREATE (:UnlinkedConnectionSyncFuture {id:"x"})')
  await assert.rejects(exportSharedGraph(target, neo4j, 'fixture-openchat-receipt'), /unexpected_private_domain_label/)
})
check('unknown private target domain aborts before a new migration creates any receipt or copied record', async () => {
  const snapshot = await exportGraph(source, neo4j)
  await query(target, 'CREATE (:OperationalFuture {id:"preserve"})')
  await assert.rejects(importGraph(target, neo4j, snapshot, 'fixture-unknown-target'), /unexpected_private_domain_label/)
  assert.equal((await query(target, 'MATCH (m:UnlinkedGraphMigration) RETURN count(m) AS count')).records[0].get('count').toNumber(), 0)
  assert.equal((await query(target, 'MATCH (n:OperationalFuture) RETURN n.id AS id')).records[0].get('id'), 'preserve')
})
