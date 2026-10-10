import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHOTO_DIRECTORY, PHOTO_ID, PHOTO_MANIFEST_KIND, PHOTO_POINTER_KIND, MAX_PHOTO_BYTES, MAX_PHOTOS, MAX_HISTORY,
  sha256, sniffImageType, validPhotoManifest, validPhotoPointer, readPrivateFile, createProfilePhotoStore } from './profile-photos.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

// Offline reviewed operator publisher for profile photos (docs/profile-photos.md),
// with the same posture as publish-enrichment-people.mjs: never an HTTP/upload
// handler, a fixed private root, operator-owned private files, no symlinks,
// plan mode by default and an audit receipt on --execute.
export const PILOT_ROOT = '/srv/unlinked-private-guest-pilot-20261001'
const SOURCE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/
const TYPE_NAMES = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }

const privateOwned = state => state.uid === process.getuid() && !(state.mode & 0o077)
async function privateDirectory(path, code) {
  const state = await lstat(path)
  if (state.isSymbolicLink() || !state.isDirectory() || !privateOwned(state)) throw new Error(code)
}
// One source photo, read through a no-follow descriptor whose own stat is checked.
async function readSourcePhoto(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const state = await handle.stat()
    if (!state.isFile() || !privateOwned(state)) throw new Error('profile_photo_source_file_not_private')
    if (state.size < 12 || state.size > MAX_PHOTO_BYTES) throw new Error('profile_photo_source_file_size')
    const bytes = await handle.readFile()
    const type = sniffImageType(bytes)
    if (!type) throw new Error('profile_photo_source_file_type')
    return { bytes, type }
  } finally { await handle.close() }
}

