import { readFile, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENRICHMENT_DATASET, ENRICHMENT_DATASETS, LINKEDIN_ENRICHMENT_DATASETS, LINKEDIN_ENRICHMENT_ID } from '../src/utils/public-people/member-projection.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = (value, required = false) => (required ? typeof value === 'string' && value.length > 0 : value === undefined || typeof value === 'string') && (value === undefined || value.length <= 20000)
const allow = (value, allowed, required) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => text(value[key], true)) && Object.values(value).every(entry => text(entry))

// Rows come from a reviewed offline operator source;
// this validates the same shape the public store and reader enforce, so a bad
// rows file fails here in plan mode instead of at the graph.
// LinkedIn-keyed datasets (curated-enrichment-li-N) carry `li-<sha256 slug>`
// ids instead of legacy ids (docs/imported-profile-enrichment.md).
const linkedinKeyed = dataset => LINKEDIN_ENRICHMENT_DATASETS.includes(dataset)
export function prepareEnrichmentSnapshot(bytes, dataset = ENRICHMENT_DATASET) {
  if (!ENRICHMENT_DATASETS.includes(dataset) && !linkedinKeyed(dataset)) throw new Error('enrichment_dataset_unknown')
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw new Error('enrichment_rows_file_required')
  const rows = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new Error('enrichment_rows_invalid')
  const ids = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).some(key => !['id','name','headline','location','about','company','positions','education','skills'].includes(key)) || ids.has(row.id)) throw new Error('enrichment_rows_invalid')
    const { positions, education, skills, ...scalars } = row
    if (!allow(scalars, ['id','name','headline','location','about','company'], ['id','name'])) throw new Error('enrichment_rows_invalid')
    if (linkedinKeyed(dataset) !== LINKEDIN_ENRICHMENT_ID.test(row.id)) throw new Error('enrichment_rows_invalid')
    ids.add(row.id)
    if (!Array.isArray(row.positions) || row.positions.length > 100 || !row.positions.every(value => allow(value, ['title','company','startDate','endDate','description'], ['title','company']))) throw new Error('enrichment_rows_invalid')
    if (!Array.isArray(row.education) || row.education.length > 100 || !row.education.every(value => allow(value, ['institution','degree','startDate','endDate'], ['institution']))) throw new Error('enrichment_rows_invalid')
    if (!Array.isArray(row.skills) || row.skills.length > 500 || !row.skills.every(value => text(value, true))) throw new Error('enrichment_rows_invalid')
  }
  const profiles = JSON.parse(JSON.stringify(rows))
  return { snapshot: { state: 'published', complete: true, revision: dataset + ':' + hash(JSON.stringify(profiles)), profiles, connections: [] }, sourceSha256: hash(bytes) }
}

// A provenance record travels into the private receipt only (never the
// public dataset): where the rows came from and when they were fetched.
export function readProvenance(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) throw new Error('enrichment_provenance_invalid')
  const value = JSON.parse(bytes.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.source !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.source)) throw new Error('enrichment_provenance_invalid')
  return value
}

