import { readFile, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = (value, required = false) => (required ? typeof value === 'string' && value.length > 0 : value === undefined || typeof value === 'string') && (value === undefined || value.length <= 20000)
const allow = (value, allowed, required) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => text(value[key], true)) && Object.values(value).every(entry => text(entry))

// Rows come from a reviewed offline fetch (for example provider profile reads);
// this validates the same shape the public store and reader enforce, so a bad
// rows file fails here in plan mode instead of at the graph.
export function prepareEnrichmentSnapshot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw new Error('enrichment_rows_file_required')
  const rows = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new Error('enrichment_rows_invalid')
  const ids = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).some(key => !['id','name','headline','location','about','company','positions','education','skills'].includes(key)) || ids.has(row.id)) throw new Error('enrichment_rows_invalid')
    const { positions, education, skills, ...scalars } = row
    if (!allow(scalars, ['id','name','headline','location','about','company'], ['id','name'])) throw new Error('enrichment_rows_invalid')
    ids.add(row.id)
    if (!Array.isArray(row.positions) || row.positions.length > 100 || !row.positions.every(value => allow(value, ['title','company','startDate','endDate','description'], ['title','company']))) throw new Error('enrichment_rows_invalid')
    if (!Array.isArray(row.education) || row.education.length > 100 || !row.education.every(value => allow(value, ['institution','degree','startDate','endDate'], ['institution']))) throw new Error('enrichment_rows_invalid')
    if (!Array.isArray(row.skills) || row.skills.length > 500 || !row.skills.every(value => text(value, true))) throw new Error('enrichment_rows_invalid')
  }
  const profiles = JSON.parse(JSON.stringify(rows))
  return { snapshot: { state: 'published', complete: true, revision: ENRICHMENT_DATASET + ':' + hash(JSON.stringify(profiles)), profiles, connections: [] }, sourceSha256: hash(bytes) }
}

// Offline reviewed operator publisher only, like publish-legacy-people.mjs:
// never an HTTP/upload handler and never infers a login/owner. Every row id
// must already exist in the published legacy dataset — enrichment refreshes
// people, it never adds them.
export async function publishEnrichmentPeople({ rowsPath, root, execute = false }) {
  if (root !== '/srv/unlinked-private-guest-pilot-20261001' || resolve(rowsPath) !== rowsPath || !rowsPath.startsWith(root + '/')) throw new Error('explicit_private_enrichment_target_required')
  for (const [path, directory] of [[root, true], [rowsPath, false]]) {
    const state = await lstat(path)
    if (state.isSymbolicLink() || (directory ? !state.isDirectory() : !state.isFile()) || state.uid !== process.getuid() || (state.mode & 0o077)) throw new Error('private_enrichment_source_required')
  }
  const bytes = await readFile(rowsPath)
  const { snapshot, sourceSha256 } = prepareEnrichmentSnapshot(bytes)
  const receipt = { kind: 'curated-enrichment-publication', dataset: ENRICHMENT_DATASET, rowsPath, sourceSha256, revision: snapshot.revision, profiles: snapshot.profiles.length, snapshotSha256: hash(JSON.stringify(snapshot)) }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  if (!process.env.NOOS_PRIVATE_PASSWORD) throw new Error('private_graph_configuration_required')
  const require = createRequire(join(root, 'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const { UnlinkedPublicPeopleStore } = require(join(root, 'runtime/noos/dist/operational/public-people.js'))
  const driver = neo4j.driver('bolt://graph:7687', neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  try {
    const store = new UnlinkedPublicPeopleStore(driver, 'neo4j'); await store.initialize()
    const legacy = await store.read('recovered-legacy-public-v1')
    if (!legacy) throw new Error('enrichment_legacy_dataset_required')
    const known = new Set(legacy.profiles.map(value => value.id))
    const unknown = snapshot.profiles.filter(value => !known.has(value.id)).map(value => value.id)
    if (unknown.length) throw new Error('enrichment_unknown_profile_ids:' + unknown.slice(0, 5).join(','))
    const current = await store.read(ENRICHMENT_DATASET)
    const result = await store.publish(ENRICHMENT_DATASET, snapshot, sourceSha256, current?.revision ?? null)
    const stored = await store.read(ENRICHMENT_DATASET)
    if (!stored || hash(JSON.stringify(stored)) !== receipt.snapshotSha256 || stored.profiles.length !== snapshot.profiles.length) throw new Error('enrichment_readback_failed')
    // Revoking the live revision deletes the dataset pointer, so rollback
    // removes the whole overlay and the legacy rows show again.
    const report = { ...receipt, at: new Date().toISOString(), status: 'PUBLISHED_COMPLETE', replayed: result.replayed, previousRevision: current?.revision ?? null, rollback: { operation: 'UnlinkedPublicPeopleStore.revoke', dataset: ENRICHMENT_DATASET, revision: snapshot.revision } }
    await writeFile(join(root, 'audit', 'curated-enrichment-' + Date.now() + '.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return report
  } finally { await driver.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--execute')) throw new Error('usage_rowsPath_root_execute')
  console.log(JSON.stringify(await publishEnrichmentPeople({ rowsPath: args[0], root: args[1], execute: args[2] === '--execute' })))
}
