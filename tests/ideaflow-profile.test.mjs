import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdeaflowProfileClient, normalizeProfile, ideaflowProfileCard, ownerKey, IDEAFLOW_ISSUER } from '../mcp-server/ideaflow-profile.mjs'

const v1 = (extra = {}) => ({ schema: 'ideaflow.profile.v1', handle: 'ava', interests: ['Tools for thought', 'Tools for thought', 'Graph DBs'], looking_for: [{ id: 3, title: 'A cofounder' }], offers: [{ id: 4, title: 'Neo4j intros' }], about: 'Hi', entries: [], ...extra })
const res = (status, body) => ({ status, json: async () => body })

test('normalizes ProfileV1 and fails closed on anything unexpected', () => {
  assert.deepEqual(normalizeProfile(v1(), { origin: 'https://social.ideaflow.app' }), { handle: 'ava', url: 'https://social.ideaflow.app/u/ava', interests: ['Tools for thought', 'Graph DBs'], lookingFor: ['A cofounder'], offers: ['Neo4j intros'], about: 'Hi' })
  assert.equal(normalizeProfile(v1({ schema: 'other' })), null)
  assert.equal(normalizeProfile(v1({ handle: '<script>' })), null)
  assert.equal(normalizeProfile(v1({ interests: [], looking_for: [], offers: [] })), null, 'nothing to show')
  const long = normalizeProfile(v1({ interests: Array.from({ length: 20 }, (_, i) => i + 'x'.repeat(400)) }))
  assert.equal(long.interests.length, 8); assert.ok(long.interests.every(t => t.length <= 160))
})

test('looks up by owner key with timeout-safe failures and caching', async () => {
  const calls = []
  let next = res(200, v1())
  const client = createIdeaflowProfileClient({ fetchImpl: async (url) => { calls.push(url); if (next instanceof Error) throw next; return next } })
  const key = ownerKey(IDEAFLOW_ISSUER, 'sub-ava')
  assert.equal((await client.byIdentity({ issuer: IDEAFLOW_ISSUER, subject: 'sub-ava' })).handle, 'ava')
  assert.equal(calls[0], `https://social.ideaflow.app/api/profiles/by-owner-key/${key}`)
  await client.byOwnerKey(key); assert.equal(calls.length, 1, 'cached')
  next = res(404, { error: 'Not found' })
  assert.equal(await client.byOwnerKey('a'.repeat(64)), null)
  next = new Error('timeout')
  assert.equal(await client.byOwnerKey('b'.repeat(64)), null)
  assert.equal(await client.byOwnerKey('not-a-key'), null)
  assert.equal(await client.byIdentity({ issuer: 'https://evil.example', subject: 'x' }), null)
  assert.throws(() => createIdeaflowProfileClient({ origin: 'http://evil.example' }), /origin_invalid/)
})

test('renders an escaped card with attribution; self preview says only you see it', () => {
  const card = ideaflowProfileCard(normalizeProfile(v1({ interests: ['<b>bold</b>'] }), { origin: 'https://social.ideaflow.app' }))
  assert.match(card, /Interested in/); assert.match(card, /&lt;b&gt;bold&lt;\/b&gt;/); assert.ok(!card.includes('<b>bold'))
  assert.match(card, /href="https:\/\/social\.ideaflow\.app\/u\/ava"/)
  assert.match(ideaflowProfileCard(normalizeProfile(v1()), { self: true }), /Only you see this preview/)
  assert.equal(ideaflowProfileCard(null), '')
})
