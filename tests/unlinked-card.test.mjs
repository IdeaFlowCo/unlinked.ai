import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnlinkedCard, unlinkedProfilePath } from '../src/utils/unlinked-card.js'
import { classifyMeetCode } from '../src/utils/meet-scan.js'

const id = 'c2d609ce-fa01-4a8f-8dcc-710292e4a56c'
const memberId = `member-import-${'ab'.repeat(32)}`

test('accepts exactly the canonical public profile URL grammar', () => {
  for (const origin of ['https://www.unlinked.ai', 'https://private.unlinked.ai']) {
    assert.deepEqual(parseUnlinkedCard(`${origin}/people/${id}`), { origin, id })
    assert.deepEqual(parseUnlinkedCard(` ${origin}/people/${id}/ `), { origin, id })
  }
  assert.deepEqual(parseUnlinkedCard(`https://WWW.UNLINKED.AI:443/people/${memberId}`), { origin: 'https://www.unlinked.ai', id: memberId })
  assert.equal(unlinkedProfilePath({ origin: 'https://www.unlinked.ai', id }), `/people/${id}`)
  assert.equal(unlinkedProfilePath(parseUnlinkedCard(`https://www.unlinked.ai/people/with%20space`)), '/people/with%20space')
})

test('rejects foreign origins, other routes and unsafe targets', () => {
  for (const value of [
    `http://www.unlinked.ai/people/${id}`,
    `https://unlinked.ai/people/${id}`,
    `https://www.unlinked.ai.evil.test/people/${id}`,
    `https://evil.test@www.unlinked.ai/people/${id}`,
    `https://www.unlinked.ai@evil.test/people/${id}`,
    `https://www.unlinked.ai:444/people/${id}`,
    `https://www.unlinked.ai/people/${id}?next=https://evil.test`,
    `https://www.unlinked.ai/people/${id}#x`,
    `https://www.unlinked.ai/people/${id}?`,
    `https://www.unlinked.ai/people/${id}/more`,
    `https://www.unlinked.ai/people/`,
    `https://www.unlinked.ai/people/${'a'.repeat(481)}`,
    `https://www.unlinked.ai/people/%zz`,
    `https://www.unlinked.ai/people/a<b`,
    `https://www.unlinked.ai/settings`,
    `https://www.unlinked.ai/x/../people/${id}`,
    `https://www.unlinked.ai/people/..%2fsettings`.replace('%2f', '/'),
    'unlinked://people/abc',
    'not a URL',
    `https://www.unlinked.ai\\people\\${id}`,
  ]) assert.equal(parseUnlinkedCard(value), null, value)
  // Encoded traversal stays encoded; it is a literal path segment, never a new route.
  assert.deepEqual(parseUnlinkedCard('https://www.unlinked.ai/people/..%2Fsettings'), { origin: 'https://www.unlinked.ai', id: '..%2Fsettings' })
  assert.equal(unlinkedProfilePath({ origin: 'https://www.unlinked.ai', id: '..%2Fsettings' }), '/people/..%2Fsettings')
  assert.throws(() => unlinkedProfilePath({ origin: 'https://evil.test', id }))
  assert.throws(() => unlinkedProfilePath({ origin: 'https://www.unlinked.ai', id: 'a/b' }))
})

test('classifyMeetCode labels both supported kinds and nothing else', () => {
  const openchat = classifyMeetCode('https://chat.ideaflow.app/c/AbC123def456GHI789jkl012')
  assert.equal(openchat.kind, 'openchat')
  assert.equal(openchat.href, 'https://chat.ideaflow.app/c/AbC123def456GHI789jkl012')
  assert.match(openchat.label, /OpenChat card on chat\.ideaflow\.app/)
  const unlinked = classifyMeetCode(`https://www.unlinked.ai/people/${id}`)
  assert.equal(unlinked.kind, 'unlinked')
  // Relative target: opening a scanned profile never changes hosts.
  assert.equal(unlinked.href, `/people/${id}`)
  assert.equal(unlinked.label, 'Unlinked profile')
  for (const value of ['https://evil.test/people/x', `https://www.unlinked.ai/settings`, 'tel:+15551234567', '']) assert.equal(classifyMeetCode(value), null, value)
})
