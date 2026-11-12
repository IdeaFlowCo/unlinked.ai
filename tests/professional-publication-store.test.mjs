import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PROFESSIONAL_PEOPLE_DATASET as DATASET, prepareProfessionalSnapshot, professionalProfileId } from '../src/utils/public-people/professional-profiles.mjs'
import { publishProfessionalSnapshot } from '../mcp-server/publish-professional-people.mjs'
import { hydrateProfessionalSnapshot, professionalManifestPath, professionalStorageSnapshot, withProfessionalProfileDetails, writeProfessionalManifest } from '../mcp-server/professional-people-manifest.mjs'
import { cachePublicPeopleReads } from '../src/utils/public-people/cached-store.mjs'

const person = slug => ({ id: professionalProfileId(`https://www.linkedin.com/in/${slug}`), name: 'Fictional Person', linkedinUrl: `https://www.linkedin.com/in/${slug}`, website: 'https://example.com/', about: 'Reviewed public biography', positions: [], education: [], skills: [] })
const prepare = rows => prepareProfessionalSnapshot(Buffer.from(JSON.stringify(rows)))
// The installed Noos whitelist reported by the release executor. This fake is
// deliberately narrower than our public DTO; the optional test uses Noos itself.
const validatePublicSnapshot = snapshot => {
  const fields = new Set(['id','name','headline','location','about','company','positions','education','skills'])
  if (snapshot.profiles.some(row => Object.keys(row).some(key => !fields.has(key)))) throw Error('public_snapshot_invalid')
  return snapshot
}
async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), '.professional-store-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'audit'), { mode: 0o700 })
  return root
}
function fakeStore() {
  let current = null
  const writes = []
  return { writes, read: async () => structuredClone(current),
    async publish(dataset, snapshot, source, expected) {
      assert.equal(dataset, DATASET)
      validatePublicSnapshot(snapshot)
      if ((current?.revision ?? null) !== expected) throw Error('store_compare_and_set_failed')
      writes.push({ dataset, snapshot: structuredClone(snapshot), source, expected })
      current = structuredClone(snapshot)
    },
    revoke: () => { current = null },
  }
}
const receipt = { kind: 'professional-people-publication', dataset: DATASET, sourceSha256: 'a'.repeat(64) }

test('Noos-compatible storage keeps stable IDs and restores only validated manifest details', async t => {
  const root = await fixture(t), full = prepare([person('ada-fixture')]), stored = professionalStorageSnapshot(full)
  assert.throws(() => validatePublicSnapshot(full), /public_snapshot_invalid/)
  assert.doesNotThrow(() => validatePublicSnapshot(stored))
  assert.equal(stored.profiles[0].id, full.profiles[0].id)
  assert.equal(stored.revision, full.revision)
  assert.equal(stored.profiles[0].linkedinUrl, undefined)
  assert.equal(stored.profiles[0].website, undefined)
  const path = await writeProfessionalManifest(root, full)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await hydrateProfessionalSnapshot(root, stored), full)
  const before = await stat(path)
  await writeProfessionalManifest(root, full)
  assert.equal((await stat(path)).ino, before.ino)
  assert.deepEqual(await hydrateProfessionalSnapshot(root, null), null)
})

test('missing, corrupt, foreign, private-field and mismatched manifests fail closed', async t => {
  const root = await fixture(t), full = prepare([person('ada-fixture')]), stored = professionalStorageSnapshot(full)
  const path = professionalManifestPath(root, full.revision)
  await assert.rejects(hydrateProfessionalSnapshot(root, stored), { code: 'ENOENT' })
  await writeProfessionalManifest(root, full)
  for (const changed of [
    { ...stored, profiles: [{ ...stored.profiles[0], about: 'Different biography' }] },
    { ...stored, profiles: [] }, { ...stored, connections: [{ fromId: 'private', toId: 'person' }] },
    { ...stored, privateList: 'never public' },
  ]) await assert.rejects(hydrateProfessionalSnapshot(root, changed), /professional_manifest_snapshot_mismatch/)
  await assert.rejects(hydrateProfessionalSnapshot(root, { ...stored, revision: 'foreign:' + 'a'.repeat(64) }), /professional_manifest_revision_invalid/)
  await writeFile(path, JSON.stringify([person('foreign-fixture')]))
  await assert.rejects(hydrateProfessionalSnapshot(root, stored), /professional_manifest_invalid/)
  await assert.rejects(writeProfessionalManifest(root, full), /professional_manifest_collision/)
  await writeFile(path, '{broken')
  await assert.rejects(hydrateProfessionalSnapshot(root, stored), /professional_manifest_invalid/)
  const bytes = Buffer.from(JSON.stringify([{ ...person('private-fixture'), email: 'private@example.com' }]))
  const badRevision = DATASET + ':' + createHash('sha256').update(bytes).digest('hex')
  await writeFile(professionalManifestPath(root, badRevision), bytes, { mode: 0o600 })
  await assert.rejects(hydrateProfessionalSnapshot(root, { ...stored, revision: badRevision }), /professional_rows_invalid/)
  await rm(path)
  const other = await writeProfessionalManifest(root, prepare([person('other-fixture')]))
  await symlink(other, path)
  await assert.rejects(hydrateProfessionalSnapshot(root, stored))
  await rm(path)
  await writeProfessionalManifest(root, full)
  await chmod(path, 0o644)
  await assert.rejects(hydrateProfessionalSnapshot(root, stored), /professional_manifest_file_invalid/)
})

