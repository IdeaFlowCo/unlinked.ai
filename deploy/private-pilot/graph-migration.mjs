import { createHash } from 'node:crypto'

// This is an intentionally bounded migration, not an arbitrary graph importer.
export const LABELS = Object.freeze([
  'OperationalResource', 'OperationalBindingLock', 'OperationalIdentity', 'OperationalOwner', 'OperationalInvitation',
  'UnlinkedPublicChunk', 'UnlinkedProfileDecision', 'UnlinkedLegacyAccount', 'UnlinkedSession',
  'UnlinkedPublicRevision', 'UnlinkedCompanyChunk', 'UnlinkedEmailRecipient', 'UnlinkedPublicDataset',
  'UnlinkedNotification', 'UnlinkedSignupLookup', 'UnlinkedSignupCache', 'UnlinkedCompanyRevision',
  'UnlinkedSignupProfile', 'UnlinkedContactCard', 'UnlinkedConnectionRequest', 'UnlinkedLegacyManifest',
  'UnlinkedLegacyStorage', 'UnlinkedCompanyDataset', 'UnlinkedSignupGate',
  // Reviewed source schema exists for these currently empty domains. Later
  // email/invitation writes must remain included in shared recovery snapshots.
  'UnlinkedEmailInviteLock', 'UnlinkedEmailSend', 'UnlinkedEmailSuppression', 'UnlinkedMemberInvitation',
])
const temporal = {
  Date: ['year', 'month', 'day'], LocalTime: ['hour', 'minute', 'second', 'nanosecond'],
  Time: ['hour', 'minute', 'second', 'nanosecond', 'timeZoneOffsetSeconds'],
  LocalDateTime: ['year', 'month', 'day', 'hour', 'minute', 'second', 'nanosecond'],
  DateTime: ['year', 'month', 'day', 'hour', 'minute', 'second', 'nanosecond', 'timeZoneOffsetSeconds', 'timeZoneId'],
  Duration: ['months', 'days', 'seconds', 'nanoseconds'], Point: ['srid', 'x', 'y', 'z'],
}
export function encode(value, neo4j) {
  if (value == null) return ['null']
  if (neo4j.isInt(value)) return ['integer', value.toString()]
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)]
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value]
  if (value instanceof Int8Array) return ['bytes', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')]
  if (Array.isArray(value)) return ['array', value.map(v => encode(v, neo4j))]
  for (const [name, fields] of Object.entries(temporal)) {
    if (neo4j.types[name] && value instanceof neo4j.types[name]) return [name, fields.map(k => encode(value[k], neo4j))]
  }
  if (Object.getPrototypeOf(value) === Object.prototype) return ['map', Object.keys(value).sort().map(k => [k, encode(value[k], neo4j)])]
  throw new Error('unsupported_property_type')
}
export function decode(value, neo4j) {
  if (!Array.isArray(value)) throw new Error('invalid_encoded_value')
  const [type, data] = value
  if (type === 'null') return null
  if (type === 'integer') return neo4j.int(data)
  if (type === 'number') return Number(data)
  if (type === 'string' || type === 'boolean') return data
  if (type === 'bytes') return new Int8Array(Buffer.from(data, 'base64'))
  if (type === 'array') return data.map(v => decode(v, neo4j))
  if (type === 'map') return Object.fromEntries(data.map(([k, v]) => [k, decode(v, neo4j)]))
  if (temporal[type]) return new neo4j.types[type](...data.map(v => decode(v, neo4j)))
  throw new Error('unsupported_encoded_type')
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const quote = name => '`' + name.replaceAll('`', '``') + '`'
function validateSchema(schema) {
  if (!Array.isArray(schema)) throw new Error('invalid_schema')
  for (const entry of schema) {
    if (entry.entityType !== 'NODE' || entry.labelsOrTypes.length !== 1 || !LABELS.includes(entry.labelsOrTypes[0]) ||
        !['UNIQUENESS', 'RANGE'].includes(entry.type) || typeof entry.name !== 'string' ||
        !Array.isArray(entry.properties) || !entry.properties.length || entry.properties.some(p => typeof p !== 'string' || !p)) throw new Error('unsupported_schema')
  }
}
export function validateSnapshot(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length || snapshot.relationshipCount !== 0) throw new Error('invalid_snapshot')
  validateSchema(snapshot.schema)
  const seen = new Set()
  for (const node of snapshot.nodes) {
    if (typeof node.sourceId !== 'string' || seen.has(node.sourceId) || !LABELS.includes(node.label) || node.properties?.[0] !== 'map') throw new Error('invalid_node')
    seen.add(node.sourceId)
  }
  const hash = digest({ version: 1, nodes: snapshot.nodes, schema: snapshot.schema, relationshipCount: 0 })
  if (snapshot.manifestHash !== hash) throw new Error('snapshot_hash_mismatch')
  return hash
}
// Both export modes require application writers/workers to be stopped throughout
// export and verification. Shared mode deliberately excludes unrelated Noos data.
export const exportGraph = (driver, neo4j) => exportDomain(driver, neo4j)
export async function exportSharedGraph(driver, neo4j, id) {
  validateRunId(id)
  return exportDomain(driver, neo4j, id)
}
async function exportDomain(driver, neo4j, migrationId) {
  const shared = migrationId !== undefined
  const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
  try {
    const nodes = await session.executeRead(async tx => {
      if (shared) {
        const receipt = await tx.run('MATCH (m:UnlinkedGraphMigration {id:$id}) RETURN m.status AS status', { id: migrationId })
        if (receipt.records.length !== 1 || receipt.records[0].get('status') !== 'verified') throw new Error('shared_export_verified_migration_required')
      }
      const edges = await tx.run(shared ? `MATCH (a)-[r]->(b)
        WHERE any(label IN labels(a) WHERE label IN $labels) OR any(label IN labels(b) WHERE label IN $labels)
        WITH a,r,b WHERE NOT coalesce((type(r)='UNLINKED_IMPORTED_RECORD' AND labels(a)=['UnlinkedGraphMigrationRecord']
          AND a.migrationId=$id AND size(labels(b))=1 AND labels(b)[0] IN $labels),false)
        RETURN count(r) AS count` : 'MATCH ()-[r]->() RETURN count(r) AS count', { labels: LABELS, id: migrationId ?? null })
      if (!edges.records[0].get('count').equals(neo4j.int(0))) throw new Error('unexpected_source_relationships')
      const result = await tx.run(`MATCH (n) ${shared ? 'WHERE any(label IN labels(n) WHERE label IN $labels)' : ''}
        RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties ORDER BY elementId(n)`, { labels: LABELS })
      return result.records.map(r => {
        const labels = r.get('labels')
        if (labels.length !== 1 || !LABELS.includes(labels[0])) throw new Error('unexpected_source_label')
        return { sourceId: r.get('id'), label: labels[0], properties: encode(r.get('properties'), neo4j) }
      })
    })
    const constraints = await session.run('SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties')
    const indexes = await session.run("SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint WHERE owningConstraint IS NULL AND type <> 'LOOKUP' RETURN name, type, entityType, labelsOrTypes, properties")
    const schema = [...constraints.records, ...indexes.records].map(r => r.toObject())
      .filter(entry => !shared || entry.labelsOrTypes.some(label => LABELS.includes(label)))
      .sort((a, b) => a.name.localeCompare(b.name))
    const payload = { version: 1, nodes, schema, relationshipCount: 0 }
    const snapshot = { ...payload, manifestHash: digest(payload), exportedAt: new Date().toISOString() }
    validateSnapshot(snapshot)
    return snapshot
  } finally { await session.close() }
}
// Recovery must target a newly created isolated graph. Retry permits only this
// migration's own ledger and copied domain, never an unrelated graph/domain.
export async function restoreIsolatedGraph(driver, neo4j, snapshot, id) {
  validateSnapshot(snapshot); validateRunId(id)
  const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
  try {
    const result = await session.run(`MATCH (n) WHERE NOT coalesce((
      any(label IN labels(n) WHERE label IN $labels) OR
      (labels(n)=['UnlinkedGraphMigration'] AND n.id=$id) OR
      (labels(n)=['UnlinkedGraphMigrationRecord'] AND n.migrationId=$id)),false) RETURN count(n) AS count`, { labels: LABELS, id })
    if (!result.records[0].get('count').equals(neo4j.int(0))) throw new Error('isolated_recovery_target_not_empty')
    const edges = await session.run(`MATCH (a)-[r]->(b) WHERE NOT coalesce((
      type(r)='UNLINKED_IMPORTED_RECORD' AND labels(a)=['UnlinkedGraphMigrationRecord']
      AND a.migrationId=$id AND size(labels(b))=1 AND labels(b)[0] IN $labels),false)
      RETURN count(r) AS count`, { labels: LABELS, id })
    if (!edges.records[0].get('count').equals(neo4j.int(0))) throw new Error('unexpected_recovery_relationships')
  } finally { await session.close() }
  // The isolated launcher has no shared-checkpoint activation step. Fence the
  // recovery run atomically when its ledger is created, before any copy writes.
  return importGraph(driver, neo4j, snapshot, id, { recoveryProtected: true })
}
function schemaStatement(entry) {
  const label = quote(entry.labelsOrTypes[0]), props = entry.properties.map(p => 'n.' + quote(p))
  if (entry.type === 'UNIQUENESS') return `CREATE CONSTRAINT ${quote(entry.name)} IF NOT EXISTS FOR (n:${label}) REQUIRE (${props.join(', ')}) IS UNIQUE`
  return `CREATE RANGE INDEX ${quote(entry.name)} IF NOT EXISTS FOR (n:${label}) ON (${props.join(', ')})`
}
async function checkSchema(session, expected, requireAll = false) {
  const c = await session.run('SHOW CONSTRAINTS YIELD name,type,entityType,labelsOrTypes,properties RETURN name,type,entityType,labelsOrTypes,properties')
  const i = await session.run("SHOW INDEXES YIELD name,type,entityType,labelsOrTypes,properties,owningConstraint WHERE owningConstraint IS NULL AND type <> 'LOOKUP' RETURN name,type,entityType,labelsOrTypes,properties")
  const current = new Map([...c.records, ...i.records].map(r => [r.get('name'), r.toObject()]))
  const approved = new Map(expected.map(entry => [entry.name, entry]))
  for (const entry of current.values()) {
    if (entry.labelsOrTypes.some(label => LABELS.includes(label)) &&
        JSON.stringify(entry) !== JSON.stringify(approved.get(entry.name))) throw new Error('target_schema_conflict')
  }
  for (const entry of expected) {
    const prior = current.get(entry.name)
    if ((!prior && requireAll) || (prior && JSON.stringify(prior) !== JSON.stringify(entry))) throw new Error('target_schema_conflict')
  }
}
function validateRunId(id) { if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('invalid_migration_id') }
export async function importGraph(driver, neo4j, snapshot, id, { recoveryProtected = false } = {}) {
  const manifestHash = validateSnapshot(snapshot); validateRunId(id)
  const session = driver.session({ database: 'neo4j' })
  try {
    await session.run('CREATE CONSTRAINT unlinked_graph_migration_key IF NOT EXISTS FOR (m:UnlinkedGraphMigration) REQUIRE m.id IS UNIQUE')
    await session.run('CREATE CONSTRAINT unlinked_graph_migration_record_key IF NOT EXISTS FOR (m:UnlinkedGraphMigrationRecord) REQUIRE (m.migrationId,m.sourceId) IS UNIQUE')
    await session.executeWrite(async tx => {
      const result = await tx.run(`MERGE (m:UnlinkedGraphMigration {id:$id}) ON CREATE SET m.manifestHash=$hash,m.status='copying',m.createdAt=$now SET m._lock=true REMOVE m._lock RETURN m.manifestHash AS hash,m.status AS status,m.activatedAt AS activatedAt`, { id, hash: manifestHash, now: new Date().toISOString() })
      if (result.records[0].get('hash') !== manifestHash || result.records[0].get('activatedAt') !== null || !['copying', 'verified'].includes(result.records[0].get('status'))) throw new Error('migration_conflict')
      const collision = await tx.run(`MATCH (n) WHERE any(label IN labels(n) WHERE label IN $labels) AND NOT EXISTS { MATCH (:UnlinkedGraphMigrationRecord {migrationId:$id})-[:UNLINKED_IMPORTED_RECORD]->(n) } RETURN count(n) AS count`, { labels: LABELS, id })
      if (!collision.records[0].get('count').equals(neo4j.int(0))) throw new Error('target_domain_exists')
      await tx.run("MATCH (m:UnlinkedGraphMigration {id:$id}) SET m.status='copying',m.recoveryProtected=coalesce(m.recoveryProtected,false) OR $recoveryProtected", { id, recoveryProtected })
    })
    await checkSchema(session, snapshot.schema)
    for (const entry of snapshot.schema) await session.run(schemaStatement(entry))
    for (let offset = 0; offset < snapshot.nodes.length; offset += 25) {
      await session.executeWrite(async tx => {
        await requireCopying(tx, id, manifestHash)
        for (const row of snapshot.nodes.slice(offset, offset + 25)) {
          const old = await tx.run('MATCH (m:UnlinkedGraphMigrationRecord {migrationId:$id,sourceId:$sourceId})-[:UNLINKED_IMPORTED_RECORD]->(n) RETURN properties(n) AS properties,labels(n) AS labels,m.hash AS hash', { id, sourceId: row.sourceId })
          if (old.records.length) {
            const r = old.records[0]
            if (r.get('hash') !== digest(row) || digest(encode(r.get('properties'), neo4j)) !== digest(row.properties) || JSON.stringify(r.get('labels')) !== JSON.stringify([row.label])) throw new Error('imported_record_changed')
            continue
          }
          await tx.run(`CREATE (n:${quote(row.label)}) SET n=$properties CREATE (m:UnlinkedGraphMigrationRecord {migrationId:$id,sourceId:$sourceId,hash:$hash}) CREATE (m)-[:UNLINKED_IMPORTED_RECORD]->(n)`, { properties: decode(row.properties, neo4j), id, sourceId: row.sourceId, hash: digest(row) })
        }
      })
    }
    await verifyGraph(driver, neo4j, snapshot, id)
    await session.executeWrite(async tx => {
      await requireCopying(tx, id, manifestHash)
      await tx.run("MATCH (m:UnlinkedGraphMigration {id:$id,manifestHash:$hash}) SET m.status='verified',m.verifiedAt=$now,m.recordCount=$count", { id, hash: manifestHash, now: new Date().toISOString(), count: neo4j.int(snapshot.nodes.length) })
    })
    return { id, manifestHash, nodes: snapshot.nodes.length, status: 'verified' }
  } finally { await session.close() }
}
async function requireCopying(tx, id, hash) {
  const result = await tx.run('MATCH (m:UnlinkedGraphMigration {id:$id,manifestHash:$hash}) SET m._lock=true REMOVE m._lock RETURN m.status AS status,m.activatedAt AS activatedAt', { id, hash })
  if (result.records.length !== 1 || result.records[0].get('status') !== 'copying' || result.records[0].get('activatedAt') !== null) throw new Error('migration_conflict')
}
export async function verifyGraph(driver, neo4j, snapshot, id) {
  validateSnapshot(snapshot); validateRunId(id)
  const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
  try {
    await checkSchema(session, snapshot.schema, true)
    const rows = await session.run('MATCH (m:UnlinkedGraphMigrationRecord {migrationId:$id})-[:UNLINKED_IMPORTED_RECORD]->(n) RETURN m.sourceId AS sourceId, labels(n) AS labels,properties(n) AS properties ORDER BY m.sourceId', { id })
    const actual = rows.records.map(r => ({ sourceId: r.get('sourceId'), label: r.get('labels').length === 1 ? r.get('labels')[0] : null, properties: encode(r.get('properties'), neo4j) }))
    if (digest(actual) !== digest(snapshot.nodes)) throw new Error('target_parity_failed')
    const count = await session.run('MATCH (n) WHERE any(label IN labels(n) WHERE label IN $labels) RETURN count(n) AS count', { labels: LABELS })
    if (!count.records[0].get('count').equals(neo4j.int(snapshot.nodes.length))) throw new Error('target_extra_records')
    return { id, manifestHash: snapshot.manifestHash, nodes: actual.length, parity: true }
  } finally { await session.close() }
}
// Pre-activation rollback only. Once apps resume writes, use a fresh reverse
// export/restore; never discard sessions or user edits made after the cutover.
export async function rollbackGraph(driver, neo4j, snapshot, id) {
  validateSnapshot(snapshot); validateRunId(id)
  const session = driver.session({ database: 'neo4j' })
  try {
    await session.executeWrite(async tx => {
      const receipt = await tx.run('MATCH (m:UnlinkedGraphMigration {id:$id,manifestHash:$hash}) SET m._lock=true REMOVE m._lock RETURN m.status AS status,m.activatedAt AS activatedAt,m.recoveryProtected AS recoveryProtected', { id, hash: snapshot.manifestHash })
      if (receipt.records.length !== 1 || receipt.records[0].get('activatedAt') !== null || receipt.records[0].get('recoveryProtected') === true || !['copying', 'verified'].includes(receipt.records[0].get('status'))) throw new Error('migration_conflict')
      const rows = await tx.run('MATCH (m:UnlinkedGraphMigrationRecord {migrationId:$id})-[:UNLINKED_IMPORTED_RECORD]->(n) SET n = properties(n) RETURN m.sourceId AS sourceId,properties(n) AS properties,labels(n) AS labels', { id })
      const expected = new Map(snapshot.nodes.map(n => [n.sourceId, n]))
      for (const r of rows.records) {
        const row = expected.get(r.get('sourceId'))
        if (!row || digest(encode(r.get('properties'), neo4j)) !== digest(row.properties) || JSON.stringify(r.get('labels')) !== JSON.stringify([row.label])) throw new Error('rollback_later_edit')
      }
      const edges = await tx.run(`MATCH (m:UnlinkedGraphMigrationRecord {migrationId:$id})-[:UNLINKED_IMPORTED_RECORD]->(n)
        UNWIND [n,m] AS touched MATCH (touched)-[r]-()
        WITH startNode(r) AS a,r,endNode(r) AS b,n WHERE NOT coalesce((type(r)='UNLINKED_IMPORTED_RECORD'
          AND labels(a)=['UnlinkedGraphMigrationRecord'] AND a.migrationId=$id
          AND b=n AND size(labels(b))=1 AND labels(b)[0] IN $labels),false)
        RETURN count(r) AS count`, { id, labels: LABELS })
      if (!edges.records[0].get('count').equals(neo4j.int(0))) throw new Error('rollback_later_relationship')
      await tx.run('MATCH (m:UnlinkedGraphMigrationRecord {migrationId:$id})-[:UNLINKED_IMPORTED_RECORD]->(n) DETACH DELETE n,m', { id })
      await tx.run("MATCH (m:UnlinkedGraphMigration {id:$id}) SET m.status='rolled-back'", { id })
    })
    return { id, status: 'rolled-back' }
  } finally { await session.close() }
}
