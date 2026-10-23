// Member handle registry (unlinked-qpud, docs/profile-handles.md). One
// UnlinkedHandleProfile node per public profile id holds its current handle;
// one UnlinkedProfileHandle node per handle ever used keeps old addresses
// pointing at the same profile, so renames never break shared links and no one
// else can take them. Pages resolve from an in-memory copy that every write
// updates and a periodic reload keeps in step with other processes.
import { HANDLE_LIMITS, handleCandidates, normalizeHandleInput, validateHandle } from '../src/utils/public-people/profile-handles.mjs'

const profileIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 160

export function createMemoryProfileHandleStore() {
  const handles = new Map(), current = new Map()
  return {
    async initialize() {},
    async all() { return [...handles].map(([handle, profileId]) => ({ handle, profileId, current: current.get(profileId) === handle })) },
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
        RETURN h.handle AS handle, h.profileId AS profileId, p.current = h.handle AS current`))
      return result.records.map(record => ({ handle: record.get('handle'), profileId: record.get('profileId'), current: record.get('current') === true }))
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
  }
}

export function createProfileHandles({ store, perProfile = HANDLE_LIMITS.perProfile }) {
  // `writes` counts local changes, so a reload that read before one finished never overwrites it.
  let byHandle = new Map(), currentFor = new Map(), writes = 0
  const remember = (handle, profileId, current) => {
    writes++
    byHandle.set(handle, profileId)
    if (current) currentFor.set(profileId, handle)
  }
  const registry = {
    async initialize() { await store.initialize(); await registry.reload() },
    async reload() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seen = writes, rows = await store.all()
        if (seen !== writes) continue
        const handles = new Map(), current = new Map()
        for (const row of rows) { handles.set(row.handle, row.profileId); if (row.current) current.set(row.profileId, row.handle) }
        byHandle = handles; currentFor = current
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
