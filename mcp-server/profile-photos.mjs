import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

// Operator-published profile photos (docs/profile-photos.md). Not user uploads:
// an offline publisher (publish-profile-photos.mjs) writes them, and the runtime
// only reads them and serves them same-origin at /people/<id>/photo.
//
// Layout under <root>/assets/profile-photos.public (the dot keeps the name
// outside every owner-asset key grammar, so no owner directory can collide):
//   blobs/<sha256>                content-addressed image bytes, immutable
//   manifests/<sha256>.json       { kind, version, photos: { <id>: { sha256, type, bytes } } }
//   current.json                  { kind, manifest, history: [older manifests, newest first], publishedAt }
// Publishing writes blobs and a new manifest, then swaps current.json by rename;
// revoking points current.json back at history[0].
export const PHOTO_DIRECTORY = 'profile-photos.public'
export const PHOTO_MANIFEST_KIND = 'unlinked-profile-photos'
export const PHOTO_POINTER_KIND = 'unlinked-profile-photos-pointer'
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
export const MAX_PHOTOS = 20000
export const MAX_HISTORY = 20
// Public People profile ids that photos are keyed by: the legacy profile uuid.
export const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const PHOTO_URL = /^\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/photo\?v=[a-f0-9]{16}$/
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
const SHA256 = /^[a-f0-9]{64}$/

export const sha256 = value => createHash('sha256').update(value).digest('hex')
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

// The type comes from the bytes only, never from a file name.
export function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

// A manifest is valid only as a whole: one bad entry rejects the set.
export function validPhotoManifest(value) {
  if (!plain(value) || value.kind !== PHOTO_MANIFEST_KIND || value.version !== 1 || !plain(value.photos)) return false
  const entries = Object.entries(value.photos)
  if (entries.length > MAX_PHOTOS) return false
  return entries.every(([id, entry]) => PHOTO_ID.test(id) && plain(entry) && Object.keys(entry).length === 3 && SHA256.test(entry.sha256) &&
    PHOTO_TYPES.includes(entry.type) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_PHOTO_BYTES)
}

export function validPhotoPointer(value) {
  return plain(value) && value.kind === PHOTO_POINTER_KIND && SHA256.test(value.manifest) && Array.isArray(value.history) &&
    value.history.length <= MAX_HISTORY && value.history.every(entry => SHA256.test(entry)) && typeof value.publishedAt === 'string'
}

// Reads one private regular file without following a link; null when absent.
export async function readPrivateFile(path, maxBytes) {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    const state = await handle.stat()
    if (!state.isFile() || state.size > maxBytes) throw new Error('profile_photo_file_invalid')
    return await handle.readFile()
  } finally { await handle.close() }
}

export const photoUrl = (id, entry) => `/people/${id}/photo?v=${entry.sha256.slice(0, 16)}`

// The runtime reader. `hidden(id)` is the precedence hook: when a member's own
// choice says "no photo" (not built yet), returning true hides it everywhere,
// both from pages (urlFor) and from the photo route (read).
export function createProfilePhotoStore({ directory, hidden = () => false, refreshMs = 30000, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !directory.startsWith('/') || typeof hidden !== 'function' || !Number.isSafeInteger(refreshMs) || refreshMs < 0) throw new TypeError('profile_photo_configuration_invalid')
  let state = { manifest: null, photos: new Map() }, checkedAt = -Infinity, inflight = null
  async function load() {
    const directoryState = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!directoryState) return { manifest: null, photos: new Map() }
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) throw new Error('profile_photo_directory_invalid')
    const pointerBytes = await readPrivateFile(join(directory, 'current.json'), 64 * 1024)
    if (!pointerBytes) return { manifest: null, photos: new Map() }
    const pointer = JSON.parse(pointerBytes.toString('utf8'))
    if (!validPhotoPointer(pointer)) throw new Error('profile_photo_pointer_invalid')
    if (pointer.manifest === state.manifest) return state
    const manifestBytes = await readPrivateFile(join(directory, 'manifests', `${pointer.manifest}.json`), 8 * 1024 * 1024)
    if (!manifestBytes || sha256(manifestBytes) !== pointer.manifest) throw new Error('profile_photo_manifest_invalid')
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (!validPhotoManifest(manifest)) throw new Error('profile_photo_manifest_invalid')
    return { manifest: pointer.manifest, photos: new Map(Object.entries(manifest.photos)) }
  }
  // Re-reads the pointer at most once per refreshMs. A broken publication
  // keeps the last good set; a removed pointer means no photos.
  async function refresh() {
    if (now() - checkedAt < refreshMs) return
    if (!inflight) inflight = load().then(value => { state = value }).catch(() => {}).finally(() => { checkedAt = now(); inflight = null })
    await inflight
  }
  const entryFor = id => typeof id === 'string' && PHOTO_ID.test(id) && !hidden(id) ? state.photos.get(id) ?? null : null
  return {
    refresh,
    // Synchronous, from the last refresh: the same-origin URL with a content
    // version, or null when there is no photo (the view shows initials).
    urlFor(id) { const entry = entryFor(id); return entry ? photoUrl(id, entry) : null },
    async read(id) {
      await refresh()
      const entry = entryFor(id)
      if (!entry) return null
      const bytes = await readPrivateFile(join(directory, 'blobs', entry.sha256), MAX_PHOTO_BYTES)
      if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || sniffImageType(bytes) !== entry.type) throw new Error('profile_photo_blob_invalid')
      return { bytes, type: entry.type, sha256: entry.sha256 }
    },
  }
}
