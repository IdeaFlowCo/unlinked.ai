import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
const profile = id => ({ id, name: id, positions: [], education: [], skills: [] })
test('network attachment and settings controls require a live operator-verified signed-in account', async t => {
  let handler, verified = false
  const owner = { ownerId: 'owner', userId: 'user' }
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [] }
  handler = createPrivateBrowserHandler({ baseUrl, isVerified: async bound => { assert.deepEqual(bound, owner); return verified },
    login: { begin: async () => ({ location: 'https://identity.invalid/start', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'subject' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => 'synthetic-grant', revokeAccountGrant: async () => {}, getBackend: async bound => { assert.deepEqual(bound, owner); return backend },
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'browser-export', profiles: ['alice', 'bob'].map(profile), connections: [{ fromId: 'alice', toId: 'bob' }] }),
  })
  const anonymous = await fetch(`${endpoint}/network/export`, { redirect: 'manual' }); assert.equal(anonymous.status, 401)
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const callback = await fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic&state=state`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  assert.equal(callback.status, 303)
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0], headers = { Cookie: cookie }
  assert.equal((await fetch(`${endpoint}/network/export?verified=true`, { headers })).status, 403)
  assert.equal((await fetch(`${endpoint}/settings`, { headers })).status, 200)
  assert.doesNotMatch(await (await fetch(`${endpoint}/settings`, { headers })).text(), /<h2>Verified access/)
  verified = true
  const settings = await (await fetch(`${endpoint}/settings`, { headers })).text()
  assert.match(settings, /<title>Settings · Unlinked<\/title>/)
  assert.match(settings, /<h2>Verified access/)
  const download = await fetch(`${endpoint}/network/export?ids=alice`, { headers })
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /attachment/)
  assert.match(download.headers.get('cache-control'), /no-store/)
  const rows = (await download.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.at(-1).type, 'complete'); assert.equal(rows.at(-1).profiles, 1)
  assert.equal(rows.filter(row => row.type === 'connection').length, 0)
  assert.equal((await fetch(`${endpoint}/network/export?ownerId=someone-else`, { headers })).status, 400)
  verified = false
  assert.equal((await fetch(`${endpoint}/network/export`, { headers })).status, 403)
})
