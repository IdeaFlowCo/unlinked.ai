// Profile handle registry (unlinked-qpud, unlinked-3l8h, docs/profile-handles.md). One
// UnlinkedHandleProfile node per public profile id holds its current handle;
// one UnlinkedProfileHandle node per handle ever used keeps old addresses
// pointing at the same profile, so renames never break shared links and no one
// else can take them. Pages resolve from an in-memory copy that every write
// updates and a periodic reload keeps in step with other processes.
import { HANDLE_LIMITS, handleCandidates, normalizeHandleInput, validateHandle } from '../src/utils/public-people/profile-handles.mjs'

const profileIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 160

export function createMemoryProfileHandleStore() {
  const handles = new Map(), current = new Map(), kinds = new Map()
  return {
    async initialize() {},
    async all() { return [...handles].map(([handle, profileId]) => ({ handle, profileId, current: current.get(profileId) === handle, ...(kinds.has(handle) ? { kind: kinds.get(handle) } : {}) })) },
    async assign(profileId, candidates) {
      if (current.has(profileId)) return current.get(profileId)
      const free = candidates.find(handle => !handles.has(handle))
      if (!free) return null
      handles.set(free, profileId); current.set(profileId, free)
      return free
    },
    async rename(profileId, handle, { perProfile }) {
      const holder = handles.get(handle)
      if (holder !== undefined && holder !== profileId) return { code: 'taken' }
      if (holder === undefined && [...handles.values()].filter(value => value === profileId).length >= perProfile) return { code: 'limit' }
      handles.set(handle, profileId); current.set(profileId, handle)
      return { handle }
    },
    async removeProfile(profileId) {
      for (const [handle, holder] of handles) if (holder === profileId) handles.delete(handle)
      current.delete(profileId)
    },
    async assignMany(rows) {
      const assigned = []
      for (const { profileId, handle, kind } of rows) {
        if (current.has(profileId) || handles.has(handle)) continue
        handles.set(handle, profileId); current.set(profileId, handle); if (kind) kinds.set(handle, kind); assigned.push({ profileId, handle, kind })
      }
      return assigned
    },
    async transfer(fromId, toId, { current: wanted } = {}) {
      const moved = []
      for (const [handle, holder] of handles) if (holder === fromId) { handles.set(handle, toId); moved.push(handle) }
      current.delete(fromId)
      if (wanted && handles.get(wanted) === toId) current.set(toId, wanted)
      else if (!current.has(toId) && moved.length) current.set(toId, moved[0])
      return { moved, current: current.get(toId) ?? null }
    },
  }
}

