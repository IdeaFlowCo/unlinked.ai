// Owner-private contact addresses (unlinked-uwqw, docs/contact-slugs.md).
// /network/contacts/<slug> names one of the signed-in owner's own connection
// rows. A slug is unique only within its owner and is never shown to anyone
// else. Once issued it always names the same row, so old addresses keep
// working and a later name collision takes the next candidate instead of
// moving anyone. Row ids stay the stable keys; the slug is only an address.
import { createHash } from 'node:crypto'
import { linkedinHandle, nameHandleBase, normalizeHandleInput, validateHandle } from '../src/utils/public-people/profile-handles.mjs'
import { lockProfileOwner } from './profile-source-boundary.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Connection row ids are privateId() digests; a slug can never take this shape
// (validateHandle reserves long hex), so a segment is one or the other.
export const CONTACT_ROW_ID = /^[0-9a-f]{64}$/
export const CONTACT_SLUG_LIMITS = Object.freeze({ perOwner: 50000, perWrite: 5000, numbered: 99 })
const ownerKey = owner => {
  if (!owner?.ownerId || !owner.userId) throw Error('contact_slug_owner_required')
  return hash([owner.ownerId, owner.userId])
}
const usable = value => typeof value === 'string' && validateHandle(value).handle === value

// Candidates in preference order: the person's public /people handle (so one
// person reads the same in both places), their name, the LinkedIn vanity slug
// we know (row or privately attached), then the name numbered.
export function contactSlugCandidates({ publicHandle, name, linkedinUrl } = {}) {
  const candidates = []
  if (usable(publicHandle)) candidates.push(publicHandle)
  const named = typeof name === 'string' && name.trim().length > 0
  const base = nameHandleBase(named ? name : '')
  if (named && usable(base)) candidates.push(base)
  const slug = linkedinHandle(linkedinUrl)
  if (slug) candidates.push(slug)
  for (let n = 2; n <= CONTACT_SLUG_LIMITS.numbered; n++) if (usable(`${base}-${n}`)) candidates.push(`${base}-${n}`)
  return [...new Set(candidates)]
}

// The first free candidate for each entry without a slug, in entry order.
function choose(existing, entries) {
  const taken = new Set(existing.map(value => value.slug)), held = new Set(existing.map(value => value.rowId)), chosen = []
  for (const { rowId, candidates } of entries) {
    if (held.has(rowId)) continue
    const slug = candidates.find(value => usable(value) && !taken.has(value))
    if (!slug) continue
    taken.add(slug); held.add(rowId); chosen.push({ slug, rowId })
  }
  return chosen
}

export function createMemoryContactSlugStore() {
  const records = new Map() // owner key -> [{ slug, rowId }]
  return {
    async initialize() {},
    async list(owner) { return structuredClone(records.get(ownerKey(owner)) ?? []) },
    async assign(owner, entries) {
      const key = ownerKey(owner), existing = records.get(key) ?? []
      const chosen = choose(existing, entries)
      records.set(key, [...existing, ...chosen])
      return structuredClone(chosen)
    },
    async removeOwner(owner) { records.delete(ownerKey(owner)) },
  }
}

// One UnlinkedContactSlug node per issued address. Every operation names both
// owner and user, reads join the live active binding, and writes take the
// owner's profile-source lock so one owner's assignments never race.
export function createNeo4jContactSlugStore(driver, database = 'neo4j') {
  const tx = async (mode, work) => { const s = driver.session({ database, defaultAccessMode: mode }); try { return await s[mode === 'READ' ? 'executeRead' : 'executeWrite'](work) } finally { await s.close() } }
  const active = `MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId}) WHERE coalesce(b.active,true)=true`
  const listIn = async (t, owner) => {
    const r = await t.run(`${active} MATCH (n:UnlinkedContactSlug {ownerId:$ownerId,userId:$userId}) RETURN n.slug AS slug,n.rowId AS rowId ORDER BY n.createdAt,n.slug LIMIT ${CONTACT_SLUG_LIMITS.perOwner + 1}`,
      { ownerId: owner.ownerId, userId: owner.userId })
    if (r.records.length > CONTACT_SLUG_LIMITS.perOwner) throw Error('contact_slug_owner_limit')
    return r.records.map(record => ({ slug: record.get('slug'), rowId: record.get('rowId') }))
  }
  return {
    initialize: () => tx('WRITE', t => t.run('CREATE CONSTRAINT unlinked_contact_slug_key IF NOT EXISTS FOR (n:UnlinkedContactSlug) REQUIRE n.key IS UNIQUE')),
    list: owner => { ownerKey(owner); return tx('READ', t => listIn(t, owner)) },
    assign: (owner, entries) => {
      const key = ownerKey(owner)
      if (entries.length > CONTACT_SLUG_LIMITS.perWrite) throw Error('contact_slug_write_limit')
      return tx('WRITE', async t => {
        await lockProfileOwner(t, owner)
        const existing = await listIn(t, owner)
        const chosen = choose(existing, entries)
        if (existing.length + chosen.length > CONTACT_SLUG_LIMITS.perOwner) throw Error('contact_slug_owner_limit')
        if (chosen.length) await t.run(`UNWIND $rows AS row CREATE (:UnlinkedContactSlug {key:row.key,ownerId:$ownerId,userId:$userId,slug:row.slug,rowId:row.rowId,createdAt:timestamp()})`,
          { ownerId: owner.ownerId, userId: owner.userId, rows: chosen.map(value => ({ ...value, key: hash([key, value.slug]) })) })
        return chosen
      })
    },
    removeOwner: owner => tx('WRITE', async t => {
      ownerKey(owner)
      await lockProfileOwner(t, owner, { requireActive: false })
      await t.run('MATCH (n:UnlinkedContactSlug {ownerId:$ownerId,userId:$userId}) DETACH DELETE n', { ownerId: owner.ownerId, userId: owner.userId })
    }),
  }
}

