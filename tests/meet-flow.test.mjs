import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOpenChatCard, openChatCardUrl } from '../src/utils/openchat-card.js'

const token = 'AbC123def456GHI789jkl012'

test('accepts only an OpenChat card with the server token grammar', () => {
  assert.equal(parseOpenChatCard(`https://chat.globalbr.ai/c/${token}`), token)
  assert.equal(parseOpenChatCard(` https://chat.globalbr.ai/c/${token}/ `), token)
  assert.equal(parseOpenChatCard(`openchat://card/${token}`), token)
  assert.equal(openChatCardUrl(token), `https://chat.globalbr.ai/c/${token}`)
})

test('rejects foreign origins, other intents, and malformed tokens', () => {
  for (const value of [
    `http://chat.globalbr.ai/c/${token}`,
    `https://chat.globalbr.ai.evil.test/c/${token}`,
    `https://evil.test/c/${token}`,
    `https://chat.globalbr.ai@evil.test/c/${token}`,
    `https://chat.globalbr.ai/u/${token}`,
    `https://chat.globalbr.ai/c/${token}?next=https://evil.test`,
    `https://chat.globalbr.ai/c/${token}#details`,
    `https://chat.globalbr.ai/c/${token}/another`,
    `openchat://invite/${token}`,
    `openchat://card/${token}?other=1`,
    `https://chat.globalbr.ai/c/${token.slice(0, 23)}`,
    `https://chat.globalbr.ai/c/${token.slice(0, 23)}_`,
    'not a URL',
  ]) assert.equal(parseOpenChatCard(value), null, value)
  assert.throws(() => openChatCardUrl('not-a-token'))
})
