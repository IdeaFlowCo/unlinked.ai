import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfilePhotoStore, sniffImageType, PHOTO_URL, PHOTO_DIRECTORY, MAX_PHOTO_BYTES } from '../mcp-server/profile-photos.mjs'
import { stageProfilePhotos, revokeProfilePhotos, publishProfilePhotos, revokePublishedProfilePhotos, PILOT_ROOT } from '../mcp-server/publish-profile-photos.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPerson, renderPeople, renderCard, renderOwnProfile, renderCompany } from '../mcp-server/private-onboarding-views.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111', B = 'bbbbbbbb-2222-4222-8222-222222222222', C = 'cccccccc-3333-4333-8333-333333333333'
const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, fill), Buffer.from([0xff, 0xd9])])
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 3)])

async function tree(t) {
  const root = await mkdtemp(join(tmpdir(), 'unlinked-photos-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), assets = join(root, 'assets'), audit = join(root, 'audit')
  for (const directory of [source, assets, audit]) await mkdir(directory, { mode: 0o700 })
  return { root, source, audit, photoDir: join(assets, PHOTO_DIRECTORY) }
}
const put = (directory, name, bytes) => writeFile(join(directory, name), bytes, { mode: 0o600 })

test('sniffImageType reads JPEG, PNG and WebP magic bytes only', () => {
  assert.equal(sniffImageType(jpeg()), 'image/jpeg')
  assert.equal(sniffImageType(png()), 'image/png')
  assert.equal(sniffImageType(webp()), 'image/webp')
  assert.equal(sniffImageType(Buffer.from('GIF89a' + 'x'.repeat(20))), null)
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff])), null)
  assert.equal(sniffImageType('not a buffer'), null)
})

test('plan validates the source, counts it and writes nothing', async t => {
  const { source, audit, photoDir } = await tree(t)
  await put(source, `${A}.jpg`, jpeg()); await put(source, `${B}.png`, png()); await put(source, `${C}.webp`, webp())
  const plan = await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit })
  assert.equal(plan.status, 'PLANNED_NO_WRITES')
  assert.equal(plan.photos, 3)
  assert.deepEqual(plan.types, { jpeg: 1, png: 1, webp: 1 })
  assert.equal(plan.idsChecked, false)
  assert.match(plan.manifestSha256, /^[a-f0-9]{64}$/)
  assert.equal((await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit })).manifestSha256, plan.manifestSha256)
  await assert.rejects(stat(photoDir), { code: 'ENOENT' })
  assert.deepEqual(await readdir(audit), [])
  // With the published ids, unknown ids are left out and counted.
  const known = await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds: new Set([A, B]) })
  assert.equal(known.photos, 2); assert.equal(known.unknownIds, 1); assert.deepEqual(known.unknownSample, [C])
})

test('source validation rejects bad names, types, sizes, links, modes and duplicates', async t => {
  const cases = [
    ['bad name', async source => put(source, 'Avery Lee.jpg', jpeg()), /profile_photo_source_entry_invalid/],
    ['uppercase id', async source => put(source, `${A.toUpperCase()}.jpg`, jpeg()), /profile_photo_source_entry_invalid/],
    ['path-like name', async source => put(source, `${A}.jpg.svg`, jpeg()), /profile_photo_source_entry_invalid/],
    ['sidecar file', async source => { await put(source, `${A}.jpg`, jpeg()); await put(source, 'manifest.json', '{}') }, /profile_photo_source_entry_invalid/],
    ['subdirectory', async source => mkdir(join(source, `${A}.jpg`), { mode: 0o700 }), /profile_photo_source_entry_invalid/],
    ['symlink', async (source, root) => { await put(root, 'outside.jpg', jpeg()); await symlink(join(root, 'outside.jpg'), join(source, `${A}.jpg`)) }, /profile_photo_source_entry_invalid/],
    ['not an image', async source => put(source, `${A}.jpg`, Buffer.from('<svg onload=alert(1)></svg>')), /profile_photo_source_file_type/],
    ['gif disguised as jpg', async source => put(source, `${A}.jpg`, Buffer.from('GIF89a' + 'x'.repeat(40))), /profile_photo_source_file_type/],
    ['too large', async source => put(source, `${A}.jpg`, Buffer.concat([jpeg(), Buffer.alloc(MAX_PHOTO_BYTES)])), /profile_photo_source_file_size/],
    ['group readable', async source => { await put(source, `${A}.jpg`, jpeg()); await chmod(join(source, `${A}.jpg`), 0o640) }, /profile_photo_source_file_not_private/],
    ['duplicate id', async source => { await put(source, `${A}.jpg`, jpeg()); await put(source, `${A}.png`, png()) }, /profile_photo_source_duplicate_id/],
    ['empty', async () => {}, /profile_photo_source_count/],
  ]
  for (const [name, setup, error] of cases) {
    const { root, source, audit, photoDir } = await tree(t)
    await setup(source, root)
    await assert.rejects(stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit }), error, name)
  }
  const { source, audit, photoDir } = await tree(t)
  await chmod(source, 0o755)
  await assert.rejects(stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit }), /profile_photo_source_not_private/)
})

