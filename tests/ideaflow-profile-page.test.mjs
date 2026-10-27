import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createIdeaflowProfileProvider, createMemoryIdeaflowProfileChoices, IDEAFLOW_ISSUER } from '../mcp-server/ideaflow-profile.mjs'

// Ideaflow interests and asks on member profiles (unlinked-4dig.1): collapsed for visitors (second
// click), hideable by the member, read only through the member's one verified Ideaflow identity.
const snapshot = { state: 'published', complete: true, revision: 'p1', profiles: [
  { id: 'member-me', name: 'Casey Example', positions: [], education: [], skills: [] },
  { id: 'member-other', name: 'Robin Other', positions: [], education: [], skills: [] },
  { id: 'member-noid', name: 'No Identity', positions: [], education: [], skills: [] },
], connections: [], members: ['member-me', 'member-other', 'member-noid'] }
const owners = { 'member-me': { ownerId: 'owner-a', userId: 'user-a' }, 'member-other': { ownerId: 'owner-b', userId: 'user-b' }, 'member-noid': { ownerId: 'owner-c', userId: 'user-c' } }
const identities = { 'owner-a': 'sub-a', 'owner-b': 'sub-b' }
const profiles = { 'sub-a': { handle: 'casey', url: 'https://social.ideaflow.app/u/casey', interests: ['Tools for thought'], lookingFor: ['A cofounder'], offers: [], about: '' },
  'sub-b': { handle: 'robin', url: 'https://social.ideaflow.app/u/robin', interests: ['<script>x</script>'], lookingFor: [], offers: ['Intros'], about: '' } }

async function start(t) {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const owner = owners['member-me']
  const choices = createMemoryIdeaflowProfileChoices()
  const lookups = []
  const ideaflowProfiles = createIdeaflowProfileProvider({
    client: { byIdentity: async ({ issuer, subject }) => { lookups.push(subject); return issuer === IDEAFLOW_ISSUER ? profiles[subject] ?? null : null } },
    accountForProfile: async id => owners[id] ?? null,
    identityForOwner: async o => identities[o.ownerId] ? { issuer: IDEAFLOW_ISSUER, subject: identities[o.ownerId] } : null,
    choices,
  })
  handler = createPrivateBrowserHandler({
    baseUrl: endpoint.replace('http:', 'https:'),
    login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a', clientId: 'client', verifiedAt: Date.now(), displayName: 'Casey' }) },
    resolveOwner: async () => owner, signup: async () => owner,
    issueAccountGrant: async () => ({ token: 'grant' }), revokeAccountGrant: async () => {},
    ownProfileId: async () => 'member-me',
    getBackend: async () => ({ adapter: true, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [], readLegacyProfile: async () => null }),
    readPublishedSnapshot: async () => snapshot,
    complete: async () => ({ matches: [] }),
    ideaflowProfiles,
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const signIn = async () => {
    const begin = await request('/login')
    const loginCookie = begin.headers.getSetCookie()[0].split(';')[0]
    const callback = await request('/auth/callback/ideaflow?code=test&state=state', { headers: { Cookie: loginCookie } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))?.split(';')[0]
  }
  return { request, signIn, choices, lookups, origin: endpoint.replace('http:', 'https:') }
}
const section = body => body.match(/<details class="card sec ideaflow-profile"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? null

test('visitors see the section collapsed (second click), escaped and attributed', async t => {
  const { request } = await start(t)
  const body = await (await request('/people/member-other')).text()
  const s = section(body)
  assert.ok(s, 'section present by default')
  assert.match(s, /^<details class="card sec ideaflow-profile">/, 'collapsed: no open attribute')
  assert.match(s, /Interests and asks/); assert.match(s, /Intros/)
  assert.ok(s.includes('&lt;script&gt;') && !s.includes('<script>x'))
  assert.match(s, /social\.ideaflow\.app\/u\/robin/)
  assert.ok(!/Hide from my profile/.test(s))
})

test('no verified Ideaflow identity: nothing shown, nothing guessed', async t => {
  const { request, lookups } = await start(t)
  assert.equal(section(await (await request('/people/member-noid')).text()), null)
  assert.deepEqual(lookups, [])
})

test('the member controls it: open preview with Hide; hiding removes it for everyone else', async t => {
  const { request, signIn, choices, origin } = await start(t)
  const cookie = await signIn()
  const own = await (await request('/people/member-me', { headers: { Cookie: cookie } })).text()
  const mine = section(own)
  assert.match(mine, /<details class="card sec ideaflow-profile" open>/)
  assert.match(mine, /Hide from my profile/); assert.match(mine, /collapsed: visitors open it with a click/)
  const csrf = mine.match(/name="csrf" value="([^"]+)"/)[1]
  const bad = await request('/profile/ideaflow', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=wrong&visibility=hidden' })
  assert.equal(bad.status, 400); assert.equal(await choices.get({ ownerId: 'owner-a', userId: 'user-a' }), 'shown')
  const ok = await request('/profile/ideaflow', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(csrf)}&visibility=hidden` })
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/people/member-me')
  assert.equal(section(await (await request('/people/member-me')).text()), null, 'hidden for signed-out visitors')
  const after = section(await (await request('/people/member-me', { headers: { Cookie: cookie } })).text())
  assert.match(after, /Hidden from your profile/); assert.match(after, /Show on my profile/)
})
