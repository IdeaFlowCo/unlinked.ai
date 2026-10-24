// Jacob, 2026-10-24: in Messages, the other person's name and avatar in the
// open conversation's header (and the dock window title, and sender names in
// groups) lead to their Unlinked profile; someone without one stays plain text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGES_CLIENT_SOURCE } from '../mcp-server/messages-client.mjs'
import { createMessagingProxy } from '../mcp-server/messaging-proxy.mjs'

test('the client links the header person, the dock title and group senders through one profileHref helper, with no dead-link fallback', () => {
  const source = MESSAGES_CLIENT_SOURCE
  assert.match(source, /const profileHref = \(person, conversationId\) => person\?\.profilePath \|\| \(person\?\.profileId \? `\/people\/\$\{encodeURIComponent\(person\.profileId\)\}` : conversationId && profiles\[conversationId\] \? `\/people\/\$\{encodeURIComponent\(profiles\[conversationId\]\)\}` : null\)/)
  assert.match(source, /href \? h\('a', \{ class: 'msg-thread-person', href, title: `View \$\{title\}’s Unlinked profile` \}, \.\.\.who\(\)\) : h\('div', \{ class: 'msg-thread-person' \}, \.\.\.who\(\)\)/)
  assert.match(source, /const href = profileHref\(peer, id\)/)
  assert.match(source, /function senderLabel\(message\)[\s\S]*profileHref\(sender\)[\s\S]*h\('span', \{ class: 'msg-sender' \}, href \? h\('a', \{ href \}, name\) : name\)/)
  assert.doesNotMatch(source, /View on Unlinked/)
  // Every profile address comes from the helper; nothing hand-builds one from a name.
  assert.equal((source.match(/\/people\//g) ?? []).length, 2)
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
