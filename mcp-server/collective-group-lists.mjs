import { createHash } from 'node:crypto'
import { GROUP_LIMITS, GROUP_UUID, GroupError } from './collective-groups.mjs'

const sourcePattern = new RegExp(`^(saved):(${GROUP_UUID})$|^(private):([A-Za-z0-9_-]{1,80})$`)
const profileId = value => typeof value === 'string' && /^[^\s\u0000-\u001f\u007f/\\]{1,160}$/u.test(value)
const unavailable = () => { throw new GroupError('list_unavailable') }

export function createCollectiveListProjection({ privateLists, savedSearchLists, lookup }) {
  async function read(owner, source) {
    const match = sourcePattern.exec(source ?? '')
    if (!match) return null
    if (match[1]) {
      const list = await savedSearchLists?.get(owner, match[2])
      return list ? { name: list.name, ids: list.refs.filter(ref => ref.startsWith('public:')).map(ref => ref.slice(7)).filter(profileId) } : null
    }
    if (!privateLists) return null
    const ids = new Set(), seen = new Set()
    let after, name
    // Private list pages may contain relation types other than person
    // membership. Bound work even if the service returns empty member pages.
    for (let i = 0; i < 10; i++) {
      let page
      try { page = await privateLists.get(owner, match[4], after) }
      catch (error) { if (error?.code === 'not_found') return null; throw error }
      name ??= page.list.name
      for (const row of page.members) if (profileId(row.profileId)) ids.add(row.profileId)
      if (ids.size > GROUP_LIMITS.profiles) break
      if (!page.nextCursor) return { name, ids: [...ids] }
      if (seen.has(page.nextCursor)) break
      after = page.nextCursor
      seen.add(after)
    }
    throw new GroupError('list_too_large')
  }
  const publicRows = (ids, rows) => [...new Map(ids.map(id => rows.get(id)).filter(Boolean).map(row => [row.id, {
      id: row.id, name: row.name, headline: row.headline,
    }])).values()]
  return {
    async choices(owner, after) {
      const [saved, graph] = await Promise.all([
        after ? [] : savedSearchLists?.list(owner) ?? [],
        privateLists?.list(owner, after) ?? null,
      ])
      return {
        choices: [
          ...saved.map(list => ({ source: 'saved:' + list.id, name: list.name, type: 'Saved search' })),
          ...(graph?.lists ?? []).map(list => ({ source: 'private:' + list.id, name: list.name, type: 'Private list' })),
        ],
        nextCursor: graph?.nextCursor ?? null,
      }
    },
    async preview(owner, groupId, source) {
      const list = await read(owner, source)
      if (!list) unavailable()
      const name = list.name
      // Keep the selected source references (even if canonical profile IDs
      // have merged) only for the public profiles the organizer reviewed.
      const resolved = list.ids.length ? await lookup(list.ids) : new Map()
      const profiles = publicRows(list.ids, resolved)
      const ids = [...new Set(list.ids)].filter(id => resolved.has(id))
      const proof = createHash('sha256').update(JSON.stringify([groupId, source, name, ids, profiles.map(row => row.id)])).digest('hex')
      return { source, name, profiles, ids, proof }
    },
    async project(owner, source, reviewedIds) {
      let list
      try { list = await read(owner, source) }
      catch (error) { if (error?.code === 'list_too_large') return null; throw error }
      if (!list) return null
      const current = new Set(list.ids)
      const ids = reviewedIds.filter(id => current.has(id))
      return publicRows(ids, ids.length ? await lookup(ids) : new Map())
    },
  }
}
