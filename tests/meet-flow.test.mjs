import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOpenChatCard, openChatCardUrl } from '../src/utils/openchat-card.js'

const token = 'AbC123def456GHI789jkl012'

test('preserves either exact OpenChat card origin through the handoff', () => {
  for (const origin of ['https://chat.globalbr.ai', 'https://chat.ideaflow.app']) {
    const card = { origin, token }
    assert.deepEqual(parseOpenChatCard(`${origin}/c/${token}`), card)
    assert.deepEqual(parseOpenChatCard(` ${origin}/c/${token}/ `), card)
    assert.equal(openChatCardUrl(card), `${origin}/c/${token}`)
  }
  assert.deepEqual(parseOpenChatCard(`https://CHAT.IDEAFLOW.APP:443/c/${token}`), { origin: 'https://chat.ideaflow.app', token })
})

test('rejects foreign origins, other intents, and malformed tokens', () => {
  for (const value of [
    `http://chat.globalbr.ai/c/${token}`,
    `http://chat.ideaflow.app/c/${token}`,
    `openchat://card/${token}`,
    `https://chat.ideaflow.app:444/c/${token}`,
    `https://chat.globalbr.ai.evil.test/c/${token}`,
    `https://chat.ideaflow.app.evil.test/c/${token}`,
    `https://chat-ideaflow.app/c/${token}`,
    `https://evil.test/c/${token}`,
    `https://chat.globalbr.ai@evil.test/c/${token}`,
    `https://evil.test@chat.ideaflow.app/c/${token}`,
    `https://@chat.globalbr.ai/c/${token}`,
    `https://chat.globalbr.ai/u/${token}`,
    `https://chat.ideaflow.app/app/?intent=card&token=${token}`,
    `https://chat.globalbr.ai/c/${token}?next=https://evil.test`,
    `https://chat.ideaflow.app/c/${token}?`,
    `https://chat.globalbr.ai/c/${token}#details`,
    `https://chat.ideaflow.app/c/${token}#`,
    `https://chat.globalbr.ai/c/${token}/another`,
    `https://chat.ideaflow.app/c/${token}/another`,
    `https://chat.ideaflow.app/x/../c/${token}`,
    `openchat://invite/${token}`,
    `openchat://card/${token}?other=1`,
    `https://chat.globalbr.ai/c/${token.slice(0, 23)}`,
    `https://chat.ideaflow.app/c/${token.slice(0, 23)}`,
    `https://chat.globalbr.ai/c/${token.slice(0, 23)}_`,
    `https://chat.ideaflow.app/c/${token.slice(0, 23)}_`,
    'not a URL',
  ]) assert.equal(parseOpenChatCard(value), null, value)
  assert.throws(() => openChatCardUrl({ origin: 'https://chat.ideaflow.app.evil.test', token }))
  assert.throws(() => openChatCardUrl({ origin: 'https://chat.ideaflow.app', token: 'not-a-token' }))
})
