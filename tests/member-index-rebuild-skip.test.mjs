// The member index rebuilds on its freshness interval. When nothing it reads
// has changed, the kept snapshot is reused as-is (no reassembly); any change
// or an explicit invalidation still yields a full rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const legacy = { state: 'published', complete: true, revision: 'legacy-v1', profiles: [{ id: 'legacy-1', name: 'Legacy Person', positions: [], education: [], skills: [] }], connections: [] }

function world(count) {
  const imports = new Map(), items = []
  for (let n = 0; n < count; n++) {
    const id = sha('import' + n), owner = { ownerId: 'owner-' + n, userId: 'user-' + n }
    const rows = [{ id: sha('own' + n), importId: id, ownerId: owner.ownerId, category: 'profile', fields: { 'first name': 'Member', 'last name': String(n) } },
      { id: sha('c' + n), importId: id, ownerId: owner.ownerId, category: 'connections', subject: `https://www.linkedin.com/in/p-${n}`, fields: { 'first name': 'Contact', 'last name': String(n), url: `https://www.linkedin.com/in/p-${n}` } }]
    const job = { id, ownerId: owner.ownerId, archiveSha256: sha('a' + n), consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: rows.length, indexed: rows.length, rejected: 0, skippedFiles: 0, failedFiles: 0 }, assertionIds: rows.map(row => row.id) }
    imports.set(id, { job, rows, revision: 4 }); items.push({ id, owner, revision: 4 })
  }
  let clock = 0, importReads = 0, decisions = []
  const backend = owner => ({ readResource: async (type, key) => {
    if (type === 'import' && imports.has(key)) { const entry = imports.get(key); return { sourceId: key, sourceOwnerId: owner.ownerId, sourceRevision: entry.revision, payload: entry.job } }
    const row = [...imports.values()].flatMap(entry => entry.rows).find(value => value.id === key)
    return row && row.ownerId === owner.ownerId ? { sourceOwnerId: owner.ownerId, payload: row } : null
  } })
  const read = createMemberPublicIndex({ includeDetails: true, freshMs: 1000, now: () => clock,
    readLegacy: async () => legacy, discover: async () => items.map(item => ({ ...item })), getBackend: async owner => backend(owner),
    readDecisions: async () => decisions,
    publicPeople: { read: async dataset => { if (ENRICHMENT_DATASETS.includes(dataset)) return null; importReads++; const entry = imports.get(dataset.slice('public-import-'.length)); return entry ? projectPublicMemberImport({ job: entry.job, assertions: entry.rows }) : null }, publish: async () => {} } })
  return { read, imports, items, tick: () => { clock += 2000 }, importReads: () => importReads, setDecisions: value => { decisions = value } }
}

test('an unchanged source is reused after the first fingerprinted rebuild; changes still rebuild', async () => {
  const w = world(3)
  const first = await w.read()
  assert.equal(w.importReads(), 3, 'cold build reads every import dataset')
  w.tick(); const second = await w.read()
  assert.equal(w.importReads(), 6, 'first due rebuild has no fingerprint to compare and builds')
  assert.equal(second.revision, first.revision)
  w.tick(); const third = await w.read()
  assert.equal(w.importReads(), 6, 'unchanged inputs: no rebuild')
  assert.equal(third, second, 'the kept snapshot object itself is reused')
  // A republished import (new source revision) rebuilds.
  const changed = w.items[1]
  changed.revision = 5; w.imports.get(changed.id).revision = 5
  w.tick(); const fourth = await w.read()
  assert.equal(w.importReads(), 9, 'a changed import source revision rebuilds')
  assert.notEqual(fourth, third)
  // An operator decision changes the fingerprint even though it is applied after the revision.
  w.tick(); await w.read(); const before = w.importReads()
  w.setDecisions([{ id: 'rename-1', kind: 'rename', profileId: 'legacy-1', name: 'Renamed Person' }])
  w.tick(); const renamed = await w.read()
  assert.equal(w.importReads(), before + 3, 'a decision change rebuilds')
  assert.ok(renamed.profiles.length > 0)
})

test('invalidate still forces a full rebuild immediately', async () => {
  const w = world(2)
  await w.read(); w.tick(); await w.read(); w.tick(); const reused = await w.read()
  const reads = w.importReads()
  w.read.invalidate()
  const rebuilt = await w.read()
  assert.equal(w.importReads(), reads + 2, 'invalidate drops the kept build; the next read builds')
  assert.notEqual(rebuilt, reused)
  assert.equal(rebuilt.revision, reused.revision)
})

test('a source change detected by the fingerprint read fails like the build, never reusing', async () => {
  const w = world(2)
  await w.read(); w.tick(); await w.read()
  // The import's live resource now disagrees with the discovered revision.
  w.imports.get(w.items[0].id).revision = 9
  w.tick()
  await assert.rejects(w.read(), /public_member_source_changed/)
})
