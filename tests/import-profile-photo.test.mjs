// The owner's profile photo from their own LinkedIn export (unlinked-ff0p).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { parseArchive } from '../src/utils/private-import/archive.mjs'
import { fetchLinkedinPhoto, firstWorkingPhoto, PROFILE_PHOTO_MAX_BYTES } from '../src/utils/private-import/profile-photo.mjs'
import { createMemberAwarePhotoStore, PHOTO_ID, PHOTO_URL } from '../mcp-server/profile-photos.mjs'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
// A real-shaped Rich_Media.csv: two profile photos (old one expired), a feed photo, and an off-CDN link.
const link = (expiry, n) => `https://media.licdn.com/dms/image/v2/C4E03AQ${n}/profile-displayphoto-shrink_800_800/0/151648?e=${expiry}&v=beta&t=signature${n}`
const richMedia = ['Date/Time,Media Description,Media Link',
  `"You uploaded a profile photo on January 20, 2018 at 10:07 PM (GMT)",,${link(1739999999, 'old')}`,
  `"You uploaded a profile photo on March 3, 2024 at 9:15 AM (GMT)",,${link(2147483647, 'new')}`,
  `"You uploaded a feed photo on November 15, 2024 at 8:18 PM (GMT)","Private caption words",${link(2147483647, 'feed')}`,
  '"You uploaded a profile photo on April 1, 2024 at 1:00 PM (GMT)",,https://evil.example/dms/image/x.jpg'].join('\n') + '\n'
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
const response = (bytes, { status = 200, headers = {} } = {}) => new Response(bytes, { status, headers })

test('only the owner’s profile-photo rows from LinkedIn’s CDN are read; feed photos and captions never are', async () => {
  const zip = new JSZip(); zip.file('Rich_Media.csv', richMedia); zip.file('Connections.csv', 'First Name,Last Name,URL\nAda,Lovelace,https://www.linkedin.com/in/ada\n')
  const parsed = parseArchive(await zip.generateAsync({ type: 'nodebuffer' }), 'Complete_LinkedInDataExport.zip')
  const photos = parsed.sources.find(source => source.category === 'profile_photo')
  assert.equal(photos.accepted.length, 2)
  assert.deepEqual(photos.accepted.map(row => new Date(row.uploadedAt).toISOString()).sort(), ['2018-01-20T22:07:00.000Z', '2024-03-03T09:15:00.000Z'])
  assert.equal(photos.rejected.length, 0, 'other rows are not even rejections')
  assert.doesNotMatch(JSON.stringify(photos.accepted), /Private caption|feed|evil\.example/)
})

test('an export without profile-photo rows, or an unreadable Rich_Media.csv, is skipped and never makes the import partial', () => {
  for (const bytes of ['Date/Time,Media Description,Media Link\n"You uploaded a feed photo on November 15, 2024 at 8:18 PM (GMT)",x,https://media.licdn.com/dms/image/a\n', 'not,a,header\n1,2,3\n']) {
    const [source] = parseArchive(Buffer.from(bytes), 'Rich_Media.csv').sources
    assert.equal(source.skipped, true); assert.equal(source.error, undefined); assert.ok(source.photoSkipped)
  }
})

test('the fetcher only takes LinkedIn’s CDN, unexpired, no redirects, bounded, real images', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return response(JPEG, { headers: { 'content-length': String(JPEG.length) } }) }
  const got = await fetchLinkedinPhoto(link(2147483647, 'new'), { fetchImpl })
  assert.equal(got.type, 'image/jpeg'); assert.equal(got.sha256, sha(JPEG))
  assert.equal(calls[0].options.redirect, 'error')
  for (const [bad, reason] of [[link(1739999999, 'old'), 'photo_link_expired'], ['https://evil.example/dms/image/x', 'photo_link_invalid'], ['http://media.licdn.com/dms/image/x', 'photo_link_invalid'], ['https://media.licdn.com:8443/dms/image/x', 'photo_link_invalid'], ['https://u:p@media.licdn.com/dms/image/x', 'photo_link_invalid']])
    await assert.rejects(fetchLinkedinPhoto(bad, { fetchImpl }), new RegExp(reason))
  assert.equal(calls.length, 1, 'rejected links are never requested')
  await assert.rejects(fetchLinkedinPhoto(link(2147483647, 'a'), { fetchImpl: async () => response(Buffer.from('<html>no</html>')) }), /photo_not_an_image/)
  await assert.rejects(fetchLinkedinPhoto(link(2147483647, 'a'), { fetchImpl: async () => response(Buffer.alloc(PROFILE_PHOTO_MAX_BYTES + 1, 0xff)) }), /photo_too_large/)
  await assert.rejects(fetchLinkedinPhoto(link(2147483647, 'a'), { fetchImpl: async () => response(JPEG, { status: 403 }) }), /photo_fetch_status/)
  await assert.rejects(fetchLinkedinPhoto(link(2147483647, 'a'), { fetchImpl: async () => { throw new TypeError('redirect') } }), /photo_fetch_failed/)
  // The newest working link wins; failures fall back to older ones and report the last reason.
  const rows = [{ uploadedAt: 1, fields: { 'media link': 'old' } }, { uploadedAt: 2, fields: { 'media link': 'new' } }]
  const order = []
  assert.equal((await firstWorkingPhoto(rows, { fetchPhoto: async value => { order.push(value); if (value === 'new') throw Error('photo_link_expired'); return { ok: value } } })).row.fields['media link'], 'old')
  assert.deepEqual(order, ['new', 'old'])
  assert.deepEqual(await firstWorkingPhoto(rows, { fetchPhoto: async () => { throw Error('photo_fetch_status') } }), { reason: 'photo_fetch_status' })
})