test('execute publishes atomically, reads back, writes a receipt, and revoke restores the previous set', async t => {
  const { source, audit, photoDir } = await tree(t)
  const knownIds = new Set([A, B])
  await put(source, `${A}.jpg`, jpeg(1))
  await assert.rejects(stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, execute: true }), /profile_photo_known_ids_required/)
  await assert.rejects(stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds: new Set([C]), execute: true }), /profile_photo_set_empty/)
  const first = await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds, execute: true })
  assert.equal(first.status, 'PUBLISHED_COMPLETE'); assert.equal(first.blobsWritten, 1); assert.equal(first.previousManifest, null)
  for (const path of [photoDir, join(photoDir, 'blobs'), join(photoDir, 'manifests')]) assert.equal((await stat(path)).mode & 0o777, 0o700)
  for (const path of [join(photoDir, 'current.json'), join(photoDir, 'manifests', `${first.manifestSha256}.json`)]) assert.equal((await stat(path)).mode & 0o777, 0o600)
  const receipts = await readdir(audit)
  assert.equal(receipts.length, 1); assert.match(receipts[0], /^profile-photos-\d+-[a-f0-9]{8}\.json$/)
  assert.equal((await stat(join(audit, receipts[0]))).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(join(audit, receipts[0]), 'utf8')).manifestSha256, first.manifestSha256)
  assert.deepEqual((await readdir(join(photoDir, 'blobs'))).filter(name => name.startsWith('.tmp-')), [])

  // The same set again changes nothing.
  assert.equal((await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds, execute: true })).status, 'UNCHANGED_NO_WRITES')

  // A second set: a new photo for A, one for B. The old blob stays for rollback.
  await put(source, `${A}.jpg`, jpeg(2)); await put(source, `${B}.png`, png())
  const second = await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds, execute: true })
  assert.equal(second.previousManifest, first.manifestSha256); assert.equal(second.rollback.restores, first.manifestSha256)
  assert.equal((await readdir(join(photoDir, 'blobs'))).length, 3)
  const store = createProfilePhotoStore({ directory: photoDir, refreshMs: 0 })
  await store.refresh()
  assert.ok(store.urlFor(B)); assert.equal((await store.read(A)).bytes.equals(jpeg(2)), true)

  // Revoke: plan first, then back to the first set, then to none.
  const planned = await revokeProfilePhotos({ photoDir, auditDir: audit })
  assert.deepEqual([planned.status, planned.restoredManifest], ['PLANNED_NO_WRITES', first.manifestSha256])
  await revokeProfilePhotos({ photoDir, auditDir: audit, execute: true })
  assert.ok(store.urlFor(B), "the last set stays until the next refresh")
  await store.refresh()
  assert.equal(store.urlFor(B), null)
  assert.equal((await store.read(A)).bytes.equals(jpeg(1)), true)
  const none = await revokeProfilePhotos({ photoDir, auditDir: audit, execute: true })
  assert.equal(none.restoredManifest, null)
  await assert.rejects(stat(join(photoDir, 'current.json')), { code: 'ENOENT' })
  await store.refresh()
  assert.equal(store.urlFor(A), null); assert.equal(await store.read(A), null)
  await assert.rejects(revokeProfilePhotos({ photoDir, auditDir: audit }), /profile_photo_nothing_published/)
  assert.equal((await readdir(audit)).length, 4)
})

test('publishProfilePhotos refuses foreign roots and source paths outside or inside the store', async () => {
  const root = PILOT_ROOT
  for (const [sourceDir, value] of [[`${root}/runtime/photos`, '/srv/other'], ['runtime/photos', root], ['/elsewhere/photos', root],
    [`${root}/assets/${PHOTO_DIRECTORY}/blobs`, root], [`${root}/runtime/../../etc`, root]]) {
    await assert.rejects(publishProfilePhotos({ sourceDir, root: value, readKnownIds: async () => new Set() }), /explicit_private_photo_target_required/)
  }
  await assert.rejects(revokePublishedProfilePhotos({ root: '/tmp' }), /explicit_private_photo_target_required/)
})

