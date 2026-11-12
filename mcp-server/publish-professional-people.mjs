import { readFile, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFESSIONAL_PEOPLE_DATASET, prepareProfessionalSnapshot, validateProfessionalSnapshot } from '../src/utils/public-people/professional-profiles.mjs'
import { readProvenance } from './publish-enrichment-people.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
// Existing rows survive a later batch; canonical address IDs make retries stable.
export function mergeProfessionalPublication(current, incoming) {
  if (current) validateProfessionalSnapshot(current)
  validateProfessionalSnapshot(incoming)
  const rows = new Map((current?.profiles ?? []).map(row => [row.id,row]))
  for (const row of incoming.profiles) rows.set(row.id,row)
  return prepareProfessionalSnapshot(Buffer.from(JSON.stringify([...rows.values()].sort((a,b) => a.id.localeCompare(b.id)))))
}
export async function publishProfessionalPeople({ rowsPath, provenancePath, root, execute = false, expectedRevision }) {
  if (root !== '/srv/unlinked-private-guest-pilot-20261001') throw Error('explicit_professional_target_required')
  for (const [path, directory] of [[root,true],[rowsPath,false],[provenancePath,false]]) {
    if (typeof path !== 'string' || resolve(path) !== path || !directory && !path.startsWith(root+'/')) throw Error('explicit_professional_target_required')
    const state = await lstat(path)
    if (state.isSymbolicLink() || (directory ? !state.isDirectory() : !state.isFile()) || state.uid !== process.getuid() || state.mode & 0o077) throw Error('private_professional_source_required')
  }
  const bytes = await readFile(rowsPath), incoming = prepareProfessionalSnapshot(bytes), provenance = readProvenance(await readFile(provenancePath))
  if (!incoming.profiles.length || provenance.rowsSha256 !== hash(bytes) || provenance.scope !== 'public-professional-profiles-only') throw Error('professional_provenance_required')
  const receipt = { kind:'professional-people-publication', dataset:PROFESSIONAL_PEOPLE_DATASET, sourceSha256:hash(bytes), incomingProfiles:incoming.profiles.length, provenance }
  if (!execute) return { ...receipt, incomingRevision:incoming.revision, status:'PLANNED_NO_WRITES' }
  if (typeof expectedRevision !== 'string' || !process.env.NOOS_PRIVATE_PASSWORD) throw Error('professional_expected_revision_required')
  const require = createRequire(join(root,'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const { UnlinkedPublicPeopleStore } = require(join(root,'runtime/noos/dist/operational/public-people.js'))
  const driver = neo4j.driver(operatorBoltUrl(),neo4j.auth.basic('neo4j',process.env.NOOS_PRIVATE_PASSWORD))
  try {
    const store = new UnlinkedPublicPeopleStore(driver,'neo4j'); await store.initialize()
    const current = await store.read(PROFESSIONAL_PEOPLE_DATASET), snapshot = mergeProfessionalPublication(current,incoming)
    if (current?.revision === snapshot.revision) return { ...receipt, revision:snapshot.revision, status:'UNCHANGED_NO_WRITES' }
    if ((current?.revision ?? 'none') !== expectedRevision) throw Error('professional_publication_changed')
    const audit = join(root,'audit','professional-people-'+Date.now()+'.json')
    await writeFile(audit,JSON.stringify({ ...receipt, previous:current, candidate:snapshot, status:'PREPARED' }),{mode:0o600,flag:'wx'})
    await store.publish(PROFESSIONAL_PEOPLE_DATASET,snapshot,receipt.sourceSha256,current?.revision ?? null)
    const stored = await store.read(PROFESSIONAL_PEOPLE_DATASET)
    if (JSON.stringify(stored) !== JSON.stringify(snapshot)) throw Error('professional_publication_readback_failed')
    const result = { ...receipt, revision:snapshot.revision, profiles:snapshot.profiles.length, status:'PUBLISHED_COMPLETE', audit, previousRevision:current?.revision ?? null }
    await writeFile(audit+'.receipt',JSON.stringify(result),{mode:0o600,flag:'wx'})
    return result
  } finally { await driver.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rowsPath,provenancePath,root,...flags] = process.argv.slice(2)
  if (flags.some(flag => flag !== '--execute' && !flag.startsWith('--expected-revision=')) || new Set(flags.map(flag=>flag.split('=')[0])).size !== flags.length) throw Error('professional_arguments_invalid')
  console.log(JSON.stringify(await publishProfessionalPeople({ rowsPath,provenancePath,root,execute:flags.includes('--execute'),expectedRevision:flags.find(flag=>flag.startsWith('--expected-revision='))?.slice(20) })))
}
