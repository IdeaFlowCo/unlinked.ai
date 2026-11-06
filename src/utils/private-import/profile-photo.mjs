// The owner's profile photo from their own LinkedIn export (unlinked-ff0p,
// docs/profile-photos.md). The export holds no image, only signed
// media.licdn.com links in Rich_Media.csv; the import worker downloads the
// newest one that works, once, under tight bounds, and keeps the bytes as an
// owner-private asset. The link itself is never stored outside the original
// archive.
import { createHash } from 'node:crypto'
import { linkedinMediaUrl } from './archive.mjs'

export const PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024
export const PROFILE_PHOTO_TIMEOUT_MS = 15000
export const PROFILE_PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])

export function sniffPhotoType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// A signed link carries its expiry (`e`, seconds); an expired one is not tried.
const expired = (url, now) => { const e = Number(url.searchParams.get('e')); return Number.isFinite(e) && e > 0 && e * 1000 <= now }

// Downloads one LinkedIn media link. Throws a short reason code on any failure.
export async function fetchLinkedinPhoto(link, { fetchImpl = fetch, now = Date.now, timeoutMs = PROFILE_PHOTO_TIMEOUT_MS } = {}) {
  const url = linkedinMediaUrl(link)
  if (!url) throw new Error('photo_link_invalid')
  if (expired(url, now())) throw new Error('photo_link_expired')
  let response
  try { response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'image/jpeg,image/png,image/webp' } }) }
  catch { throw new Error('photo_fetch_failed') }
  if (!response.ok) throw new Error('photo_fetch_status')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > PROFILE_PHOTO_MAX_BYTES) throw new Error('photo_too_large')
  const chunks = []; let size = 0
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('photo_fetch_failed')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > PROFILE_PHOTO_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error('photo_too_large') }
    chunks.push(Buffer.from(value))
  }
  const bytes = Buffer.concat(chunks)
  const type = sniffPhotoType(bytes)
  if (!bytes.length || !type) throw new Error('photo_not_an_image')
  return { bytes, type, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// The newest profile-photo row that downloads, from parsed rows of the
// profile_photo source. Returns { photo, row } or { reason } with the last
// failure; never throws.
export async function firstWorkingPhoto(rows, { fetchPhoto, now = Date.now } = {}) {
  const ordered = [...rows].sort((a, b) => b.uploadedAt - a.uploadedAt)
  let reason = 'no_profile_photo_rows'
  for (const row of ordered.slice(0, 5)) {
    try { return { photo: await fetchPhoto(row.fields['media link'], { now }), row } }
    catch (error) { reason = /^photo_[a-z_]+$/.test(error?.message) ? error.message : 'photo_fetch_failed' }
  }
  return { reason }
}