test('the store serves only the published set, honours the hide hook and refuses tampered blobs', async t => {
  const { source, audit, photoDir } = await tree(t)
  await put(source, `${A}.jpg`, jpeg()); await put(source, `${B}.png`, png())
  await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds: new Set([A, B]), execute: true })
  const hiddenIds = new Set()
  const store = createProfilePhotoStore({ directory: photoDir, refreshMs: 0, hidden: id => hiddenIds.has(id) })
  await store.refresh()
  assert.match(store.urlFor(A), PHOTO_URL)
  assert.equal(store.urlFor(C), null); assert.equal(store.urlFor('../etc/passwd'), null); assert.equal(store.urlFor(A.toUpperCase()), null)
  assert.deepEqual(Object.keys(await store.read(B)), ['bytes', 'type', 'sha256'])
  assert.equal((await store.read(B)).type, 'image/png')
  hiddenIds.add(A)
  assert.equal(store.urlFor(A), null); assert.equal(await store.read(A), null)
  const blob = join(photoDir, 'blobs', (await store.read(B)).sha256)
  await writeFile(blob, png().fill(9, 20))
  await assert.rejects(store.read(B), /profile_photo_blob_invalid/)
  // A missing store is simply no photos.
  const empty = createProfilePhotoStore({ directory: join(photoDir, 'absent') })
  await empty.refresh(); assert.equal(empty.urlFor(A), null)
  assert.throws(() => createProfilePhotoStore({ directory: 'relative' }), /profile_photo_configuration_invalid/)
})

test('the public reader attaches only same-origin photo URLs', async () => {
  const snapshot = { state: 'published', complete: true, revision: 'r1', connections: [], profiles: [A, B].map(id => ({ id, name: 'Person ' + id.slice(0, 4), positions: [], education: [], skills: [] })) }
  const urls = { [A]: `/people/${A}/photo?v=0123456789abcdef`, [B]: 'https://images.example.invalid/x.jpg' }
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot, photoFor: id => urls[id] })
  const { profiles } = await reader.list()
  assert.equal(profiles.find(value => value.id === A).photo, urls[A])
  assert.equal(profiles.find(value => value.id === B).photo, undefined)
  assert.equal((await reader.profile({ id: A })).profile.photo, urls[A])
  assert.equal((await createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot }).list()).profiles[0].photo, undefined)
  assert.throws(() => createPublicPeopleReader({ photoFor: 'no' }), /public_people_configuration_invalid/)
})

test('views show the photo with the name as alt text, and initials otherwise, without inline styles', () => {
  const photo = `/people/${A}/photo?v=0123456789abcdef`
  const withPhoto = renderPerson({ profile: { id: A, name: 'Avery Lee', photo, positions: [], education: [], skills: [], connections: [{ id: B, name: 'Morgan Shaw' }] } }).content
  assert.match(withPhoto, new RegExp(`<img class="pav photo tone-\\d" src="${photo.replace(/[?]/g, '\\?')}" alt="Avery Lee"`))
  assert.doesNotMatch(withPhoto, /<div class="pav[^"]*">AL<\/div>/)
  assert.match(withPhoto, /<span class="initials avatar tone-\d" aria-hidden="true">MS<\/span>/)
  const without = renderPerson({ profile: { id: A, name: 'Avery Lee', positions: [], education: [], skills: [] } }).content
  assert.match(without, /<div class="pav tone-\d">AL<\/div>/); assert.doesNotMatch(without, /<img/)
  // Anything but the exact same-origin photo grammar falls back to initials.
  for (const bad of ['https://images.example.invalid/photo/x.jpg', 'data:image/png;base64,AAAA', `/people/${A}/photo`, `//evil.example/people/${A}/photo?v=0123456789abcdef`, `/people/${A}/photo?v=0123456789abcdef" onerror="x`]) {
    assert.doesNotMatch(renderPerson({ profile: { id: A, name: 'Avery Lee', photo: bad, positions: [], education: [], skills: [] } }).content, /<img/, bad)
  }
  const people = renderPeople({ everyone: [{ id: A, name: 'Avery Lee', photo }, { id: B, name: 'Morgan <b>' }] }).content
  assert.match(people, new RegExp(`<img class="avatar photo tone-\\d" src="${photo.replace(/[?]/g, '\\?')}" alt="Avery Lee" width="44" height="44" loading="lazy"`))
  assert.match(people, /aria-hidden="true">M&lt;<\/span>/)
  assert.doesNotMatch(people, / style=/)
  const card = renderCard({ csrf: 'c', profile: { name: 'Avery "AL" Lee', photo }, cardUrl: `https://www.unlinked.ai/people/${A}`, qr: '<svg></svg>' }).content
  assert.match(card, /<img class="bc-av photo" src="[^"]+" alt="Avery &quot;AL&quot; Lee" width="64" height="64"/)
  assert.match(renderCard({ csrf: 'c', profile: { name: 'Avery Lee' } }).content, /<span class="bc-av" aria-hidden="true">AL<\/span>/)
  assert.match(renderOwnProfile({ csrf: 'c', profile: { name: 'Avery Lee', photo } }).content, /<img class="pav photo" src="[^"]+" alt="Avery Lee"/)
  assert.match(renderCompany({ name: 'Northwind Solar', people: [{ id: A, name: 'Avery Lee', photo }], total: 1 }).content, /<a class="crow" href="\/people\/[^"]+"><img class="avatar photo/)
  for (const content of [withPhoto, card]) assert.doesNotMatch(content, / style=/)
})

