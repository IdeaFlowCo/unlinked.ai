import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { InvitationError } from './member-invitations.mjs'
import { ConnectionError } from './member-connections.mjs'

// The rules for acting on another member's public profile, shared by the
// signed-in browser (private-browser.mjs) and agent write tools
// (account-tools.mjs), so both go through the same checks and the same
// per-account limits stored with the requests (member-connections.mjs).
//
// - Only a `member` profile with exactly one active account behind it
//   (`accountForProfile`) can be asked; shadows cannot.
// - Someone already connected some other way (an accepted invite, or the public
//   graph linking the two profiles because one listed the other in an export)
//   is Connected and cannot be asked.
// - The sender is named by their own public profile when they have one.
export function createConnectionActions({ memberConnections, accountForProfile, ownProfileId, memberInvitations, readPublishedSnapshot }) {
  if (!memberConnections || typeof accountForProfile !== 'function') throw new Error('connection_actions_configuration_required')
  const sameAccount = (a, b) => a.ownerId === b.ownerId && a.userId === b.userId
  const readerFor = reader => reader ?? createPublicPeopleReader({ readPublishedSnapshot, reuse: true })
  const mineFor = async owner => typeof ownProfileId === 'function' ? await ownProfileId(owner) : null

  // Where `owner` stands with the members behind `profileIds`, read in one
  // pass: the viewer's own profile, invite connections and public graph
  // neighbours are read once; each member profile costs one account lookup and
  // one pair read. Profiles with no single account behind them are left out.
  async function relations(owner, profileIds, { reader } = {}) {
    const ids = [...new Set(profileIds.filter(id => typeof id === 'string' && id))]
    const out = new Map()
    if (!ids.length) return out
    const shared = readerFor(reader)
    const [mine, invited] = await Promise.all([mineFor(owner), memberInvitations ? memberInvitations.connections(owner) : []])
    const linked = mine && typeof readPublishedSnapshot === 'function' ? new Set((await shared.neighbors({ id: mine })).map(value => value.id)) : new Set()
    await Promise.all(ids.map(async id => {
      const account = await accountForProfile(id)
      if (!account) return
      if (sameAccount(owner, account)) { out.set(id, { state: 'self' }); return }
      const between = await memberConnections.between(owner, account)
      if (between.state !== 'none') { out.set(id, between); return }
      const invitation = invited.find(value => sameAccount(value.other, account))
      out.set(id, invitation ? { state: 'connected', requestId: `invite:${invitation.invitationId}` } : linked.has(id) ? { state: 'connected' } : { state: 'none' })
    }))
    return out
  }
  const relationTo = async (owner, profileId, options) => (await relations(owner, [profileId], options)).get(profileId)

  // Sends a request to the member behind a public profile. Resolves a merged
  // profile to its survivor first. Returns { code, profileId }: `sent` or
  // `accepted` (they had already asked), else a ConnectionError code.
  // Throws ConnectionError('connection_profile_not_found') for an unknown id.
  async function send(owner, { profileId, note, fallbackName, reader } = {}) {
    const shared = readerFor(reader)
    let id = profileId, detail = await shared.profile({ id })
    if (detail?.moved) { id = detail.moved; detail = await shared.profile({ id }) }
    if (!detail?.profile) throw new ConnectionError('connection_profile_not_found')
    if (detail.profile.presence !== 'member') return { code: 'connection_not_member', profileId: id }
    const account = await accountForProfile(id)
    if (!account) return { code: 'connection_not_member', profileId: id }
    if (sameAccount(owner, account)) return { code: 'connection_self', profileId: id }
    const relation = await relationTo(owner, id, { reader: shared })
    if (relation?.state === 'connected' && (!relation.requestId || relation.requestId.startsWith('invite:'))) return { code: 'connection_exists', profileId: id }
    const senderProfileId = await mineFor(owner)
    let senderName = fallbackName
    if (senderProfileId) { try { senderName = (await shared.lookup({ ids: [senderProfileId] })).get(senderProfileId)?.name ?? senderName } catch { /* keep the fallback name */ } }
    try {
      const sent = await memberConnections.send({ sender: owner, senderName, senderProfileId, recipient: account, recipientName: detail.profile.name, recipientProfileId: id, note })
      return { code: sent.status === 'accepted' ? 'accepted' : 'sent', profileId: id, request: sent.request }
    } catch (failure) {
      if (!(failure instanceof ConnectionError)) throw failure
      return { code: failure.code, profileId: id }
    }
  }
  async function remove(owner, id) {
    const [requests, invitations] = await Promise.all([
      memberConnections.connections(owner),
      memberInvitations ? memberInvitations.connections(owner) : [],
    ])
    const isInvite = typeof id === 'string' && id.startsWith('invite:')
    const selected = isInvite ? invitations.find(value => `invite:${value.invitationId}` === id) : requests.find(value => value.requestId === id)
    if (!selected) throw new ConnectionError('connection_not_found')
    for (const request of requests.filter(value => sameAccount(value.other, selected.other))) {
      await memberConnections.remove(owner, request.requestId)
    }
    for (const invitation of invitations.filter(value => sameAccount(value.other, selected.other))) {
      try { await memberInvitations.remove(owner, invitation.invitationId) }
      catch (error) { if (error instanceof InvitationError) throw new ConnectionError(error.code === 'invitation_not_found' ? 'connection_not_found' : 'connection_unavailable'); throw error }
    }
  }
  return { relations, relationTo, send, remove }
}
