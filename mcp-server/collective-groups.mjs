import { randomUUID } from 'node:crypto'

export const GROUP_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const groupInvitePath = (groupId, inviteId) => `/groups/${groupId}/invites/${inviteId}`
export const GROUP_LIMITS = Object.freeze({ seats: 32, invites: 32, shares: 20, profiles: 200, inviteMs: 7 * 24 * 60 * 60 * 1000 })

export class GroupError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = (code = 'not_found') => { throw new GroupError(code) }
const binding = ({ ownerId, userId }) => ({ ownerId, userId })
const same = (a, b) => Boolean(a?.ownerId && a.userId && b?.ownerId === a.ownerId && b.userId === a.userId)
const seat = (group, actor) => group?.members.find(row => same(row.actor, actor))
const access = (group, actor) => group && (same(group.organizer, actor) ? 'organizer' : seat(group, actor)?.id)
const cleanName = name => typeof name === 'string' && name.trim().length <= 100 ? name.trim() : ''
const summary = ({ id, name }) => ({ id, name })
const person = ({ id, name, profileId }) => ({ id, name, profileId })

export function createCollectiveGroups({ store, active, blocked = async () => false, now = Date.now }) {
  const live = async actor => Boolean(actor?.ownerId && actor.userId && await active(binding(actor)))
  const requireLive = async actor => { if (!await live(actor)) fail() }
  const canMeet = async (organizer, actor) => same(organizer, actor) || !await blocked(organizer, actor)
  const authorized = async (actor, id, organizerOnly = false) => {
    await requireLive(actor)
    let group = await store.get(id)
    const role = access(group, actor)
    if (!role || (organizerOnly && role !== 'organizer')) fail()
    if (role !== 'organizer') {
      if (!await live(group.organizer) || !await canMeet(group.organizer, actor)) fail()
      group = await store.get(id)
      if (access(group, actor) !== role) fail()
    }
    return { group, role }
  }
  const update = async (id, transition) => (await store.change(id, transition)) ?? fail()
  const own = (actor, group) => { if (!same(actor, group.organizer)) fail() }
  const availableInvite = (group, inviteId, actor) => group?.invites.find(row => row.id === inviteId && same(row.actor, actor) && row.expiresAt > now())
  const pending = group => group.invites.filter(row => row.expiresAt > now())
  const validInvite = async (actor, id, inviteId) => {
    await requireLive(actor)
    const group = await store.get(id)
    if (!availableInvite(group, inviteId, actor) || !await live(group.organizer) || !await canMeet(group.organizer, actor)) fail()
    const latest = await store.get(id)
    const invite = availableInvite(latest, inviteId, actor)
    if (!invite) fail()
    return { group: latest, invite }
  }
  return {
    async create(actor, name, organizerProfileId) {
      await requireLive(actor)
      name = cleanName(name)
      if (!name) fail('invalid_name')
      const group = { id: randomUUID(), name, organizer: binding(actor), organizerProfileId: organizerProfileId ?? null, members: [], invites: [], shares: [] }
      await store.create(group)
      return summary(group)
    },
    async directory(actor) {
      await requireLive(actor)
      const groups = [], invites = []
      for (const group of await store.forActor(actor)) {
        if (!same(group.organizer, actor) && (!await live(group.organizer) || !await canMeet(group.organizer, actor))) continue
        if (access(group, actor)) groups.push({ ...summary(group), organizer: same(group.organizer, actor) })
        for (const row of pending(group)) if (same(row.actor, actor)) invites.push({ group: summary(group), id: row.id, expiresAt: row.expiresAt })
      }
      return { groups, invites }
    },
    async detail(actor, id) {
      const { group, role } = await authorized(actor, id)
      const organizer = role === 'organizer'
      return { ...summary(group), organizer, organizerProfileId: group.organizerProfileId,
        shares: group.shares.map(summary),
        ...(organizer ? { members: group.members.map(person), invites: pending(group).map(row => ({ ...person(row), expiresAt: row.expiresAt })) } : {}),
      }
    },
    async invite(actor, id, recipient, profile) {
      await authorized(actor, id, true)
      if (!await live(recipient) || same(actor, recipient) || !await canMeet(actor, recipient)) fail('invalid_recipient')
      const invite = { actor: binding(recipient), id: randomUUID(), name: profile.name, profileId: profile.id, expiresAt: now() + GROUP_LIMITS.inviteMs }
      await update(id, group => {
        own(actor, group)
        group.invites = pending(group)
        if (seat(group, recipient)) fail('already_member')
        if (group.invites.some(row => same(row.actor, recipient))) fail('already_invited')
        if (group.invites.length >= GROUP_LIMITS.invites || group.members.length >= GROUP_LIMITS.seats) fail('group_full')
        group.invites.push(invite)
        return group
      })
      return invite.id
    },
    async inspectInvite(actor, id, inviteId) {
      const { group, invite } = await validInvite(actor, id, inviteId)
      return { group: summary(group), expiresAt: invite.expiresAt }
    },
    async respond(actor, id, inviteId, decision) {
      if (!['accept', 'decline'].includes(decision)) fail('invalid_input')
      await validInvite(actor, id, inviteId)
      await update(id, group => {
        const invite = availableInvite(group, inviteId, actor)
        if (!invite) fail()
        if (decision === 'accept') {
          if (group.members.length >= GROUP_LIMITS.seats) fail('group_full')
          group.members.push({ ...person(invite), actor: invite.actor })
        }
        group.invites = pending(group).filter(row => row.id !== invite.id)
        return group
      })
    },
    async revoke(actor, id, kind, targetId) {
      await authorized(actor, id, true)
      const property = { invite: 'invites', member: 'members', share: 'shares' }[kind]
      if (!property) fail('invalid_input')
      await update(id, group => {
        own(actor, group)
        if (!group[property].some(row => row.id === targetId)) fail()
        group[property] = group[property].filter(row => row.id !== targetId)
        return group
      })
    },
    async share(actor, id, selection) {
      await authorized(actor, id, true)
      if (!selection.ids.length || selection.ids.length > GROUP_LIMITS.profiles) fail('empty_list')
      const share = { id: randomUUID(), source: selection.source, name: selection.name, ids: selection.ids }
      await update(id, group => {
        own(actor, group)
        if (group.shares.some(row => row.source === share.source)) fail('already_shared')
        if (group.shares.length >= GROUP_LIMITS.shares) fail('group_full')
        group.shares.push(share)
        return group
      })
      return summary(share)
    },
    async readShare(actor, id, shareId, project) {
      const { group, role } = await authorized(actor, id)
      const share = group.shares.find(row => row.id === shareId)
      if (!share) fail()
      const profiles = await project(group.organizer, share.source, share.ids)
      // Permission may change while reading a slow list or public projection.
      // A removed/re-added member has a new seat id; a re-share has a new id.
      await requireLive(actor)
      if (role !== 'organizer' && (!await live(group.organizer) || !await canMeet(group.organizer, actor))) fail()
      const current = await store.get(id)
      if (access(current, actor) !== role || !current.shares.some(row => row.id === shareId) || profiles === null) fail()
      return { group: summary(current), share: summary(share), profiles }
    },
    async exportOwner(actor) {
      await requireLive(actor)
      const groups = await store.forActor(actor)
      // Include the organizer's own share selections. A member's export has
      // only their participation; it is never another route to read a list.
      return groups.map(group => same(group.organizer, actor)
        ? { ...summary(group), role: 'organizer', shares: group.shares.map(({ id, name, source, ids }) => ({ id, name, source, ids })) }
        : { groupId: group.id, role: access(group, actor) ? 'member' : 'invitee' })
    },
    async removeOwner(actor) {
      for (const row of await store.forActor(actor)) {
        await store.change(row.id, group => {
          if (same(group.organizer, actor)) return null
          group.members = group.members.filter(member => !same(member.actor, actor))
          group.invites = group.invites.filter(invite => !same(invite.actor, actor))
          return group
        })
      }
    },
  }
}
