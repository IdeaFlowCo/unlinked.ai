import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessagingProxy } from '../mcp-server/messaging-proxy.mjs'
import { renderChatPerson } from '../mcp-server/private-onboarding-views.mjs'

const session = { owner: { ownerId: 'owner', userId: 'me' } }
function proxy({ blocked = [], profiles = new Map() } = {}) {
  return createMessagingProxy({
    createMessagingSession: async () => ({ token: 'private', user: { userId: 'me' } }),
    fetchImpl: async () => new Response(JSON.stringify([{ id: 'c1', type: 'direct', participants: [{ user: { id: 'me', name: 'Me' } }, { user: { id: 'vlad', name: 'Vlad <Sitalo>' } }] }])),
    profilesForParticipants: async () => profiles,
    profilePathFor: id => `/people/${id}`,
    blockedUsers: async () => blocked,
  })
}
test('OpenChat-only participant is readable only through a current conversation, without writes', async () => {
  const p = proxy()
  const result = await p.participantProfile(session, 'c1', 'vlad')
  assert.equal(result.person.name, 'Vlad <Sitalo>')
  assert.equal(result.person.profileId, undefined)
  for (const [conversation, user] of [['other', 'vlad'], ['c1', 'stranger'], ['c1', 'me']]) {
    await assert.rejects(p.participantProfile(session, conversation, user), error => error.status === 404)
  }
  const html = renderChatPerson({ ...result }).content
  assert.match(html, /Vlad &lt;Sitalo&gt;/)
  assert.match(html, /href="\/messages\/c\/c1"/)
  assert.match(html, /unlisted does not mean private/)
})
test('linked participant retains published profile destination', async () => {
  const result = await proxy({ profiles: new Map([['vlad', 'vlad-public']]) }).participantProfile(session, 'c1', 'vlad')
  assert.equal(result.person.profilePath, '/people/vlad-public')
})
test('blocked participant has no chat profile', async () => {
  await assert.rejects(proxy({ blocked: ['vlad'] }).participantProfile(session, 'c1', 'vlad'), error => error.status === 404)
})
test('conversation API supplies a usable fallback link for OpenChat-only participants', async () => {
  let status, value
  const response = { headersSent: false, writeHead(code) { status = code; return this }, end(body) { value = JSON.parse(body); return this }, setHeader() {}, getHeader() {} }
  await proxy().handle({ method: 'GET', headers: {} }, response, new URL('https://www.unlinked.ai/messages/api/conversations'), session)
  assert.equal(status, 200)
  const participants = value.conversations[0].participants
  assert.equal(participants.find(person => person.id === 'vlad').chatProfilePath, '/messages/person/c1/vlad')
  assert.equal(participants.find(person => person.id === 'me').chatProfilePath, undefined)
})
