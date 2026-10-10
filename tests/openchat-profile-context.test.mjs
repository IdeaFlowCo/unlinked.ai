import test from 'node:test'
import assert from 'node:assert/strict'
import { unlinkedProfileContext, parseUnlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'

test('OpenChat context carries a canonical public profile reference, never a recipient identity', () => {
  for (const id of ['seed-person', 'member-import-' + 'a'.repeat(64), 'public-' + 'b'.repeat(64), 'é-person']) {
    const url = unlinkedProfileContext(id)
    assert.equal(new URL(url).origin, 'https://www.unlinked.ai')
    assert.equal(decodeURIComponent(new URL(url).pathname.slice('/people/'.length)), id)
    assert.equal(parseUnlinkedProfileContext(url), url)
    assert.equal(new URL(url).search, '')
  }
})

test('profile context rejects private, contact-token, foreign and ambiguous URLs', () => {
  for (const id of ['', '.', '..', '../secret', 'a/b', 'a\\b', 'x?email=private', 'a#recipient', 'a b', 'a\n', 'x'.repeat(161), '\ud800']) assert.equal(unlinkedProfileContext(id), null)
  for (const url of ['https://www.unlinked.ai/profile', 'https://www.unlinked.ai/c/' + 'a'.repeat(24), 'https://www.unlinked.ai/profiles/private',
    'https://private.unlinked.ai/people/seed', 'https://evil.invalid/people/seed', 'https://www.unlinked.ai@evil.invalid/people/seed',
    'https://www.unlinked.ai/people/seed?email=private', 'https://www.unlinked.ai/people/seed#recipient', 'https://www.unlinked.ai/people/%2E%2E',
    'https://www.unlinked.ai/people/a%2Fb', 'https://www.unlinked.ai/people/%zz', 'https://www.unlinked.ai/people/seed/',
    'https://www.unlinked.ai/people/%73eed']) assert.equal(parseUnlinkedProfileContext(url), null)
})

test('Message links open Unlinked Messages with only the canonical public profile', async () => {
  const { unlinkedMessagesUrl } = await import('../src/utils/openchat-profile-context.mjs')
  assert.equal(unlinkedMessagesUrl(unlinkedProfileContext('seed-person')), 'https://www.unlinked.ai/messages?profile=https%3A%2F%2Fwww.unlinked.ai%2Fpeople%2Fseed-person')
  for (const privateContext of [undefined, null, 'https://www.unlinked.ai/profile', 'https://www.unlinked.ai/people/seed?email=private', { email: 'private@example.invalid' }]) assert.equal(unlinkedMessagesUrl(privateContext), 'https://www.unlinked.ai/messages')
})

test('compose links contain only explicit public context; private or unrelated fields cannot select a recipient', async () => {
  const { openChatProfileMessageUrl } = await import('../src/utils/openchat-profile-context.mjs')
  const href = new URL(openChatProfileMessageUrl(unlinkedProfileContext('seed-person')))
  assert.equal(href.origin + href.pathname, 'https://chat.ideaflow.app/app/')
  assert.deepEqual([...href.searchParams], [['intent', 'compose'], ['source', 'unlinked'], ['profile', 'https://www.unlinked.ai/people/seed-person']])
  for (const privateContext of [undefined, null, 'https://www.unlinked.ai/profile', 'https://www.unlinked.ai/people/seed?email=private', { name: 'Someone', email: 'private@example.invalid', userId: 'recipient' }]) {
    assert.deepEqual([...new URL(openChatProfileMessageUrl(privateContext)).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
  }
})