test('member photo ids and URLs: legacy uuids plus member-signup / member-import ids, nothing else', () => {
  const member = 'member-import-' + 'a'.repeat(64)
  assert.ok(PHOTO_ID.test(member)); assert.ok(PHOTO_ID.test('member-signup-' + 'b'.repeat(64))); assert.ok(PHOTO_ID.test('12345678-1234-1234-1234-123456789abc'))
  for (const bad of ['member-import-xyz', 'public-' + 'a'.repeat(64), '../etc', 'member-import-' + 'A'.repeat(64)]) assert.ok(!PHOTO_ID.test(bad), bad)
  assert.ok(PHOTO_URL.test(`/people/${member}/photo?v=${'c'.repeat(16)}`))
})

test('the member-aware store serves the owner’s own photo first, re-verifying bytes, and falls back to the operator set', async () => {
  const id = 'member-signup-' + 'd'.repeat(64), owner = { ownerId: 'o', userId: 'u' }
  const operator = { refresh: async () => {}, urlFor: value => value === 'legacy-uuid' ? '/people/x/photo?v=1' : null, read: async value => value === id ? { bytes: Buffer.from('operator'), type: 'image/jpeg', sha256: 'op' } : null }
  let assets = new Map([[sha(JPEG), JPEG]])
  const members = new Map([[id, { owner, sha256: sha(JPEG), type: 'image/jpeg', bytes: JPEG.length }]])
  const store = createMemberAwarePhotoStore({ operator, members: () => members, readOwnerAsset: async (who, key) => { assert.deepEqual(who, owner); return assets.get(key) } })
  assert.equal(store.urlFor(id), `/people/${id}/photo?v=${sha(JPEG).slice(0, 16)}`)
  assert.deepEqual(await store.read(id), { bytes: JPEG, type: 'image/jpeg', sha256: sha(JPEG) })
  assert.equal(store.urlFor('legacy-uuid'), '/people/x/photo?v=1')
  assets = new Map([[sha(JPEG), Buffer.concat([JPEG, Buffer.from('x')])]])
  await assert.rejects(store.read(id), /profile_photo_blob_invalid/)
  const hiddenStore = createMemberAwarePhotoStore({ operator, members: () => members, readOwnerAsset: async () => JPEG, hidden: value => value === id })
  assert.equal((await hiddenStore.read(id)).sha256, 'op', 'a hidden member photo falls back, it is never served')
})

test('the public index hands the server each account’s newest photo on its resolved profile, never in the snapshot', async () => {
  const id = 'e'.repeat(64), owner = { ownerId: 'bound-owner', userId: 'bound-user' }
  const assertions = [{ id: 'b'.repeat(64), importId: id, ownerId: owner.ownerId, category: 'profile', fields: { 'first name': 'Test', 'last name': 'Member' } },
    { id: 'd'.repeat(64), importId: id, ownerId: owner.ownerId, category: 'profile_photo', subject: 'archive_owner_observation', fields: { 'photo sha256': sha(JPEG), 'photo type': 'image/jpeg', 'photo bytes': String(JPEG.length), 'uploaded at': '2024-03-03T09:15:00.000Z' } }]
  const job = { id, ownerId: owner.ownerId, archiveSha256: 'c'.repeat(64), consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: 2, indexed: 2, rejected: 0, skippedFiles: 0, failedFiles: 0 }, assertionIds: assertions.map(row => row.id) }
  assert.equal(projectPublicMemberImport({ job, assertions }).ownPhoto, undefined, 'the cached public projection carries no photo')
  let photos
  const read = createMemberPublicIndex({ includeDetails: true, onMemberPhotos: map => { photos = map },
    readLegacy: async () => ({ state: 'published', complete: true, revision: 'legacy-v1', profiles: [], connections: [] }), discover: async () => [{ id, owner, revision: 4 }],
    getBackend: async () => ({ readResource: async (type, key) => type === 'import' ? { sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: 4, payload: job } : { sourceOwnerId: owner.ownerId, payload: assertions.find(row => row.id === key) } }),
    publicPeople: { read: async dataset => ENRICHMENT_DATASETS.includes(dataset) ? null : projectPublicMemberImport({ job, assertions }), publish: async () => {} } })
  const snapshot = await read().catch(error => { throw error })
  assert.ok(photos instanceof Map)
  const entry = photos.get('member-import-' + id)
  assert.deepEqual({ ...entry, owner: { ...entry.owner } }, { owner, sha256: sha(JPEG), type: 'image/jpeg', bytes: JPEG.length })
  assert.doesNotMatch(JSON.stringify(snapshot), /bound-owner|ownPhoto/)
})
