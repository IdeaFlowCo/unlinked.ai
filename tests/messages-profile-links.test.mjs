// Jacob, 2026-10-24: in Messages, the other person's name and avatar in the
// open conversation's header (and the dock window title, and sender names in
// groups) lead to their Unlinked profile; someone without one stays plain text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatProfileHref } from '../mcp-server/messages-client.mjs'
import { createMessagingProxy } from '../mcp-server/messaging-proxy.mjs'

test('chat navigation prefers published links and provides a conversation-scoped fallback', () => {
  assert.equal(chatProfileHref({ profilePath: '/people/vlad', chatProfilePath: '/messages/person/c/v' }), '/people/vlad')
  assert.equal(chatProfileHref({ profileId: 'a b' }), '/people/a%20b')
  assert.equal(chatProfileHref({ chatProfilePath: '/messages/person/c/v' }), '/messages/person/c/v')
  assert.equal(chatProfileHref(null, 'c', { c: 'known' }), '/people/known')
  assert.equal(chatProfileHref(null), null)
})

test('the proxy adds the profile page path only for a linked partner, and only a /people/ path', async () => {
  const conversations = [{ id: 'c1', type: 'direct', participants: [{ user: { id: 'me', name: 'Me' } }, { user: { id: 'oc-ada', name: 'Ada' } }, { user: { id: 'oc-none', name: 'Nobody' } }] }]
  const run = async profilePathFor => {
    const proxy = createMessagingProxy({
      createMessagingSession: async () => ({ token: 't', user: { userId: 'me' } }),
      fetchImpl: async () => new Response(JSON.stringify(conversations), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      profilesForParticipants: async () => new Map([['oc-ada', 'ada-public']]),
      profilePathFor,
    })
    let status, body
    const response = { headersSent: false, writeHead(code) { status = code; return this }, end(value) { body = value; return this }, setHeader() {}, getHeader() {} }
    await proxy.handle({ method: 'GET', headers: {} }, response, new URL('https://www.unlinked.ai/messages/api/conversations'), { owner: { ownerId: 'o', userId: 'u' }, csrf: 'x' })
    assert.equal(status, 200)
    return Object.fromEntries(JSON.parse(body).conversations[0].participants.map(person => [person.id, [person.profileId, person.profilePath]]))
  }
  assert.deepEqual(await run(id => `/people/handle-for-${id}`), { me: [undefined, undefined], 'oc-ada': ['ada-public', '/people/handle-for-ada-public'], 'oc-none': [undefined, undefined] })
  assert.deepEqual((await run(() => 'https://elsewhere.invalid/x'))['oc-ada'], ['ada-public', undefined])
  assert.deepEqual((await run(() => { throw Error('boom') }))['oc-ada'], ['ada-public', undefined])
  assert.deepEqual((await run(null))['oc-ada'], ['ada-public', undefined])
})
