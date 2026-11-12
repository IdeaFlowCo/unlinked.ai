import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { PROFESSIONAL_PEOPLE_DATASET, prepareProfessionalSnapshot, validateProfessionalSnapshot } from '../src/utils/public-people/professional-profiles.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digestOf = revision => {
  const digest = typeof revision === 'string' && revision.startsWith(PROFESSIONAL_PEOPLE_DATASET + ':') ? revision.slice(PROFESSIONAL_PEOPLE_DATASET.length + 1) : ''
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('professional_manifest_revision_invalid')
  return digest
}
export function professionalManifestPath(root, revision) {
  if (!isAbsolute(root)) throw Error('professional_manifest_root_required')
  return join(root, 'audit', `professional-public-source-manifest-${digestOf(revision)}.json`)
}
async function privateAudit(root) {
  const stat = await lstat(join(root, 'audit'))
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('private_professional_audit_required')
}
async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) throw Error('professional_manifest_file_invalid')
    return await file.readFile()
  } finally { await file.close() }
}
// Exclusive creation, fsync before the graph pointer, and byte-for-byte collision
// verification make retries safe without ever replacing an existing manifest.
export async function writeProfessionalAudit(root, name, bytes) {
  await privateAudit(root)
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw Error('professional_audit_name_invalid')
  const path = join(root, 'audit', name)
  let file, created = false
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
  }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await readPrivateFile(path)).equals(bytes)) throw Error('professional_manifest_collision')
    // A previous writer may have crashed before syncing the directory entry.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  try {
    if (created) await file.writeFile(bytes)
    await file.sync()
  } finally { await file.close() }
  const directory = await open(join(root, 'audit'), constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
  return path
}
// Keep the content revision (and stable IDs) while persisting only fields the
// installed Noos validator supports. URLs belong to the immutable source file.
export function professionalStorageSnapshot(snapshot) {
  const validated = validateProfessionalSnapshot(snapshot)
  return { ...validated, profiles: validated.profiles.map(({ linkedinUrl, website, ...basic }) => basic) }
}
export async function writeProfessionalManifest(root, snapshot) {
  const validated = validateProfessionalSnapshot(snapshot)
  const path = professionalManifestPath(root, validated.revision)
  const bytes = Buffer.from(JSON.stringify(validated.profiles))
  if (hash(bytes) !== digestOf(validated.revision)) throw Error('professional_manifest_invalid')
  await writeProfessionalAudit(root, path.slice(path.lastIndexOf('/') + 1), bytes)
  return path
}
export async function hydrateProfessionalSnapshot(root, stored) {
  if (stored === null || stored === undefined) return stored
  await privateAudit(root)
  const bytes = await readPrivateFile(professionalManifestPath(root, stored.revision))
  if (hash(bytes) !== digestOf(stored.revision)) throw Error('professional_manifest_invalid')
  const snapshot = prepareProfessionalSnapshot(bytes)
  if (!isDeepStrictEqual(stored, professionalStorageSnapshot(snapshot))) throw Error('professional_manifest_snapshot_mismatch')
  return snapshot
}
// Wrap AFTER the cached Noos reader: revisionOf and all other operations still
// use the live graph pointer, including revocation and freshness fingerprints.
export function withProfessionalProfileDetails(store, root) {
  if (!store) return store
  return new Proxy(store, { get: (target, key) => key === 'read'
    ? async dataset => {
      const snapshot = await target.read(dataset)
      return dataset === PROFESSIONAL_PEOPLE_DATASET ? hydrateProfessionalSnapshot(root, snapshot) : snapshot
    }
    : typeof target[key] === 'function' ? target[key].bind(target) : target[key] })
}
