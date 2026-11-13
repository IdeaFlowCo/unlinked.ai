import { communityChatId, readableGroupSlug, groupUrlKey } from './community-chat-id.mjs'
import { randomUUID } from 'node:crypto'
import { groupActorKey } from './collective-groups-store.mjs'
import { concurrentMap } from './concurrent-map.mjs'

export const GROUP_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const groupInvitePath = (groupId, inviteId) => `/groups/${groupId}/invites/${inviteId}`
export const flyerInvitePath = (groupId, inviteId) => `/groups/${groupId}/join/${inviteId}`
export const GROUP_LIMITS = Object.freeze({ seats: 32, invites: 32, shares: 20, profiles: 200, inviteMs: 7 * 24 * 60 * 60 * 1000 })
export const FLYER_LIMITS = Object.freeze({ seats: 500, days: 180 })

export class GroupError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = (code = 'not_found') => { throw new GroupError(code) }
const binding = ({ ownerId, userId }) => ({ ownerId, userId })
const same = (a, b) => Boolean(a?.ownerId && a.userId && b?.ownerId === a.ownerId && b.userId === a.userId)
const seat = (group, actor) => group?.members.find(row => same(row.actor, actor))
const access = (group, actor) => group && (same(group.organizer, actor) ? 'organizer' : seat(group, actor)?.id)
const cleanName = name => typeof name === 'string' && name.trim().length <= 100 ? name.trim() : ''
const summary = group => ({ id:group.id, name:group.name, ...(group.slug?{urlKey:groupUrlKey(group)}:{}) })
const metadata = group => ({ description: group.description ?? '', chatUrl: group.chatUrl ?? '', openChatUrl: group.openChatUrl ?? '' })
export function normalizeGroupChatUrl(value) {
  if (typeof value !== 'string' || value.length > 500) fail('invalid_chat_url')
  if (!value.trim()) return ''
  let url
  try { url = new URL(value.trim()) } catch { fail('invalid_chat_url') }
  if (url.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || url.port || url.username || url.password || !/^\/[A-Za-z0-9]{16,64}$/.test(url.pathname) || url.hash || [...url.searchParams].some(([k,v]) => k !== 'mode' || v !== 'gi_t') || url.searchParams.getAll('mode').length > 1) fail('invalid_chat_url')
  return url.href
}
export function normalizeGroupOpenChatUrl(value) {
  if (typeof value !== 'string' || value.length > 500) fail('invalid_openchat_url')
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^https:\/\/chat\.ideaflow\.app(?::443)?\/i\/[A-Za-z0-9_-]{32}$/.test(trimmed)) fail('invalid_openchat_url')
  return new URL(trimmed).href
}
const person = ({ id, name, profileId }) => ({ id, name, profileId })
const seatLimit = group => group.capacity ?? GROUP_LIMITS.seats + 1
const memberCount = group => group.members.length + 1
const publicFlyer = ({ id, expiresAt, approval }) => ({ id, expiresAt, approval })

