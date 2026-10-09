import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const profile = (id, name) => ({ id, name, headline: 'Engineer', positions: [{ title: 'Engineer', company: 'Test Company' }], education: [], skills: [] })
test('anonymous People reads only public professional snapshot; no-import member searches Everyone with CSRF and exact owner', async t => {
  let handler, backendReads = 0, models = 0, down = false
  const owner = { ownerId: 'test-owner', userId: 'test-user' }
  const data = { state: 'published', complete: true, revision: 'public-test-v1', profiles: [profile('first', 'A First'), profile('last', 'Z Last')], connections: [{ fromId: 'first', toId: 'last' }] }
  const server = createServer((req,res) => void handler(req,res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'verified-subject', verifiedEmail: 'test@example.invalid', displayName: 'Verified Person' }),
  }, resolveOwner: async identity => identity.subject === 'verified-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async value => { assert.deepEqual(value, owner); backendReads++; return { adapter: {}, listImportIds: async () => [], listImportJobIds: async () => [], readResource: async () => null } },
  readPublishedSnapshot: async () => { if (down) throw Error('index down'); return data },
  complete: async ({ candidateIds, input }) => { models++; assert.ok(!input.includes('test@example')); return { matches: [{ id: candidateIds[0], reason: 'Name matches' }] } },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const list = await request('/api/people?q=Last'); assert.equal(list.status,200)
  assert.deepEqual((await list.json()).profiles.map(p => p.id), ['last'])
  const detail = await request('/api/people/first'); assert.equal(detail.status,200); assert.equal((await detail.json()).profile.connections[0].id,'last')
  assert.equal((await request('/api/people/missing')).status,404)
  assert.equal((await request('/api/people?q=x&q=y')).status,400)
  assert.equal((await request('/people/last')).status,200)
  const publicPage = await request('/network'); assert.equal(publicPage.status,200); const publicHTML = await publicPage.text(); assert.match(publicHTML,/method="get" action="\/network"/); assert.doesNotMatch(publicHTML,/name="csrf"|\/search-account|Signed in as/)
  assert.equal(backendReads,0)
  assert.equal((await request('/settings')).status,401)
  const anonymousSearch = await request('/search-account', { method:'POST', headers: { Origin:baseUrl, 'Content-Type':'application/x-www-form-urlencoded' }, body:'query=Last&scope=everyone' })
  assert.equal(anonymousSearch.status,401); assert.equal(models,0)
  const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state',{headers:{Cookie:loginCookie}})
  assert.equal(callback.status,303)
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const ownProfile = await request('/profile',{headers:{Cookie:session}}); assert.equal(ownProfile.status,200); assert.match(await ownProfile.text(), /Verified Person/)
  const people = await request('/network',{headers:{Cookie:session}}); assert.equal(people.status,200)
  const page = await people.text(), csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  const submit = body => request('/search-account', {method:'POST',headers:{Cookie:session,Origin:baseUrl,'Content-Type':'application/x-www-form-urlencoded'},body})
  assert.equal((await submit('query=Last&scope=everyone&csrf=wrong')).status,400)
  const searched = await submit(new URLSearchParams({query:'Last',scope:'everyone',csrf})); assert.equal(searched.status,200); assert.match(await searched.text(),/2 public profiles considered/); assert.equal(models,1)
  const toggled=await submit(new URLSearchParams([['query','Last'],['scope','everyone'],['scope','own'],['csrf',csrf]])); assert.equal(toggled.status,200); assert.equal(models,1)
  // An unreadable index is an AI-search notice on the People page, never the upload error page.
  down = true
  const failed = await submit(new URLSearchParams({query:'Last',scope:'everyone',csrf})); assert.equal(failed.status,503)
  const failedHTML = await failed.text(); assert.match(failedHTML,/AI search could not finish/); assert.match(failedHTML,/Results for “Last”/); assert.doesNotMatch(failedHTML,/We could not finish that|return to your files/); assert.equal(models,1)
  const unavailablePage = await request('/people/last',{headers:{Cookie:session}}); assert.equal(unavailablePage.status,503)
  const unavailableHTML = await unavailablePage.text(); assert.match(unavailableHTML,/People are unavailable right now/); assert.match(unavailableHTML,/Back to your people/)
  assert.deepEqual(await (await request('/api/people/last')).json(),{error:'public_people_unavailable'})
  down = false
})

test('anonymous unavailable projection returns503, never empty or owner-private fallback', async t => {
  let handler
  const server = createServer((req,res) => void handler(req,res)); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  handler=createPrivateBrowserHandler({baseUrl:endpoint.replace('http:','https:'), login:{begin:async()=>{},finish:async()=>{}},resolveOwner:async()=>null,getBackend:async()=>{throw Error('private read forbidden')}})
  const response=await fetch(endpoint+'/api/people');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'public_people_unavailable'})
  // Browsers get a page that says what happened; only the API answers in JSON.
  for (const path of ['/people','/people/someone','/network?q=peter']) { const page=await fetch(endpoint+path);assert.equal(page.status,503);assert.match(page.headers.get('content-type'),/text\/html/);const text=await page.text();assert.match(text,/People are unavailable right now/);assert.doesNotMatch(text,/public_people_unavailable/) }
})

test('signed-in network without public provider defaults search to own network', async t => {
  let handler, models = 0
  const owner = { ownerId: 'legacy-owner', userId: 'legacy-user' }
  const importId = '1'.repeat(64), rowId = '2'.repeat(64)
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, status: 'indexed', assertionIds: [rowId], counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    [rowId, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: rowId, ownerId: owner.ownerId, importId, sourceId: importId, rowId: 'Connections.csv#record=2', category: 'connections', subject: 'https://www.linkedin.com/in/legacy-contact', fields: { 'first name': 'Legacy', 'last name': 'Contact', company: 'Archive Co', position: 'Engineer' } } }],
  ])
  const server = createServer((req,res) => void handler(req,res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic', login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'legacy-subject', verifiedEmail: 'legacy@example.invalid', displayName: 'Legacy Person' }),
  }, resolveOwner: async identity => identity.subject === 'legacy-subject' ? owner : null,
  signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'test-grant' }), revokeAccountGrant: async () => {},
  getBackend: async value => { assert.deepEqual(value, owner); return { adapter: {}, listImportIds: async () => [importId], listImportJobIds: async () => [], readResource: async (_type, id) => structuredClone(resources.get(id) ?? null) } },
  complete: async ({ candidateIds }) => { models++; return { matches: [{ id: candidateIds[0], reason: 'Owner network match' }] } },
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const start = await request('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await request('/auth/callback/ideaflow?code=test&state=state',{headers:{Cookie:loginCookie}})
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const people = await request('/network',{headers:{Cookie:session}}); assert.equal(people.status,200)
  const page = await people.text(), csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  assert.match(page, /method="get" action="\/network" role="search"/)
  assert.doesNotMatch(page, /name="scope" value="everyone"|Everyone on Unlinked|Searching everyone on Unlinked did not finish/)
  const searched = await request('/search-account', { method:'POST', headers:{Cookie:session,Origin:baseUrl,'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ query:'Legacy', scope:'everyone', csrf }) })
  assert.equal(searched.status,200); assert.match(await searched.text(),/1 connection searched across your own files/); assert.equal(models,1)
})
