import test from 'node:test'
import assert from 'node:assert/strict'
import { projectConversation, projectMessage } from '../mcp-server/messaging-proxy.mjs'
import { MESSAGES_CLIENT_SOURCE } from '../mcp-server/messages-client.mjs'

// Regression coverage for Jacob's report: "our app is truncating long
// messages. It shouldn't do that." Kept in its own file (rather than
// tests/messaging-proxy.test.mjs) so it does not pull in private-browser.mjs's
// unrelated, heavier dependency chain.

const CONV = 'conv_1', ME = 'oc-me', OTHER = 'oc-other'
const message = (id, content, at, senderId = OTHER) => ({
  id, conversationId: CONV, senderId,
  sender: { id: senderId, name: senderId === ME ? 'Me' : 'Avery' },
  content, messageType: 'text', createdAt: at, reactions: [], attachments: [], linkPreviews: [],
})

test('a long message sent from OpenChat round-trips through Unlinked\'s proxy without truncation', () => {
  // OpenChat itself enforces no content length cap on its own send paths
  // (apps/server/src/routes/chat.ts has none), so a message well beyond this
  // proxy's own 8000-char MAX_CONTENT *send* limit can still arrive here when
  // it was sent from OpenChat's own web/mobile apps. projectMessage must not
  // silently cut it down again on the way to the browser.
  const long = 'Lorem ipsum dolor sit amet. '.repeat(1000) // ~28,000 chars
  assert.ok(long.length > 20000, 'fixture must exceed the old 20,000-char cap to prove the fix')
  const projected = projectMessage(message('m-long', long, '2026-10-10T10:00:00Z'))
  assert.equal(projected.content, long)
  assert.equal(projected.content.length, long.length)
})

test('conversation-list preview text stays intentionally short — only the full message body must never be shortened', () => {
  const long = 'Lorem ipsum dolor sit amet. '.repeat(1000)
  const conversation = projectConversation({
    id: CONV, type: 'direct',
    lastMessage: { id: 'm-long', content: long, senderId: OTHER, createdAt: '2026-10-10T10:00:00Z' },
    participants: [],
  })
  assert.equal(conversation.lastMessage.content.length, 280)
})

test('a message right at the proxy\'s own 8000-char send limit still round-trips in full', () => {
  const atLimit = 'x'.repeat(8000)
  const projected = projectMessage(message('m-8000', atLimit, '2026-10-10T10:00:00Z'))
  assert.equal(projected.content.length, 8000)
})

test('composer textareas never carry a native maxlength (regression: silently clips a paste with no feedback)', () => {
  // A plain <textarea maxlength="8000"> truncates a pasted string longer than
  // the limit with zero error and zero visual indication — exactly the
  // silent "truncating long messages" bug Jacob reported. Composers must
  // validate at submit time instead, where the member can be told what
  // happened and keep their draft.
  assert.doesNotMatch(MESSAGES_CLIENT_SOURCE, /maxlength:\s*'8000'/)
  assert.match(MESSAGES_CLIENT_SOURCE, /MAX_CONTENT\s*=\s*8000/)
  assert.match(MESSAGES_CLIENT_SOURCE, /too long to send/)
})