// Pages resolve from an in-memory copy per owner (loaded once, updated by every
// write here); the runtime is the only writer. `pathFor` is synchronous so
// every link builder can prefer the slug and fall back to the row id.
export function createContactSlugs({ store, capacity = 500 }) {
  const owners = new Map() // owner key -> { bySlug, byRow, loading, writing }
  const rowSlugs = new Map() // row id -> slug, for loaded owners only (row ids embed their owner)
  const evict = () => {
    while (owners.size > capacity) {
      const [key, entry] = owners.entries().next().value
      for (const rowId of entry.byRow.keys()) rowSlugs.delete(rowId)
      owners.delete(key)
    }
  }
  const remember = (entry, { slug, rowId }) => {
    if (!entry.bySlug.has(slug)) entry.bySlug.set(slug, rowId)
    if (!entry.byRow.has(rowId)) { entry.byRow.set(rowId, slug); rowSlugs.set(rowId, slug) }
  }
  async function state(owner) {
    const key = ownerKey(owner)
    let entry = owners.get(key)
    if (!entry) {
      entry = { bySlug: new Map(), byRow: new Map(), loading: null, writing: Promise.resolve() }
      entry.loading = store.list(owner).then(rows => { for (const row of rows) remember(entry, row) },
        error => { if (owners.get(key) === entry) owners.delete(key); throw error })
      owners.set(key, entry); evict()
    }
    await entry.loading
    return entry
  }
  const service = {
    async initialize() { await store.initialize() },
    // Gives every listed connection row without one a slug. `describe(rows)`
    // returns [{ publicHandle, name, linkedinUrl }] aligned with the rows it is
    // given (only the rows still missing a slug); if it throws, nothing is
    // assigned this time and links keep using row ids.
    async ensure(owner, rows, describe = async values => values.map(() => ({}))) {
      const entry = await state(owner)
      const run = entry.writing.then(async () => {
        const seen = new Set()
        const missing = rows.filter(row => typeof row?.id === 'string' && CONTACT_ROW_ID.test(row.id) && !entry.byRow.has(row.id) && !seen.has(row.id) && seen.add(row.id))
        if (!missing.length) return 0
        // Earliest connection first, so the first person with a name keeps the plain one.
        const at = row => Number.isSafeInteger(row.connectedAt) ? row.connectedAt : Number.isSafeInteger(row.importedAt) ? row.importedAt : Number.MAX_SAFE_INTEGER
        missing.sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : 1))
        const details = await describe(missing)
        const entries = missing.map((row, index) => ({ rowId: row.id, candidates: contactSlugCandidates(details?.[index] ?? {}), first: usable(details?.[index]?.publicHandle) }))
        // A person's public handle is theirs; name-only rows take what is left.
        entries.sort((a, b) => Number(b.first) - Number(a.first))
        let assigned = 0
        for (let index = 0; index < entries.length; index += CONTACT_SLUG_LIMITS.perWrite) {
          const created = await store.assign(owner, entries.slice(index, index + CONTACT_SLUG_LIMITS.perWrite).map(({ rowId, candidates }) => ({ rowId, candidates })))
          for (const value of created) remember(entry, value)
          assigned += created.length
        }
        return assigned
      })
      entry.writing = run.catch(() => {})
      return run
    },
    slugFor: rowId => rowSlugs.get(rowId) ?? null,
    pathFor: rowId => `/network/contacts/${encodeURIComponent(rowSlugs.get(rowId) ?? rowId)}`,
    // The row a path segment names for this owner: a row id as is, or one of
    // this owner's slugs (any case). Another owner's slug resolves to nothing.
    async resolve(owner, segment) {
      if (typeof segment !== 'string' || !segment) return null
      if (CONTACT_ROW_ID.test(segment)) return segment
      const entry = await state(owner)
      return entry.bySlug.get(normalizeHandleInput(segment)) ?? null
    },
    async exportOwner(owner) { return store.list(owner) },
    async removeOwner(owner) {
      await store.removeOwner(owner)
      const key = ownerKey(owner), entry = owners.get(key)
      if (entry) { for (const rowId of entry.byRow.keys()) rowSlugs.delete(rowId); owners.delete(key) }
    },
  }
  return service
}
