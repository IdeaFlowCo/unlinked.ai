// Cold-start warm-up of the public index (unlinked index warm-up, 2026-11-06):
// after a restart every import's details are read again; they are now fetched
// a few imports at a time instead of strictly one after another.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const legacy = { state: 'published', complete: true, revision: 'legacy-v1', profiles: [], connections: [] }

function world(count, delayMs) {
  const imports = new Map(), assertionsById = new Map(), items = []
  for (let n = 0; n < count; n++) {
    const id = sha('import' + n), owner = { ownerId: 'owner-' + n, userId: 'user-' + n }
    const rows = [{ id: sha('own' + n), importId: id, ownerId: owner.ownerId, category: 'profile', fields: { 'first name': 'Member', 'last name': String(n) } },
      ...[0, 1, 2].map(k => ({ id: sha(`c${n}-${k}`), importId: id, ownerId: owner.ownerId, category: 'connections', subject: `https://www.linkedin.com/in/p-${n}-${k}`, fields: { 'first name': 'Contact', 'last name': `${n}-${k}`, url: `https://www.linkedin.com/in/p-${n}-${k}` } }))]
    for (const row of rows) assertionsById.set(row.id, row)
    const job = { id, ownerId: owner.ownerId, archiveSha256: sha('a' + n), consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: rows.length, indexed: rows.length, rejected: 0, skippedFiles: 0, failedFiles: 0 }, assertionIds: rows.map(row => row.id) }
    imports.set(id, { job, rows }); items.push({ id, owner, revision: 4 })
  }
  let inFlight = 0, peak = 0, detailReads = 0
  const wait = () => new Promise(resolve => setTimeout(resolve, delayMs))
  const backend = owner => ({ readResource: async (type, key) => {
    if (type === 'import' && imports.has(key)) { const { job } = imports.get(key); return { sourceId: key, sourceOwnerId: owner.ownerId, sourceRevision: 4, payload: job } }
    inFlight++; peak = Math.max(peak, inFlight); detailReads++
    try { await wait(); const row = assertionsById.get(key); return row && row.ownerId === owner.ownerId ? { sourceOwnerId: owner.ownerId, payload: row } : null } finally { inFlight-- }
  } })
  const index = () => createMemberPublicIndex({ includeDetails: true, readLegacy: async () => legacy, discover: async () => items, getBackend: async owner => backend(owner),
    publicPeople: { read: async dataset => { if (ENRICHMENT_DATASETS.includes(dataset)) return null; const entry = imports.get(dataset.slice('public-import-'.length)); return entry ? projectPublicMemberImport({ job: entry.job, assertions: entry.rows }) : null }, publish: async () => {} } })
  return { index, stats: () => ({ peak, detailReads }), imports, items }
}

test('a cold build fetches import details a few imports at a time and yields the same snapshot as a warm one', async () => {
  const w = world(12, 15)
  const read = w.index()
  const cold = await read()
  const { peak, detailReads } = w.stats()
  assert.ok(peak > 8, `more than one import in flight (peak ${peak} reads)`)
  assert.ok(peak <= 4 * 8, 'bounded: at most 4 imports, each reading 8 at a time')
  assert.equal(detailReads, 12 * 4, 'each assertion read once: the loop reuses the prefetched details')
  // Same projection a warm (cached) build makes.
  const warm = await read()
  assert.deepEqual(warm.profiles, cold.profiles); assert.deepEqual(warm.connections, cold.connections); assert.equal(warm.revision, cold.revision)
  assert.equal(cold.profiles.filter(profile => profile.id.startsWith('member-import-')).length, 12)
})

test('a source that changed after prefetch is still rejected by the build loop', async () => {
  const w = world(3, 1)
  const changed = w.items[1].id
  let reads = 0
  const read = createMemberPublicIndex({ includeDetails: true, readLegacy: async () => legacy, discover: async () => w.items,
    getBackend: async owner => ({ readResource: async (type, key) => {
      if (type === 'import') { const { job } = w.imports.get(key); reads++; return { sourceId: key, sourceOwnerId: owner.ownerId, sourceRevision: key === changed && reads > 3 ? 5 : 4, payload: job } }
      const entry = [...w.imports.values()].flatMap(value => value.rows).find(row => row.id === key); return { sourceOwnerId: owner.ownerId, payload: entry }
    } }),
    publicPeople: { read: async dataset => { const entry = w.imports.get(dataset.slice('public-import-'.length)); return entry ? projectPublicMemberImport({ job: entry.job, assertions: entry.rows }) : null }, publish: async () => {} } })
  await assert.rejects(read(), /public_member_source_changed/)
})
