import { IDEAFLOW_ISSUER } from './messaging.mjs'
import { unlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'

export const PROFILE_ASK_ID = /^[A-Za-z0-9_-]{1,80}$/
export class ProfileAskError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const validIdentity = value => value?.issuer === IDEAFLOW_ISSUER && typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.subject)
// No graph/store here: OpenChat owns records, audience, lifecycle and blocking.
export function createProfileAsks({ secret, identityForOwner, resolveRecipient, fetchImpl = fetch }) {
  const exchange = async value => {
    if (!secret || secret.length < 32) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
    const response = await fetchImpl('https://chat.ideaflow.app/api/unlinked/profile-asks', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(value),
    })
    const text = await response.text()
    if (text.length > 2000000) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
    let result
    try { result = JSON.parse(text) } catch { throw new ProfileAskError(503, 'Asks are temporarily unavailable.') }
    if (!response.ok) throw new ProfileAskError([400,403,404,409,429].includes(response.status) ? response.status : 503, response.status === 409 ? 'This ask changed. Reload your profile before saving.' : response.status < 500 ? 'Could not save this ask. Check its text, audience and expiry, then try again.' : 'Asks are temporarily unavailable.')
    return result
  }
  const identity = async owner => {
    const value = await identityForOwner(owner)
    if (!validIdentity(value)) throw new ProfileAskError(403, 'Your account could not be verified.')
    return { issuer: value.issuer, subject: value.subject }
  }
  const dto = (ask, owner = false) => {
    if (typeof ask?.id !== 'string' || !PROFILE_ASK_ID.test(ask.id) || ask.kind !== 'ask' || typeof ask.text !== 'string' || ask.text.length > 2000 || !Number.isFinite(Date.parse(ask.expiresAt))) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
    if (owner && (!Number.isSafeInteger(ask.revision) || ask.revision < 0 || !['active','paused','withdrawn'].includes(ask.status) || !['private','selected','public'].includes(ask.visibility) || !Array.isArray(ask.userIds) || !Array.isArray(ask.conversationIds))) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
    return { id: ask.id, kind: 'ask', text: ask.text, expiresAt: ask.expiresAt,
      ...(owner ? { revision: ask.revision, visibility: ask.visibility, status: ask.status, userIds: ask.userIds ?? [], conversationIds: ask.conversationIds ?? [] } : {}) }
  }
  return {
    async forProfile(profileId, viewerOwner) {
      // Same exact live claimed-owner binding as addressed OpenChat messages.
      const recipient = await resolveRecipient(profileId)
      if (recipient.status !== 'member' || !validIdentity(recipient.identity)) return []
      const result = await exchange({ operation: 'list', owner: recipient.identity, viewer: viewerOwner ? await identity(viewerOwner) : null })
      if (!Array.isArray(result.asks) || result.asks.length > 50) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
      return result.asks.filter(ask => Number.isFinite(Date.parse(ask.expiresAt)) && Date.parse(ask.expiresAt) > Date.now() && (!ask.status || ask.status === 'active')).map(ask => dto(ask))
    },
    async mine(owner) {
      const binding = await identity(owner)
      const [result, audience] = await Promise.all([
        exchange({ operation: 'list', owner: binding, viewer: binding }), exchange({ operation: 'audience', owner: binding, viewer: binding }),
      ])
      if (!Array.isArray(result.asks) || result.asks.length > 100 || !Array.isArray(audience.people) || !Array.isArray(audience.groups)) throw new ProfileAskError(503, 'Asks are temporarily unavailable.')
      return { asks: result.asks.map(ask => dto(ask, true)), audience }
    },
    async mutate(owner, operation, askId, input) {
      if (!['publish','edit','close','remove'].includes(operation) || (operation !== 'publish' && (typeof askId !== 'string' || !PROFILE_ASK_ID.test(askId)))) throw new ProfileAskError(400, 'Invalid ask.')
      const binding = await identity(owner)
      return exchange({ operation, owner: binding, viewer: binding, ...(askId ? { askId } : {}), input })
    },
  }
}
export function profileAskMessagePath(profileId, askId) {
  const profile = unlinkedProfileContext(profileId)
  return profile && typeof askId === 'string' && PROFILE_ASK_ID.test(askId) ? `/messages?${new URLSearchParams({ profile, askId })}` : null
}
