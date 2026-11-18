import { createNoosGroupRecords, PRIVATE_GROUP_CONTRACT } from './private-group-records.mjs'
import { parseGroupRoster, rosterDigest, suggestRosterMatches, filterGroupCandidates } from './private-group-roster.mjs'

const same = (a, b) => Boolean(a?.ownerId && a?.userId && a.ownerId === b?.ownerId && a.userId === b?.userId)
const fail = (code = 'not_found') => { throw Object.assign(Error(code), { code }) }
const fingerprint = rows => JSON.stringify(rows.map(r => [r.actor.ownerId, r.actor.userId, r.profileId ?? null]).sort())

export function createPrivateGroupPilot({ enabled = false, allowedOwnerIds = [], groups, groupOwner, getBackend, active, memberBlocks, accountForProfile }) {
  const allowed = new Set(allowedOwnerIds)
  // No environment defaults, backend initialization or migrations here.
  const context = async (actor, id, ownerOnly = false) => {
    if (!enabled || !actor?.ownerId || !actor.userId || !groups || !await active(actor)) fail()
    const detail = await groups.detail(actor, id) // existing live join/block/account fence
    const owner = await groupOwner(id)
    if (!owner || !allowed.has(owner.ownerId) || !await active(owner) || (ownerOnly && !same(actor, owner))) fail()
    const records = createNoosGroupRecords({ backend: await getBackend(owner), owner })
    if (records.contract !== PRIVATE_GROUP_CONTRACT) fail()
    return { actor, id, owner, records, detail }
  }
  const current = async (actor, id, ownerOnly = false) => {
    const ctx = await context(actor, id, ownerOnly)
    let node = await ctx.records.group(id)
    if (!node) fail()
    let edges = await ctx.records.memberships(node)
    // The existing collective flow is the join-consent authority. Synchronize
    // only verified live joined seats into Noos membership edges, never a roster.
    const live = await groups.roster(ctx.owner, id)
    if (fingerprint(live) !== fingerprint(edges) || ctx.detail.chatUrl !== node.externalLink || ctx.detail.name !== node.name || ctx.detail.description !== node.description) {
      const members = live.map(row => ({ actor: row.actor, name: row.name, profileId: row.profileId ?? null,
        role: same(row.actor, ctx.owner) ? 'owner' : edges.find(e => same(e.actor, row.actor))?.role === 'admin' ? 'admin' : 'member' }))
      node = await ctx.records.publishGroup(id, ctx.detail, members, node.revision)
      edges = await ctx.records.memberships(node)
    }
    const edge = edges.find(row => same(row.actor, actor))
    if (!edge || (ownerOnly && edge.role !== 'owner')) fail()
    await groups.detail(actor, id) // never return a cached authorization
    return { ...ctx, node, edges, role: edge.role }
  }
  const recheck = async ctx => {
    const live = await context(ctx.actor, ctx.id, ctx.role === 'owner')
    const joined = await groups.roster(ctx.owner, ctx.id)
    if (fingerprint(joined) !== fingerprint(ctx.edges) || live.detail.name !== ctx.detail.name ||
      live.detail.description !== ctx.detail.description || live.detail.chatUrl !== ctx.detail.chatUrl) fail('review_changed')
    const node = await ctx.records.group(ctx.id)
    if (!node || node.revision !== ctx.node.revision) fail('review_changed')
  }
  const candidatesFor = async (actor, profiles) => filterGroupCandidates({ profiles, owner: actor, memberBlocks, accountForProfile })
  const recheckCandidates = async (actor, rows, lookupCandidates) => {
    const ids = [...new Set(rows.flatMap(row => row.resolution.candidates.map(c => c.profileId)))]
    if (!ids.length) return rows
    if (typeof lookupCandidates !== 'function') fail('group_candidate_publication_required')
    const current = await lookupCandidates(ids)
    if (!(current instanceof Map)) fail('group_candidate_publication_unavailable')
    const refreshed = rows.map(row => {
      const candidates = row.resolution.candidates.flatMap(candidate => {
        const profile = current.get(candidate.profileId)
        return profile && typeof profile.id === 'string' && typeof profile.name === 'string' ? [{ ...candidate,
          profileId: profile.id, name: profile.name.slice(0, 200), presence: profile.presence === 'member' ? 'member' : 'profile' }] : []
      })
      return { ...row, resolution: { ...row.resolution, candidates: candidates.filter((c, i) => candidates.findIndex(other => other.profileId === c.profileId) === i) } }
    })
    const candidates = refreshed.flatMap(row => row.resolution.candidates)
    const permitted = new Set((await candidatesFor(actor, candidates.map(c => ({ ...c, id: c.profileId })))).map(c => c.id))
    return refreshed.map(row => {
      const candidates = row.resolution.candidates.filter(c => permitted.has(c.profileId))
      return { ...row, resolution: { status: candidates.length > 1 ? 'ambiguous' : candidates.length ? 'suggested' : 'unmatched', candidates } }
    })
  }

  return {
    async exportOwner(actor) {
      if (!enabled || !allowed.has(actor?.ownerId) || !await active(actor)) return []
      return createNoosGroupRecords({ backend: await getBackend(actor), owner: actor }).exportOwner()
    },
    async removeOwner(actor) {
      if (!enabled || !allowed.has(actor?.ownerId) || !await active(actor)) return
      return createNoosGroupRecords({ backend: await getBackend(actor), owner: actor }).removeOwner()
    },
    async available(actor, id) {
      if (!enabled) return false
      try { await context(actor, id, true); return true } catch { return false }
    },
    async enable(actor, id) {
      const ctx = await context(actor, id, true)
      if (await ctx.records.group(id)) return
      const joined = await groups.roster(actor, id)
      await ctx.records.publishGroup(id, ctx.detail, joined.map(row => ({ actor: row.actor, name: row.name,
        profileId: row.profileId ?? null, role: same(row.actor, actor) ? 'owner' : 'member' })), null)
      await context(actor, id, true)
    },
    async detail(actor, id) {
      const ctx = await current(actor, id)
      const visible = await groups.roster(actor, id)
      const memberKeys = new Set(visible.map(r => JSON.stringify(r.actor)))
      const result = { id, name: ctx.detail.name, description: ctx.detail.description, visibility: 'PRIVATE', tags: ctx.node.tags,
        externalLink: ctx.node.externalLink || null, owner: ctx.role === 'owner',
        members: ctx.edges.filter(e => memberKeys.has(JSON.stringify(e.actor))).map(e => ({ name: e.name, profileId: e.profileId, role: e.role })) }
      await recheck(ctx)
      return result
    },
    async preview(actor, id, bytes, format) {
      const ctx = await current(actor, id, true)
      const rows = parseGroupRoster(bytes, format)
      const manifest = await ctx.records.rosterManifest(id)
      await recheck(ctx)
      return { rows, digest: rosterDigest(rows), nodeRevision: ctx.node.revision, rosterRevision: manifest?.revision ?? null }
    },
    async commit(actor, id, review, acknowledgement) {
      if (acknowledgement !== 'retain_privately') fail('acknowledgement_required')
      const ctx = await current(actor, id, true)
      // Reparse canonical participant fields, not client-supplied resolution data.
      const rows = parseGroupRoster(Buffer.from(JSON.stringify(review.rows)), 'json')
      if (rosterDigest(rows) !== review.digest || review.nodeRevision !== ctx.node.revision) fail('review_changed')
      const manifest = await ctx.records.rosterManifest(id)
      if ((manifest?.revision ?? null) !== review.rosterRevision) fail('review_changed')
      await recheck(ctx)
      await ctx.records.publishRoster(id, rows, review.rosterRevision, ctx.node.revision, () => recheck(ctx))
    },
    async roster(actor, id) {
      const ctx = await current(actor, id, true)
      const manifest = await ctx.records.rosterManifest(id)
      const rows = await ctx.records.roster(id, manifest)
      await recheck(ctx)
      // Hashes stay inside the owner-private Noos record, never HTML/proposals.
      return rows.map(({ phone_hash, ...row }) => row)
    },
    async suggestions(actor, id, readCandidates, offset = 0, lookupCandidates) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) fail('invalid_input')
      const ctx = await current(actor, id, true)
      const rows = await this.roster(actor, id)
      const result = []
      for (const row of rows.slice(offset, offset + 25)) {
        const profiles = await candidatesFor(actor, await readCandidates(row.display_name))
        result.push(...suggestRosterMatches([row], profiles))
      }
      const checked = await recheckCandidates(actor, result, lookupCandidates)
      await recheck(ctx)
      return { rows: checked, total: rows.length, nextOffset: offset + 25 < rows.length ? offset + 25 : null }
    },
    async resolveNext(actor, id, readCandidates, lookupCandidates) {
      const ctx = await current(actor, id, true)
      const manifest = await ctx.records.rosterManifest(id)
      if (!manifest) fail()
      const job = await ctx.records.resolutionJob(id, manifest.generation)
      if (job?.state === 'complete') return job
      const rows = await ctx.records.roster(id, manifest), start = job?.cursor ?? 0, results = []
      for (const row of rows.slice(start, start + 25)) {
        const { phone_hash, ...safe } = row
        results.push(...suggestRosterMatches([safe], await candidatesFor(actor, await readCandidates(row.display_name))))
      }
      const checked = await recheckCandidates(actor, results, lookupCandidates)
      await recheck(ctx)
      return ctx.records.saveResolution(id, manifest, checked, Math.min(start + 25, rows.length), job?.revision ?? null, ctx.node.revision)
    },
    async clear(actor, id, acknowledgement) {
      if (acknowledgement !== 'delete_pending_roster') fail('acknowledgement_required')
      const ctx = await current(actor, id, true), manifest = await ctx.records.rosterManifest(id)
      await recheck(ctx)
      await ctx.records.publishRoster(id, [], manifest?.revision ?? null, ctx.node.revision, () => recheck(ctx))
    },
    async draft(actor, id, participantId) {
      const ctx = await current(actor, id, true)
      const rows = await this.roster(actor, id)
      const row = rows.find(r => r.participant_id === participantId)
      if (!row) fail()
      await recheck(ctx)
      return { text: `Hi ${row.display_name}, would you like to join ${ctx.detail.name} on Unlinked? Joining is optional. Ask Jacob for an invitation.`,
        notice: 'Draft only. Nothing was sent and no invitation was created.' }
    },
  }
}