export function createNeo4jProfileHandleStore(driver, database = 'neo4j') {
  const tx = async (mode, work) => {
    const session = driver.session({ database, defaultAccessMode: mode === 'executeRead' ? 'READ' : 'WRITE' })
    try { return await session[mode](work) } finally { await session.close() }
  }
  const constraintFailure = error => error?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed'
  return {
    async initialize() {
      await tx('executeWrite', t => t.run('CREATE CONSTRAINT unlinked_profile_handle IF NOT EXISTS FOR (h:UnlinkedProfileHandle) REQUIRE h.handle IS UNIQUE'))
      await tx('executeWrite', t => t.run('CREATE CONSTRAINT unlinked_handle_profile IF NOT EXISTS FOR (p:UnlinkedHandleProfile) REQUIRE p.profileId IS UNIQUE'))
    },
    async all() {
      const result = await tx('executeRead', t => t.run(`MATCH (h:UnlinkedProfileHandle) OPTIONAL MATCH (p:UnlinkedHandleProfile {profileId: h.profileId})
        RETURN h.handle AS handle, h.profileId AS profileId, p.current = h.handle AS current, h.kind AS kind`))
      return result.records.map(record => ({ handle: record.get('handle'), profileId: record.get('profileId'), current: record.get('current') === true, ...(typeof record.get('kind') === 'string' ? { kind: record.get('kind') } : {}) }))
    },
    // MERGE on the profile node serializes concurrent assignments for one
    // profile; the handle constraint settles a race between two profiles.
    async assign(profileId, candidates) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await tx('executeWrite', async t => {
            const held = await t.run('MERGE (p:UnlinkedHandleProfile {profileId: $profileId}) SET p._lock = true REMOVE p._lock RETURN p.current AS current', { profileId })
            if (held.records[0].get('current')) return held.records[0].get('current')
            const taken = new Set((await t.run('MATCH (h:UnlinkedProfileHandle) WHERE h.handle IN $candidates RETURN h.handle AS handle', { candidates })).records.map(record => record.get('handle')))
            const free = candidates.find(handle => !taken.has(handle))
            if (!free) return null
            await t.run(`CREATE (:UnlinkedProfileHandle {handle: $handle, profileId: $profileId, createdAt: timestamp()})
              WITH 1 AS done MATCH (p:UnlinkedHandleProfile {profileId: $profileId}) SET p.current = $handle, p.updatedAt = timestamp()`, { handle: free, profileId })
            return free
          })
        } catch (error) { if (!constraintFailure(error)) throw error }
      }
      return null
    },
    async rename(profileId, handle, { perProfile }) {
      try {
        return await tx('executeWrite', async t => {
          await t.run('MERGE (p:UnlinkedHandleProfile {profileId: $profileId}) SET p._lock = true REMOVE p._lock', { profileId })
          const holder = (await t.run('MATCH (h:UnlinkedProfileHandle {handle: $handle}) RETURN h.profileId AS profileId', { handle })).records[0]?.get('profileId')
          if (holder !== undefined && holder !== profileId) return { code: 'taken' }
          if (holder === undefined) {
            const used = (await t.run('MATCH (h:UnlinkedProfileHandle {profileId: $profileId}) RETURN count(h) AS used', { profileId })).records[0].get('used')
            if (Number(used?.toNumber?.() ?? used) >= perProfile) return { code: 'limit' }
            await t.run('CREATE (:UnlinkedProfileHandle {handle: $handle, profileId: $profileId, createdAt: timestamp()})', { handle, profileId })
          }
          await t.run('MATCH (p:UnlinkedHandleProfile {profileId: $profileId}) SET p.current = $handle, p.updatedAt = timestamp()', { profileId, handle })
          return { handle }
        })
      } catch (error) { if (constraintFailure(error)) return { code: 'taken' }; throw error }
    },
    async removeProfile(profileId) {
      await tx('executeWrite', t => t.run('OPTIONAL MATCH (h:UnlinkedProfileHandle {profileId: $profileId}) DETACH DELETE h WITH 1 AS done OPTIONAL MATCH (p:UnlinkedHandleProfile {profileId: $profileId}) DETACH DELETE p', { profileId }))
    },
    // One write for a batch of first handles (the backfill). Each row names a
    // distinct profile and a distinct free handle; a row whose profile already
    // has a handle, or whose handle another process took, is skipped. A race
    // the constraint catches falls back to one assignment per row.
    async assignMany(rows) {
      if (!rows.length) return []
      const query = `UNWIND $rows AS row
        MERGE (p:UnlinkedHandleProfile {profileId: row.profileId})
        WITH p, row OPTIONAL MATCH (h:UnlinkedProfileHandle {handle: row.handle})
        WITH p, row, h WHERE p.current IS NULL AND h IS NULL
        CREATE (n:UnlinkedProfileHandle {handle: row.handle, profileId: row.profileId, createdAt: timestamp()})
        SET n.kind = row.kind, p.current = row.handle, p.updatedAt = timestamp()
        RETURN row.profileId AS profileId, row.handle AS handle, row.kind AS kind`
      try {
        const result = await tx('executeWrite', t => t.run(query, { rows }))
        return result.records.map(record => ({ profileId: record.get('profileId'), handle: record.get('handle'), kind: record.get('kind') ?? undefined }))
      } catch (error) {
        if (!constraintFailure(error)) throw error
        const assigned = []
        for (const row of rows) {
          const handle = await this.assign(row.profileId, [row.handle])
          if (handle !== row.handle) continue
          if (row.kind) await tx('executeWrite', t => t.run('MATCH (h:UnlinkedProfileHandle {handle: $handle, profileId: $profileId}) SET h.kind = $kind', row))
          assigned.push(row)
        }
        return assigned
      }
    },
    // Moves every handle a profile holds to another profile (the same person,
    // by LinkedIn address), keeping each handle's history; `current` names the
    // handle the receiving profile should answer at.
    async transfer(fromId, toId, { current: wanted } = {}) {
      return tx('executeWrite', async t => {
        await t.run('MERGE (p:UnlinkedHandleProfile {profileId: $toId}) SET p._lock = true REMOVE p._lock', { toId })
        await t.run('MATCH (p:UnlinkedHandleProfile {profileId: $fromId}) SET p._lock = true REMOVE p._lock', { fromId })
        const moved = (await t.run(`MATCH (h:UnlinkedProfileHandle {profileId: $fromId})
          SET h.profileId = $toId, h.movedFrom = $fromId, h.movedAt = timestamp() RETURN h.handle AS handle ORDER BY h.createdAt`, { fromId, toId })).records.map(record => record.get('handle'))
        await t.run('MATCH (p:UnlinkedHandleProfile {profileId: $fromId}) DETACH DELETE p', { fromId })
        const held = (await t.run('MATCH (p:UnlinkedHandleProfile {profileId: $toId}) RETURN p.current AS current', { toId })).records[0]?.get('current') ?? null
        const next = wanted && (moved.includes(wanted) || wanted === held) ? wanted : held ?? moved[0] ?? null
        if (next !== held) await t.run('MATCH (p:UnlinkedHandleProfile {profileId: $toId}) SET p.current = $next, p.updatedAt = timestamp()', { toId, next })
        return { moved, current: next }
      })
    },
  }
}

