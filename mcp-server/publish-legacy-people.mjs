import { readFile, writeFile, lstat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLegacyPlan } from '../src/utils/legacy-import/legacy-plan.mjs'
import { createLegacyPublicProjection } from '../src/utils/public-people/legacy-projection.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

const sourceContainerSha256 = '6f1e8c2c86881191ebb3fdea92348e7abb2ef87207b65eba01789e9f6969cca2'
const sourceSha256 = '21bf382c5bdd28a96193d2873c257e1acc6571a54f69b2a2286ddb6e09b78cd0'
const hash = value => createHash('sha256').update(value).digest('hex')
export function prepareRecoveredPublicSeed(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024 || hash(bytes) !== sourceContainerSha256) throw new Error('verified_recovered_container_required')
  const dump = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 })
  if (hash(dump) !== sourceSha256) throw new Error('verified_recovered_source_required')
  const plan = createLegacyPlan(dump, { sourceContainerSha256 })
  const projection = createLegacyPublicProjection(plan)
  if (projection.snapshot.profiles.length !== 16296 || projection.snapshot.connections.length !== 16603 || projection.manifest.sourceSha256 !== sourceSha256) throw new Error('complete_recovered_public_source_required')
  return projection
}

// Offline reviewed single-source publisher only. Never an HTTP/upload handler,
// never infers a login/owner, and never imports auth/security/Storage bytes.
export async function publishRecoveredPublicSeed({ sourcePath, root, execute = false }) {
  if (root !== '/srv/unlinked-private-guest-pilot-20261001' || sourcePath !== join(root, 'source-recovery', 'source-database.backup.gz')) throw new Error('explicit_private_seed_target_required')
  for (const [path, directory] of [[root,true],[join(root,'source-recovery'),true],[sourcePath,false]]) {
    const s = await lstat(path)
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('private_seed_source_required')
  }
  const value = prepareRecoveredPublicSeed(await readFile(sourcePath))
  const dataset = 'recovered-legacy-public-v1'
  const receipt = { kind: 'recovered-public-people-seed', dataset, sourceSha256, sourceContainerSha256, revision: value.snapshot.revision, profiles: 16296, connections: 16603, snapshotSha256: hash(JSON.stringify(value.snapshot)), originalSourcePreserved: true, ownerBindingsCreated: 0 }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  if (!process.env.NOOS_PRIVATE_PASSWORD) throw new Error('private_graph_configuration_required')
  const require = createRequire(join(root,'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const { UnlinkedPublicPeopleStore } = require(join(root,'runtime/noos/dist/operational/public-people.js'))
  const driver = neo4j.driver(operatorBoltUrl(),neo4j.auth.basic('neo4j',process.env.NOOS_PRIVATE_PASSWORD),{connectionTimeout:5000,connectionAcquisitionTimeout:5000,maxTransactionRetryTime:10000})
  try {
    const store = new UnlinkedPublicPeopleStore(driver,'neo4j');await store.initialize()
    const manifestPath = join(root,'audit','legacy-public-source-manifest-' + value.snapshot.revision.split(':').at(-1) + '.json')
    const serialized = JSON.stringify(value.manifest)
    try { await writeFile(manifestPath,serialized,{mode:0o600,flag:'wx'}) }
    catch(error) { if(error.code!=='EEXIST')throw error;const stat=await lstat(manifestPath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid()||(await readFile(manifestPath,'utf8'))!==serialized)throw new Error('private_seed_manifest_conflict') }
    const result = await store.publish(dataset,value.snapshot,sourceSha256)
    const stored = await store.read(dataset)
    if (!stored || hash(JSON.stringify(stored)) !== receipt.snapshotSha256 || stored.profiles.length !== 16296 || stored.connections.length !== 16603) throw new Error('recovered_seed_readback_failed')
    const report = { ...receipt, at:new Date().toISOString(), status:'PUBLISHED_COMPLETE', replayed:result.replayed, privateProvenanceManifest:manifestPath, rollback:{operation:'UnlinkedPublicPeopleStore.revoke',dataset,revision:receipt.revision}, liveSearchReceipt:false }
    await writeFile(join(root,'audit','legacy-public-seed-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'})
    return report
  } finally { await driver.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--execute')) throw new Error('usage_sourcePath_root_execute')
  console.log(JSON.stringify(await publishRecoveredPublicSeed({sourcePath:args[0],root:args[1],execute:args[2]==='--execute'})))
}