// A flat directory of <legacy profile uuid>.<jpg|jpeg|png|webp> files and
// nothing else. The name only supplies the id; the type comes from the bytes.
export async function scanPhotoSource(sourceDir) {
  await privateDirectory(sourceDir, 'profile_photo_source_not_private')
  const entries = await readdir(sourceDir, { withFileTypes: true })
  if (!entries.length || entries.length > MAX_PHOTOS) throw new Error('profile_photo_source_count')
  const photos = new Map(), types = { jpeg: 0, png: 0, webp: 0 }
  let bytes = 0
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const match = entry.name.match(SOURCE_NAME)
    if (!match || !entry.isFile()) throw new Error('profile_photo_source_entry_invalid:' + JSON.stringify(entry.name.slice(0, 80)))
    if (photos.has(match[1])) throw new Error('profile_photo_source_duplicate_id:' + match[1])
    const photo = await readSourcePhoto(join(sourceDir, entry.name))
    photos.set(match[1], { name: entry.name, sha256: sha256(photo.bytes), type: photo.type, bytes: photo.bytes.length })
    types[TYPE_NAMES[photo.type]]++
    bytes += photo.bytes.length
  }
  return { photos, types, bytes }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function writeAtomic(directory, name, bytes) {
  const temporary = join(directory, `.tmp-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(directory, name))
}
async function ensurePrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  await privateDirectory(path, 'profile_photo_store_not_private')
}
async function readPointer(photoDir) {
  const bytes = await readPrivateFile(join(photoDir, 'current.json'), 64 * 1024)
  if (!bytes) return null
  const pointer = JSON.parse(bytes.toString('utf8'))
  if (!validPhotoPointer(pointer)) throw new Error('profile_photo_pointer_invalid')
  return pointer
}
async function writeReceipt(auditDir, report) {
  await privateDirectory(auditDir, 'profile_photo_audit_not_private')
  await writeFile(join(auditDir, `profile-photos-${Date.now()}-${randomUUID().slice(0, 8)}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

// The publication core, on explicit directories (tests use a temporary tree).
// `knownIds` is the set of published People ids; photos for other ids are
// left out of the set and counted in the receipt. Execute requires it.
export async function stageProfilePhotos({ sourceDir, photoDir, auditDir, knownIds = null, execute = false }) {
  if (execute && !(knownIds instanceof Set)) throw new Error('profile_photo_known_ids_required')
  const scan = await scanPhotoSource(sourceDir)
  const unknown = knownIds ? [...scan.photos.keys()].filter(id => !knownIds.has(id)) : []
  const accepted = knownIds ? [...scan.photos].filter(([id]) => knownIds.has(id)) : [...scan.photos]
  if (!accepted.length) throw new Error('profile_photo_set_empty')
  const manifest = { kind: PHOTO_MANIFEST_KIND, version: 1, photos: Object.fromEntries(accepted.map(([id, photo]) => [id, { sha256: photo.sha256, type: photo.type, bytes: photo.bytes }])) }
  if (!validPhotoManifest(manifest)) throw new Error('profile_photo_manifest_invalid')
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestSha256 = sha256(manifestBytes)
  const current = await readPointer(photoDir).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const receipt = { kind: 'profile-photo-publication', sourceDir, photoDir, photos: accepted.length, bytes: scan.bytes, types: scan.types,
    idsChecked: knownIds instanceof Set, unknownIds: unknown.length, unknownSample: unknown.slice(0, 20), manifestSha256, previousManifest: current?.manifest ?? null }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  if (current?.manifest === manifestSha256) return { ...receipt, status: 'UNCHANGED_NO_WRITES' }
  await ensurePrivateDirectory(photoDir)
  const blobs = join(photoDir, 'blobs'), manifests = join(photoDir, 'manifests')
  await ensurePrivateDirectory(blobs); await ensurePrivateDirectory(manifests)
  let written = 0
  for (const [id, photo] of accepted) {
    const existing = await readPrivateFile(join(blobs, photo.sha256), MAX_PHOTO_BYTES)
    if (existing) { if (sha256(existing) !== photo.sha256) throw new Error('profile_photo_blob_conflict:' + photo.sha256); continue }
    // Re-read the source: it must still be exactly the scanned bytes.
    const { bytes } = await readSourcePhoto(join(sourceDir, photo.name))
    if (sha256(bytes) !== photo.sha256) throw new Error('profile_photo_source_changed:' + id)
    await writeAtomic(blobs, photo.sha256, bytes); written++
  }
  await syncDirectory(blobs)
  await writeAtomic(manifests, `${manifestSha256}.json`, manifestBytes); await syncDirectory(manifests)
  const history = current ? [current.manifest, ...current.history].filter(value => value !== manifestSha256).slice(0, MAX_HISTORY) : []
  const pointer = { kind: PHOTO_POINTER_KIND, manifest: manifestSha256, history, publishedAt: new Date().toISOString() }
  await writeAtomic(photoDir, 'current.json', Buffer.from(JSON.stringify(pointer))); await syncDirectory(photoDir)
  // Read the live set back the way the runtime does, every photo.
  const store = createProfilePhotoStore({ directory: photoDir, refreshMs: 0 })
  for (const [id, photo] of accepted) if ((await store.read(id))?.sha256 !== photo.sha256) throw new Error('profile_photo_readback_failed:' + id)
  const report = { ...receipt, at: pointer.publishedAt, status: 'PUBLISHED_COMPLETE', blobsWritten: written,
    rollback: { command: 'publish-profile-photos.mjs --revoke <root> --execute', restores: history[0] ?? null } }
  await writeReceipt(auditDir, report)
  return report
}

// Points the live set back at the previous manifest (or at no photos when
// there is none). Blobs and manifests are never deleted, so this is instant.
export async function revokeProfilePhotos({ photoDir, auditDir, execute = false }) {
  const current = await readPointer(photoDir).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!current) throw new Error('profile_photo_nothing_published')
  const restore = current.history[0] ?? null
  if (restore) {
    const bytes = await readPrivateFile(join(photoDir, 'manifests', `${restore}.json`), 8 * 1024 * 1024)
    if (!bytes || sha256(bytes) !== restore || !validPhotoManifest(JSON.parse(bytes.toString('utf8')))) throw new Error('profile_photo_previous_manifest_invalid')
  }
  const receipt = { kind: 'profile-photo-revocation', photoDir, revokedManifest: current.manifest, restoredManifest: restore }
  if (!execute) return { ...receipt, status: 'PLANNED_NO_WRITES' }
  if (restore) await writeAtomic(photoDir, 'current.json', Buffer.from(JSON.stringify({ kind: PHOTO_POINTER_KIND, manifest: restore, history: current.history.slice(1), publishedAt: new Date().toISOString() })))
  else await unlink(join(photoDir, 'current.json'))
  await syncDirectory(photoDir)
  const report = { ...receipt, at: new Date().toISOString(), status: 'REVOKED' }
  await writeReceipt(auditDir, report)
  return report
}

// The published People ids photos may attach to: the recovered legacy dataset,
// read through the same graph store the runtime uses (inside the runtime container).
async function readLegacyIds(root) {
  if (!process.env.NOOS_PRIVATE_PASSWORD) throw new Error('private_graph_configuration_required')
  const require = createRequire(join(root, 'runtime/noos/package.json')), neo4j = require('neo4j-driver')
  const { UnlinkedPublicPeopleStore } = require(join(root, 'runtime/noos/dist/operational/public-people.js'))
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  try {
    const store = new UnlinkedPublicPeopleStore(driver, 'neo4j'); await store.initialize()
    const legacy = await store.read('recovered-legacy-public-v1')
    if (!legacy) throw new Error('profile_photo_legacy_dataset_required')
    return new Set(legacy.profiles.map(value => value.id).filter(id => PHOTO_ID.test(id)))
  } finally { await driver.close() }
}

const targets = root => ({ photoDir: join(root, 'assets', PHOTO_DIRECTORY), auditDir: join(root, 'audit') })
function checkRoot(root) { if (root !== PILOT_ROOT) throw new Error('explicit_private_photo_target_required') }

export async function publishProfilePhotos({ sourceDir, root, execute = false, readKnownIds = readLegacyIds }) {
  checkRoot(root)
  const { photoDir, auditDir } = targets(root)
  if (typeof sourceDir !== 'string' || resolve(sourceDir) !== sourceDir || !sourceDir.startsWith(root + '/') || sourceDir.startsWith(photoDir + '/') || sourceDir === photoDir) throw new Error('explicit_private_photo_target_required')
  await privateDirectory(root, 'private_photo_root_required')
  await privateDirectory(join(root, 'assets'), 'private_photo_root_required')
  // Plan mode checks ids too whenever the graph is reachable (always inside the runtime).
  const knownIds = execute || process.env.NOOS_PRIVATE_PASSWORD ? await readKnownIds(root) : null
  return stageProfilePhotos({ sourceDir, photoDir, auditDir, knownIds, execute })
}

export async function revokePublishedProfilePhotos({ root, execute = false }) {
  checkRoot(root)
  await privateDirectory(root, 'private_photo_root_required')
  return revokeProfilePhotos({ ...targets(root), execute })
}

export async function profilePhotoStatus({ root }) {
  checkRoot(root)
  const { photoDir } = targets(root)
  const pointer = await readPointer(photoDir).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!pointer) return { status: 'NONE_PUBLISHED', photoDir }
  const bytes = await readPrivateFile(join(photoDir, 'manifests', `${pointer.manifest}.json`), 8 * 1024 * 1024)
  const manifest = bytes && sha256(bytes) === pointer.manifest ? JSON.parse(bytes.toString('utf8')) : null
  return { status: manifest && validPhotoManifest(manifest) ? 'PUBLISHED' : 'MANIFEST_INVALID', photoDir, ...pointer, photos: manifest ? Object.keys(manifest.photos).length : null }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), execute = args.at(-1) === '--execute'
  const rest = execute ? args.slice(0, -1) : args
  let result
  if (rest[0] === '--revoke' && rest.length === 2) result = await revokePublishedProfilePhotos({ root: rest[1], execute })
  else if (rest[0] === '--status' && rest.length === 2 && !execute) result = await profilePhotoStatus({ root: rest[1] })
  else if (rest.length === 2 && !rest[0].startsWith('--')) result = await publishProfilePhotos({ sourceDir: rest[0], root: rest[1], execute })
  else throw new Error('usage: <sourceDir> <root> [--execute] | --revoke <root> [--execute] | --status <root>')
  console.log(JSON.stringify(result))
}
