import { parseOpenChatCard, openChatCardUrl } from './openchat-card.js'
import { parseUnlinkedCard, unlinkedProfilePath } from './unlinked-card.js'

/**
 * Classify a scanned or pasted Meet code. Returns a displayable, pre-validated
 * target or null; the caller must still ask the person to confirm before
 * opening it. Nothing here adds a contact or grants any access.
 */
export function classifyMeetCode(value) {
  const openChat = parseOpenChatCard(value)
  if (openChat) return { kind: 'openchat', href: openChatCardUrl(openChat), label: `OpenChat card on ${new URL(openChat.origin).host}` }
  const unlinked = parseUnlinkedCard(value)
  if (unlinked) return { kind: 'unlinked', href: unlinkedProfilePath(unlinked), label: unlinked.contact ? 'Unlinked contact card' : 'Unlinked profile' }
  return null
}