export function createCollectiveGroups({ store, active, blocked = async () => false, now = Date.now, chatEnabled=false }) {
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
  const reservedSeats = (group, actor) => {
    const flyer = group.flyer
    const requests = flyer && !flyer.revoked && flyer.expiresAt > now() ? flyer.requests : []
    return memberCount(group) + requests.filter(row => !same(row.actor, actor)).length
  }
  const validInvite = async (actor, id, inviteId) => {
    await requireLive(actor)
    const group = await store.get(id)
    if (!availableInvite(group, inviteId, actor) || !await live(group.organizer) || !await canMeet(group.organizer, actor)) fail()
    const latest = await store.get(id)
    const invite = availableInvite(latest, inviteId, actor)
    if (!invite) fail()
    return { group: latest, invite }
  }
  const currentFlyer = (group, inviteId) => {
    const flyer = group?.flyer
    if (!flyer || flyer.id !== inviteId || flyer.revoked || flyer.expiresAt <= now()) fail()
    return flyer
  }
  const addFlyerMember = (group, flyer, member) => {
    if (reservedSeats(group, member.actor) >= seatLimit(group)) fail('group_full')
    group.members.push(member)
    group.invites = pending(group).filter(row => !same(row.actor, member.actor))
    flyer.requests = flyer.requests.filter(row => !same(row.actor, member.actor))
    flyer.accepted.push(groupActorKey(member.actor))
  }
  return {
    async resolveKey(key) { const group=await store.get(key) ?? await store.bySlug?.(key);return group?.id??null },
    async create(actor, name, organizerProfileId, {urlMode="readable"}={}) {
      await requireLive(actor)
      name = cleanName(name)
      if (!name) fail('invalid_name')
      const group = { id: randomUUID(), name, organizer: binding(actor), organizerProfileId: organizerProfileId ?? null, members: [], invites: [], shares: [] }
      group.urlMode=urlMode==='opaque'?'opaque':'readable'
      group.slug=readableGroupSlug(name,group.id)
      await store.create(group)
      return summary(group)
    },
    async updateMetadata(actor, id, { description, chatUrl, openChatUrl = '', urlMode }) {
      await authorized(actor, id, true)
      if (typeof description !== 'string' || description.trim().length > 2000) fail('invalid_description')
      if(urlMode!==undefined && !["readable","opaque"].includes(urlMode))fail("invalid_input")
      chatUrl = normalizeGroupChatUrl(chatUrl)
      openChatUrl = normalizeGroupOpenChatUrl(openChatUrl)
      await update(id, group => {
        own(actor, group)
        return { ...group, slug:group.slug??readableGroupSlug(group.name,group.id), urlMode:urlMode??group.urlMode??"readable", description: description.trim(), chatUrl, openChatUrl }
      })
      return this.detail(actor, id)
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
      return { ...summary(group), ...metadata(group), urlMode:group.urlMode??"readable", chatConversationId:chatEnabled?communityChatId(group):null, organizer, organizerProfileId: group.organizerProfileId,
        shares: group.shares.map(summary),
        ...(organizer ? { members: group.members.map(person), invites: pending(group).map(row => ({ ...person(row), expiresAt: row.expiresAt })),
          capacity: seatLimit(group), flyer: group.flyer && {
            ...publicFlyer(group.flyer), active: !group.flyer.revoked && group.flyer.expiresAt > now(),
            requests: group.flyer.requests.map(person),
          } } : {}),
      }
    },
    async roster(actor, id) {
      const { group } = await authorized(actor, id)
      const candidates = [{ id: 'organizer', actor: group.organizer, profileId: group.organizerProfileId, name: 'Organizer', role: 'Organizer' }, ...group.members.map(row => ({ id: row.id, actor: row.actor, profileId: row.profileId, name: row.name, role: 'Member' }))]
      const visible = (await concurrentMap(candidates, async row => await live(row.actor) && (same(row.actor, actor) || !await blocked(actor, row.actor)) ? row : null)).filter(Boolean)
      const { group: latest } = await authorized(actor, id)
      return visible.filter(row => same(row.actor, latest.organizer) || seat(latest, row.actor))
    },
    async leave(actor,id) {
      await authorized(actor,id)
      await update(id,group=>{if(same(actor,group.organizer))fail('organizer_cannot_leave');if(!seat(group,actor))fail();group.members=group.members.filter(row=>!same(row.actor,actor));group.shares=group.shares.filter(row=>!same(row.actor,actor));return group})
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
        if (group.invites.length >= GROUP_LIMITS.invites || reservedSeats(group, recipient) >= seatLimit(group)) fail('group_full')
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
          if (reservedSeats(group, actor) >= seatLimit(group)) fail('group_full')
          if (seat(group, actor)) fail('already_member')
          group.members.push({ ...person(invite), actor: invite.actor })
          if (group.flyer) group.flyer.requests = group.flyer.requests.filter(row => !same(row.actor, actor))
        }
        group.invites = pending(group).filter(row => row.id !== invite.id)
        return group
      })
    },
    async createFlyer(actor, id, { capacity, approval }) {
      await authorized(actor, id, true)
      if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > FLYER_LIMITS.seats || typeof approval !== 'boolean') fail('invalid_capacity')
      const flyer = { id: randomUUID(), expiresAt: now() + FLYER_LIMITS.days * 86400000, approval, revoked: false, accepted: [], requests: [] }
      const group = await update(id, group => {
        own(actor, group)
        // Organizer retries return the existing printable URL.
        if (group.flyer && !group.flyer.revoked && group.flyer.expiresAt > now()) return group
        if (memberCount(group) > capacity) fail('invalid_capacity')
        return { ...group, capacity, flyer }
      })
      return publicFlyer(group.flyer)
    },
    async previewFlyer(id, inviteId) {
      const group = await store.get(id)
      currentFlyer(group, inviteId)
      if (!await live(group.organizer)) fail()
      const latest = await store.get(id)
      currentFlyer(latest, inviteId)
      return { title: latest.name }
    },
    async flyerStatus(actor, id, inviteId) {
      await requireLive(actor)
      const group = await store.get(id)
      currentFlyer(group, inviteId)
      if (!await live(group.organizer) || !await canMeet(group.organizer, actor)) fail()
      const latest = await store.get(id)
      const flyer = currentFlyer(latest, inviteId)
      if (access(latest, actor)) return 'member'
      return flyer.requests.some(row => same(row.actor, actor)) ? 'pending' : null
    },
    async joinFlyer(actor, id, inviteId, { profileId, name, source }) {
      await requireLive(actor)
      const group = await store.get(id)
      currentFlyer(group, inviteId)
      if (!await live(group.organizer) || !await canMeet(group.organizer, actor)) fail()
      const member = { id: randomUUID(), actor: binding(actor), name, profileId, flyer: { inviteId, source } }
      const next = await update(id, group => {
        const flyer = currentFlyer(group, inviteId)
        if (access(group, actor) || flyer.requests.some(row => same(row.actor, actor))) return group
        if (flyer.accepted.includes(groupActorKey(actor))) fail()
        if (memberCount(group) + flyer.requests.length >= seatLimit(group) || flyer.accepted.length + flyer.requests.length >= seatLimit(group) - 1) fail('group_full')
        if (flyer.approval) flyer.requests.push(member)
        else addFlyerMember(group, flyer, member)
        return group
      })
      return access(next, actor) ? 'member' : 'pending'
    },
    async revokeFlyer(actor, id, inviteId) {
      await authorized(actor, id, true)
      await update(id, group => {
        own(actor, group)
        if (group.flyer?.id !== inviteId) fail()
        group.flyer.revoked = true
        group.flyer.requests = []
        return group
      })
    },
    async decideFlyerRequest(actor, id, inviteId, requestId, decision) {
      const { group } = await authorized(actor, id, true)
      if (!['approve', 'decline'].includes(decision)) fail('invalid_input')
      const request = currentFlyer(group, inviteId).requests.find(row => row.id === requestId)
      if (!request) fail()
      if (decision === 'approve' && (!await live(request.actor) || !await canMeet(actor, request.actor))) fail()
      await update(id, group => {
        own(actor, group)
        const flyer = currentFlyer(group, inviteId)
        const member = flyer.requests.find(row => row.id === requestId)
        if (!member) fail()
        if (decision === 'approve' && !access(group, member.actor)) addFlyerMember(group, flyer, member)
        else flyer.requests = flyer.requests.filter(row => row.id !== requestId)
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
      return groups.flatMap(group => {
        if (same(group.organizer, actor)) return [{ ...summary(group), ...metadata(group), role: 'organizer', shares: group.shares.map(({ id, name, source, ids }) => ({ id, name, source, ids })) }]
        if (seat(group, actor)) return [{ groupId: group.id, role: 'member' }]
        if (group.flyer?.requests.some(row => same(row.actor, actor))) return [{ groupId: group.id, role: 'requested' }]
        if (pending(group).some(row => same(row.actor, actor))) return [{ groupId: group.id, role: 'invitee' }]
        return []
      })
    },
    async removeOwner(actor) {
      for (const row of await store.forActor(actor)) {
        await store.change(row.id, group => {
          if (same(group.organizer, actor)) return null
          group.members = group.members.filter(member => !same(member.actor, actor))
          group.invites = group.invites.filter(invite => !same(invite.actor, actor))
          if (group.flyer) {
            group.flyer.requests = group.flyer.requests.filter(row => !same(row.actor, actor))
            group.flyer.accepted = group.flyer.accepted.filter(key => key !== groupActorKey(actor))
          }
          return group
        })
      }
    },
  }
}
