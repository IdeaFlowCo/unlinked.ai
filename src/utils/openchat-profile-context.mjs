/** Public professional context only; this never identifies an OpenChat recipient. */
export const UNLINKED_PROFILE_ORIGIN = 'https://www.unlinked.ai'

export function unlinkedProfileContext(profileId) {
  if (typeof profileId !== 'string' || !profileId || profileId.length > 160 ||
      profileId === '.' || profileId === '..' || /[\s/\\?#\u0000-\u001f\u007f]/u.test(profileId)) return null
  let encoded
  try { encoded = encodeURIComponent(profileId).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`) } catch { return null }
  return encoded.length <= 480 ? `${UNLINKED_PROFILE_ORIGIN}/people/${encoded}` : null
}

export function parseUnlinkedProfileContext(value) {
  if (typeof value !== 'string' || value.length > 520) return null
  const match = /^https:\/\/www\.unlinked\.ai\/people\/([A-Za-z0-9._~%-]{1,480})$/.exec(value)
  if (!match) return null
  let decoded
  try { decoded = decodeURIComponent(match[1]) } catch { return null }
  const canonical = unlinkedProfileContext(decoded)
  return canonical === value ? canonical : null
}

/**
 * Unlinked's own Messages (docs/openchat-message.md): the server resolves the
 * public profile to its member's OpenChat conversation; nothing is sent on open.
 * Without valid public context it opens the inbox.
 */
export function unlinkedMessagesUrl(profileUrl) {
  const context = parseUnlinkedProfileContext(profileUrl)
  return context ? `${UNLINKED_PROFILE_ORIGIN}/messages?profile=${encodeURIComponent(context)}` : `${UNLINKED_PROFILE_ORIGIN}/messages`
}

/** The OpenChat-owned compose receiver leaves recipient choice to the sender. */
export function openChatProfileMessageUrl(profileUrl) {
  const entry = new URL('https://chat.ideaflow.app/app/')
  entry.searchParams.set('intent', 'compose')
  entry.searchParams.set('source', 'unlinked')
  const context = parseUnlinkedProfileContext(profileUrl)
  if (context) entry.searchParams.set('profile', context)
  return entry.href
}