export function createProfileHandles({ store, perProfile = HANDLE_LIMITS.perProfile }) {
  // `writes` counts local changes, so a reload that read before one finished never overwrites it.
  let byHandle = new Map(), currentFor = new Map(), kinds = new Map(), writes = 0
  const remember = (handle, profileId, current, kind) => {
    writes++
    byHandle.set(handle, profileId)
    if (current) currentFor.set(profileId, handle)
    if (kind) kinds.set(handle, kind)
  }
  const registry = {
    async initialize() { await store.initialize(); await registry.reload() },
    async reload() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seen = writes, rows = await store.all()
        if (seen !== writes) continue
        const handles = new Map(), current = new Map(), kind = new Map()
        for (const row of rows) { handles.set(row.handle, row.profileId); if (row.current) current.set(row.profileId, row.handle); if (row.kind) kind.set(row.handle, row.kind) }
        byHandle = handles; currentFor = current; kinds = kind
        return
      }
    },
    // The profile a path segment names as a handle (any case), or null.
    resolve(segment) {
      const handle = normalizeHandleInput(segment)
      const profileId = byHandle.get(handle)
      return profileId === undefined ? null : { profileId, handle: currentFor.get(profileId) ?? handle }
    },
    handleFor: profileId => currentFor.get(profileId) ?? null,
    // How the backfill chose a handle: 'linkedin' (the vanity slug) or 'name';
    // null for handles a member chose or got on a page view.
    kindOf: handle => kinds.get(normalizeHandleInput(handle)) ?? null,
    // Gives a member profile its default handle once; later calls return it.
    async ensure({ id, name, linkedinUrl }) {
      if (!profileIdValid(id)) return null
      if (currentFor.has(id)) return currentFor.get(id)
      const handle = await store.assign(id, handleCandidates({ name, linkedinUrl }))
      if (handle) remember(handle, id, true)
      return handle
    },
    // Availability for one profile: its own current or earlier handles count as free.
    availability(value, profileId) {
      const checked = validateHandle(value)
      if (!checked.handle) return checked
      const holder = byHandle.get(checked.handle)
      return holder !== undefined && holder !== profileId ? { code: 'taken', handle: checked.handle } : { handle: checked.handle, available: true }
    },
    async rename(profileId, value) {
      if (!profileIdValid(profileId)) return { code: 'invalid' }
      const checked = validateHandle(value)
      if (!checked.handle) return checked
      const result = await store.rename(profileId, checked.handle, { perProfile })
      if (result.handle) remember(result.handle, profileId, true)
      return result
    },
    // First handles for many profiles at once: [{ id, handle, kind }], each
    // handle valid and free here. Returns how many were stored.
    async assignMany(entries) {
      const rows = [], used = new Set(), ids = new Set()
      for (const { id, handle, kind } of entries) {
        if (!profileIdValid(id) || ids.has(id) || currentFor.has(id) || validateHandle(handle).handle !== handle || used.has(handle) || byHandle.has(handle) || !['linkedin', 'name'].includes(kind)) continue
        rows.push({ profileId: id, handle, kind }); used.add(handle); ids.add(id)
      }
      const assigned = rows.length ? await store.assignMany(rows) : []
      for (const row of assigned) remember(row.handle, row.profileId, true, row.kind)
      return assigned.length
    },
    // Every handle `fromId` holds now names `toId` (the same person by
    // LinkedIn address); `makeCurrent` is the handle `toId` should answer at.
    async transfer(fromId, toId, { makeCurrent } = {}) {
      if (!profileIdValid(fromId) || !profileIdValid(toId) || fromId === toId) return null
      const result = await store.transfer(fromId, toId, { current: makeCurrent })
      writes++
      for (const handle of result.moved) byHandle.set(handle, toId)
      currentFor.delete(fromId)
      if (result.current) currentFor.set(toId, result.current)
      return result
    },
    async removeProfile(profileId) {
      if (!profileIdValid(profileId)) return
      await store.removeProfile(profileId)
      writes++
      for (const [handle, holder] of byHandle) if (holder === profileId) byHandle.delete(handle)
      currentFor.delete(profileId)
    },
  }
  return registry
}