test('GET/HEAD /people/<id>/photo serves published photos same-origin with nosniff and caching, 404 otherwise', async t => {
  const { source, audit, photoDir } = await tree(t)
  await put(source, `${A}.jpg`, jpeg()); await put(source, `${B}.webp`, webp())
  await stageProfilePhotos({ sourceDir: source, photoDir, auditDir: audit, knownIds: new Set([A, B]), execute: true })
  const profilePhotos = createProfilePhotoStore({ directory: photoDir })
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const snapshot = { state: 'published', complete: true, revision: 'r1', connections: [], profiles: [{ id: A, name: 'Avery Lee', positions: [], education: [], skills: [] }, { id: C, name: 'No Photo', positions: [], education: [], skills: [] }] }
  handler = createPrivateBrowserHandler({ baseUrl, login: { begin: async () => {}, finish: async () => {} }, resolveOwner: async () => null,
    getBackend: async () => { throw new Error('no private reads') }, readPublishedSnapshot: async () => snapshot, profilePhotos })
  const request = (path, options) => fetch(endpoint + path, { redirect: 'manual', ...options })

  // Pages link the photo with its content version; the person without one keeps initials.
  const page = await (await request('/people')).text()
  const src = page.match(new RegExp(`src="(/people/${A}/photo\\?v=[a-f0-9]{16})" alt="Avery Lee"`))?.[1]
  assert.ok(src, 'people list links the photo')
  assert.match(page, /aria-hidden="true">NP<\/span>/)
  assert.match((await request(`/people/${A}`).then(response => response.text())), /<img class="pav photo/)
  const json = await (await request(`/api/people/${A}`)).json()
  assert.equal(json.profile.photo, src)

  const response = await request(src)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.match(response.headers.get('etag'), /^"[a-f0-9]{64}"$/)
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(jpeg()))
  // Without the current version the photo is still served, briefly cached.
  const unversioned = await request(`/people/${A}/photo`)
  assert.equal(unversioned.status, 200); assert.equal(unversioned.headers.get('cache-control'), 'public, max-age=300')
  assert.equal((await request(`/people/${B}/photo`)).headers.get('content-type'), 'image/webp')
  const etag = response.headers.get('etag')
  const revalidated = await request(`/people/${A}/photo`, { headers: { 'If-None-Match': etag } })
  assert.equal(revalidated.status, 304); assert.equal((await revalidated.arrayBuffer()).byteLength, 0)

  const head = await request(src, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/jpeg')
  assert.equal(head.headers.get('content-length'), String(jpeg().length)); assert.equal((await head.arrayBuffer()).byteLength, 0)

  for (const path of [`/people/${C}/photo`, `/people/${A.toUpperCase()}/photo`, '/people/not-a-uuid/photo', '/people/..%2F..%2Fetc%2Fpasswd/photo', `/people/${A}%00/photo`, `/people/${A}.jpg/photo`]) {
    const missing = await request(path)
    assert.equal(missing.status, 404, path); assert.equal(missing.headers.get('cache-control'), 'no-store', path)
  }
  assert.equal((await request(`/people/${C}/photo`, { method: 'HEAD' })).status, 404)
  assert.equal((await request(`/people/${A}/photo`, { method: 'PUT' })).status, 405)
  assert.equal((await request(`/people/${A}`, { method: 'HEAD' })).status, 200)
})

test('without a photo store the photo route does not exist and pages keep initials', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const snapshot = { state: 'published', complete: true, revision: 'r1', connections: [], profiles: [{ id: A, name: 'Avery Lee', positions: [], education: [], skills: [] }] }
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => {}, finish: async () => {} }, resolveOwner: async () => null,
    getBackend: async () => { throw new Error('no private reads') }, readPublishedSnapshot: async () => snapshot })
  assert.equal((await fetch(`${endpoint}/people/${A}/photo`, { method: 'HEAD' })).status, 405)
  assert.doesNotMatch(await (await fetch(`${endpoint}/people`)).text(), /<img/)
  assert.throws(() => createPrivateBrowserHandler({ baseUrl: 'https://x.invalid', login: { begin() {}, finish() {} }, resolveOwner: async () => null, getBackend: async () => null, profilePhotos: {} }), /profile_photo_configuration_required/)
})