// Offline reviewed operator publisher only, like publish-legacy-people.mjs:
// never an HTTP/upload handler and never infers a login/owner. Every id-keyed
// row id must already exist in the published legacy dataset — enrichment
// refreshes people, it never adds them. LinkedIn-keyed rows name an address,
// never a person, and only fill empty fields of profiles that carry it.
export async function publishEnrichmentPeople({ rowsPath, root, execute = false, dataset = ENRICHMENT_DATASET, provenancePath }) {
  if (root !== '/srv/unlinked-private-guest-pilot-20261001' || resolve(rowsPath) !== rowsPath || !rowsPath.startsWith(root + '/')) throw new Error('explicit_private_enrichment_target_required')
  if (provenancePath !== undefined && (resolve(provenancePath) !== provenancePath || !provenancePath.startsWith(root + '/'))) throw new Error('explicit_private_enrichment_target_required')
  for (const [path, directory] of [[root, true], [rowsPath, false], ...(provenancePath ? [[provenancePath, false]] : [])]) {
    const state = await lstat(path)
    if (state.isSymbolicLink() || (directory ? !state.isDirectory() : !state.isFile()) || state.uid !== process.getuid() || (state.mode & 0o077)) throw new Error('private_enrichment_source_required')
  }
  const bytes = await readFile(rowsPath)
  const { snapshot, sourceSha256 } = prepareEnrichmentSnapshot(bytes, dataset)
  const provenance = provenancePath ? readProvenance(await readFile(provenancePath)) : undefined
  const receipt = { kind: 'curated-enrichment-publication', dataset, keyedBy: linkedinKeyed(dataset) ? 'linkedin' : 'profile-id', rowsPath, sourceSha256, revision: snapshot.revision, profiles: snapshot.profiles.length, snapshotSha256: hash(JSON.stringify(snapshot)), ...(provenance ? { provenance } : {}) }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  if (!process.env.NOOS_PRIVATE_PASSWORD) throw new Error('private_graph_configuration_required')
  const require = createRequire(join(root, 'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const { UnlinkedPublicPeopleStore } = require(join(root, 'runtime/noos/dist/operational/public-people.js'))
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  try {
    const store = new UnlinkedPublicPeopleStore(driver, 'neo4j'); await store.initialize()
    const legacy = await store.read('recovered-legacy-public-v1')
    if (!legacy) throw new Error('enrichment_legacy_dataset_required')
    const known = new Set(legacy.profiles.map(value => value.id))
    const unknown = linkedinKeyed(dataset) ? [] : snapshot.profiles.filter(value => !known.has(value.id)).map(value => value.id)
    if (unknown.length) throw new Error('enrichment_unknown_profile_ids:' + unknown.slice(0, 5).join(','))
    const current = await store.read(dataset)
    // Re-running with unchanged rows is a no-op: the revision is content-addressed.
    if (current?.revision === snapshot.revision) return { ...receipt, status: 'UNCHANGED_NO_WRITES', previousRevision: current.revision }
    const result = await store.publish(dataset, snapshot, sourceSha256, current?.revision ?? null)
    const stored = await store.read(dataset)
    if (!stored || hash(JSON.stringify(stored)) !== receipt.snapshotSha256 || stored.profiles.length !== snapshot.profiles.length) throw new Error('enrichment_readback_failed')
    // Revoking the live revision deletes the dataset pointer, so rollback
    // removes the whole overlay and the legacy rows show again.
    const report = { ...receipt, at: new Date().toISOString(), status: 'PUBLISHED_COMPLETE', replayed: result.replayed, previousRevision: current?.revision ?? null, rollback: { operation: 'UnlinkedPublicPeopleStore.revoke', dataset, revision: snapshot.revision } }
    await writeFile(join(root, 'audit', 'curated-enrichment-' + Date.now() + '.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return report
  } finally { await driver.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // usage: rowsPath root [--dataset=<one of ENRICHMENT_DATASETS or LINKEDIN_ENRICHMENT_DATASETS>] [--provenance=<file under root>] [--execute]
  const [rowsPath, root, ...flags] = process.argv.slice(2)
  const dataset = flags.find(flag => flag.startsWith('--dataset='))?.slice('--dataset='.length) ?? ENRICHMENT_DATASET
  const provenancePath = flags.find(flag => flag.startsWith('--provenance='))?.slice('--provenance='.length)
  if (!rowsPath || !root || flags.some(flag => flag !== '--execute' && !flag.startsWith('--dataset=') && !flag.startsWith('--provenance=')) || new Set(flags.map(flag => flag.split('=')[0])).size !== flags.length) throw new Error('usage_rowsPath_root_dataset_execute')
  console.log(JSON.stringify(await publishEnrichmentPeople({ rowsPath, root, dataset, provenancePath, execute: flags.includes('--execute') })))
}
