import { readFile, writeFile, lstat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPANY_DATASET, validateCompanyRows } from './company-metadata.mjs'
import { companyRevision, createNeo4jCompanyFactsStore } from './company-facts-store.mjs'

const ROOT = '/srv/unlinked-private-guest-pilot-20261001'
// Receipt names carry a random suffix so two operations in one millisecond never collide.
const hash = value => createHash('sha256').update(value).digest('hex')

// Rows come from a reviewed offline operator source.
// The same whitelist runs again in the store and in the runtime reader, so a
// bad rows file fails here in plan mode instead of at the graph.
export function prepareCompanyFacts(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('company_rows_file_required')
  let rows
  try { rows = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('company_rows_invalid') }
  const companies = validateCompanyRows(rows)
  return { companies, revision: companyRevision(companies), sourceSha256: hash(bytes) }
}

async function privateTarget(rowsPath, root, allowedRoot) {
  if (root !== allowedRoot || (rowsPath !== undefined && (resolve(rowsPath) !== rowsPath || !rowsPath.startsWith(root + '/')))) throw new Error('explicit_private_company_target_required')
  for (const [path, directory] of [[root, true], ...(rowsPath === undefined ? [] : [[rowsPath, false]])]) {
    const state = await lstat(path)
    if (state.isSymbolicLink() || (directory ? !state.isDirectory() : !state.isFile()) || state.uid !== process.getuid() || (state.mode & 0o077)) throw new Error('private_company_source_required')
  }
}

async function withStore(root, work, createStore) {
  if (createStore) return work(await createStore())
  if (!process.env.NOOS_PRIVATE_PASSWORD) throw new Error('private_graph_configuration_required')
  const require = createRequire(join(root, 'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const driver = neo4j.driver('bolt://graph:7687', neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  try {
    const store = createNeo4jCompanyFactsStore(driver, 'neo4j'); await store.initialize()
    return await work(store)
  } finally { await driver.close() }
}

// Offline reviewed operator publisher only, like publish-enrichment-people.mjs:
// never an HTTP/upload handler. Plan mode reads the rows file and prints the
// revision with no graph connection and no writes. `createStore` and
// `allowedRoot` are test seams; the CLI always uses the fixed host root.
export async function publishCompanyFacts({ rowsPath, root, execute = false, createStore, allowedRoot = ROOT }) {
  await privateTarget(rowsPath, root, allowedRoot)
  const bytes = await readFile(rowsPath)
  const { companies, revision, sourceSha256 } = prepareCompanyFacts(bytes)
  const receipt = { kind: 'curated-companies-publication', dataset: COMPANY_DATASET, rowsPath, sourceSha256, revision, companies: companies.length, datasetSha256: hash(JSON.stringify(companies)) }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  return withStore(root, async store => {
    const current = await store.read(COMPANY_DATASET)
    const result = await store.publish(COMPANY_DATASET, companies, sourceSha256, current?.revision ?? null)
    const stored = await store.read(COMPANY_DATASET)
    if (!stored || stored.revision !== revision || hash(JSON.stringify(stored.companies)) !== receipt.datasetSha256) throw new Error('company_readback_failed')
    // Revoking the live revision deletes the dataset pointer, so rollback
    // removes the whole overlay and the static list shows again. Republishing
    // an earlier rows file moves the pointer back to that revision instead.
    const report = { ...receipt, at: new Date().toISOString(), status: 'PUBLISHED_COMPLETE', replayed: result.replayed, previousRevision: current?.revision ?? null,
      rollback: { operation: 'createNeo4jCompanyFactsStore.revoke', dataset: COMPANY_DATASET, revision, command: `node ${fileURLToPath(import.meta.url)} --revoke ${revision} ${root}` } }
    await writeFile(join(root, 'audit', `curated-companies-${Date.now()}-${randomUUID().slice(0, 8)}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return report
  }, createStore)
}

export async function revokeCompanyFacts({ revision, root, createStore, allowedRoot = ROOT }) {
  await privateTarget(undefined, root, allowedRoot)
  if (typeof revision !== 'string' || !/^curated-companies-v1:[a-f0-9]{64}$/.test(revision)) throw new Error('company_revision_invalid')
  return withStore(root, async store => {
    const before = await store.read(COMPANY_DATASET)
    await store.revoke(COMPANY_DATASET, revision)
    const after = await store.read(COMPANY_DATASET)
    const report = { kind: 'curated-companies-revocation', dataset: COMPANY_DATASET, revision, at: new Date().toISOString(), status: 'REVOKED', wasLive: before?.revision === revision, liveRevision: after?.revision ?? null }
    await writeFile(join(root, 'audit', `curated-companies-revoke-${Date.now()}-${randomUUID().slice(0, 8)}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return report
  }, createStore)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--revoke') {
    if (args.length !== 3) throw new Error('usage_revoke_revision_root')
    console.log(JSON.stringify(await revokeCompanyFacts({ revision: args[1], root: args[2] })))
  } else {
    if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--execute')) throw new Error('usage_rowsPath_root_execute')
    console.log(JSON.stringify(await publishCompanyFacts({ rowsPath: args[0], root: args[1], execute: args[2] === '--execute' })))
  }
}