test('publisher persists manifest and audit before CAS, appends hydrated rows, replays and rolls back', async t => {
  const root = await fixture(t), store = fakeStore()
  const originalPublish = store.publish.bind(store)
  store.publish = async (dataset, snapshot, source, expected) => {
    const full = await hydrateProfessionalSnapshot(root, snapshot)
    const audits = (await readdir(join(root, 'audit'))).filter(name => /^professional-people-.*\.json$/.test(name))
    const prepared = await Promise.all(audits.map(async name => JSON.parse(await readFile(join(root, 'audit', name)))))
    assert.ok(prepared.some(audit => audit.status === 'PREPARED' && audit.candidate.revision === full.revision))
    return originalPublish(dataset, snapshot, source, expected)
  }
  const publish = (incoming, expectedRevision) => publishProfessionalSnapshot({ root, store, validatePublicSnapshot, incoming, receipt, expectedRevision })
  const first = await publish(prepare([person('ada-fixture')]), 'none')
  assert.equal(first.status, 'PUBLISHED_COMPLETE')
  assert.deepEqual(JSON.parse(await readFile(first.audit + '.receipt')), first)
  const second = await publish(prepare([person('ben-fixture')]), first.revision)
  assert.equal(second.profiles, 2)
  const audit = JSON.parse(await readFile(second.audit))
  assert.deepEqual(audit.previous, prepare([person('ada-fixture')]))
  assert.deepEqual(audit.candidate.profiles.map(row => row.linkedinUrl).sort(), [person('ada-fixture').linkedinUrl, person('ben-fixture').linkedinUrl])
  const files = await readdir(join(root, 'audit'))
  assert.equal((await publish(prepare([person('ben-fixture')]), first.revision)).status, 'UNCHANGED_NO_WRITES')
  assert.equal(store.writes.length, 2)
  await assert.rejects(publish(prepare([person('cy-fixture')]), first.revision), /professional_publication_changed/)
  assert.deepEqual(await readdir(join(root, 'audit')), files)
  await originalPublish(DATASET, professionalStorageSnapshot(audit.previous), receipt.sourceSha256, second.revision)
  assert.deepEqual(await hydrateProfessionalSnapshot(root, await store.read()), audit.previous)
  store.revoke()
  assert.equal(await hydrateProfessionalSnapshot(root, await store.read()), null)
})

test('store CAS races and failed readback never emit a success receipt', async t => {
  const root = await fixture(t), incoming = prepare([person('ada-fixture')])
  for (const store of [
    { read: async () => null, publish: async () => { throw Error('store_compare_and_set_failed') } },
    { read: async () => null, publish: async () => {} },
  ]) {
    await assert.rejects(publishProfessionalSnapshot({ root, store, validatePublicSnapshot, incoming, receipt, expectedRevision: 'none' }), /store_compare_and_set_failed|professional_publication_readback_failed/)
    assert.equal((await readdir(join(root, 'audit'))).filter(name => name.endsWith('.receipt')).length, 0)
  }
})

test('runtime hydration preserves cached live-pointer identity, other datasets and revocation', async t => {
  const root = await fixture(t), full = prepare([person('ada-fixture')])
  await writeProfessionalManifest(root, full)
  let current = professionalStorageSnapshot(full), reads = 0, digest = 'live-digest'
  const legacy = { revision: 'legacy:fixture' }
  const cached = cachePublicPeopleReads({ read: async dataset => { reads++; return dataset === DATASET ? current : legacy } }, async dataset => dataset === DATASET && current ? { revision: current.revision, digest } : null)
  const runtime = withProfessionalProfileDetails(cached, root)
  assert.deepEqual(await runtime.read(DATASET), full)
  assert.deepEqual(await runtime.read(DATASET), full)
  assert.equal(reads, 1)
  assert.deepEqual(await runtime.revisionOf(DATASET), { revision: full.revision, digest: 'live-digest' })
  digest = 'changed-digest'
  assert.equal((await runtime.revisionOf(DATASET)).digest, digest)
  assert.equal(await runtime.read('legacy'), legacy)
  current = null
  assert.equal(await runtime.revisionOf(DATASET), null)
  assert.equal(await runtime.read(DATASET), null)
})

const noos = process.env.UNLINKED_NOOS_DIR
test('professional storage DTO passes the exact installed Noos validator and reaches the store driver', { skip: noos ? false : 'UNLINKED_NOOS_DIR unavailable; outer executor supplies exact-library cloud integration' }, async () => {
  const { validatePublicSnapshot: validate, UnlinkedPublicPeopleStore } = createRequire(join(noos, 'package.json'))(join(noos, 'dist/operational/public-people.js'))
  const full = prepare([person('ada-fixture')])
  const stored = professionalStorageSnapshot(full)
  assert.doesNotThrow(() => validate(stored))
  const store = new UnlinkedPublicPeopleStore({ session: () => { throw Error('reached_driver') } }, 'neo4j')
  store.ready = true
  await assert.rejects(store.publish(DATASET, stored, receipt.sourceSha256, null), /reached_driver/)
})
