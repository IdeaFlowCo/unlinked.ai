import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../mcp-server/session-store.mjs'
import { createProAccess, createMemoryProLinkedinStore, createProLinkedin } from '../mcp-server/pro-linkedin.mjs'
import { createProLinkedinNotifyHandler, PRO_NOTIFY_PREFIX, linkedinExpandOffer } from '../mcp-server/pro-linkedin-browser.mjs'
import { readRequestBody } from '../mcp-server/request-body.mjs'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'
import { LABELS } from '../deploy/private-pilot/graph-migration.mjs'

// Real browser handler + real notify handler; the provider is an in-memory fake.
const owner = { ownerId: 'owner', userId: 'user' }
// Optional synthetic HTML captures for review (no real profile data): PRO_UI_CAPTURE=<dir>.
const capture = (name, html) => { if (process.env.PRO_UI_CAPTURE) { mkdirSync(process.env.PRO_UI_CAPTURE, { recursive: true }); writeFileSync(`${process.env.PRO_UI_CAPTURE}/${name}.html`, html) } }

async function app(t, { allowed = true, searchEnabled = true } = {}) {
  const accounts = new Map(), links = [], state = { search: [] }
  const client = { configured: true,
    createHostedAuthLink: async input => { links.push(input); return { url: 'https://account.unipile.com/hosted/' + input.name } },
    getAccount: async id => { if (!accounts.has(id)) throw Object.assign(Error('x'), { code: 'not_found' }); return { id, type: 'LINKEDIN', createdAt: Date.now(), statuses: ['OK'] } },
    getOwnProfile: async id => accounts.get(id), deleteAccount: async id => { accounts.delete(id) },
    searchPeople: async (_id, { keywords }) => { if (state.fail) throw Object.assign(Error('x'), state.fail); return { people: state.search.filter(person => person.name.toLowerCase().includes(keywords.toLowerCase())), skipped: 0, total: state.search.length } } }
  const pro = createProLinkedin({ store: createMemoryProLinkedinStore(), client, access: createProAccess({ owners: allowed ? [[owner.ownerId, owner.userId]] : [], enabled: true }), origin: 'https://www.unlinked.ai', searchEnabled })
  let handler
  const notify = createProLinkedinNotifyHandler({ pro, body: readRequestBody })
  const server = createServer((req, res) => req.url.startsWith(PRO_NOTIFY_PREFIX) ? notify(req, res) : handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listAccountGrantIds: async () => [], readLegacyProfile: async () => null }
  handler = createPrivateBrowserHandler({ proLinkedin: pro, baseUrl: endpoint.replace('http:', 'https:'), sessionStore: createMemorySessionStore(), getBackend: async () => backend, resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => 'synthetic', revokeAccountGrant: async () => {},
    login: { begin: async () => ({ location: 'https://identity.invalid/start', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'subject' }) } })
  const start = await fetch(endpoint + '/login', { redirect: 'manual' }), callback = await fetch(endpoint + '/auth/callback/ideaflow?code=synthetic&state=state', { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  const headers = { Cookie: callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0] }
  const get = async path => { const response = await fetch(endpoint + path, { headers, redirect: 'manual' }); return { status: response.status, html: await response.text(), headers: response.headers } }
  const csrfOf = html => html.match(/name="csrf" value="([^"]+)"/)[1]
  const post = async (path, fields) => { const response = await fetch(endpoint + path, { method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Origin: endpoint.replace('http:', 'https:') }, body: new URLSearchParams(fields) }); return { status: response.status, html: await response.text(), location: response.headers.get('location') } }
  const deliver = (token, payload, init = {}) => fetch(endpoint + PRO_NOTIFY_PREFIX + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...init })
  return { endpoint, get, post, csrfOf, deliver, accounts, links, state, pro }
}

test('Pro is invisible to accounts that are not on the allowlist', async t => {
  const site = await app(t, { allowed: false })
  const page = await site.get('/pro'); assert.equal(page.status, 404); assert.doesNotMatch(page.html, /Unipile|LinkedIn search/)
  const home = await site.get('/pro/linkedin/connect'); assert.equal(home.status, 404)
  assert.equal((await fetch(site.endpoint + '/pro', { redirect: 'manual' })).status !== 200, true, 'signed out sees no Pro page')
  assert.equal((await site.deliver('A'.repeat(43), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: 'x' })).status, 404)
})

test('connect, return, server-confirmed callback, search and disconnect through the real routes', async t => {
  const site = await app(t)
  const first = await site.get('/pro'); assert.equal(first.status, 200); capture('pro-not-connected', first.html)
  assert.match(first.html, /<title>Pro · Unlinked<\/title>/); assert.match(first.html, /Connect LinkedIn via Unipile/); assert.match(first.html, /Network sync is <b>not available yet<\/b>/); assert.match(first.html, /never sees or asks for your LinkedIn password/)
  assert.match(first.headers.get('cache-control'), /no-store/); assert.match(first.headers.get('content-security-policy'), /form-action 'self'/)
  const csrf = site.csrfOf(first.html)
  await assert.rejects(async () => { const bad = await site.post('/pro/linkedin/connect', { csrf: 'wrong', consent: 'on' }); assert.ok(bad.status >= 400); throw Error('rejected') }, /rejected/)
  assert.equal(site.links.length, 0, 'a forged form never reaches the provider')
  assert.equal((await site.post('/pro/linkedin/connect', { csrf })).status, 400, 'explicit consent is required')
  const cont = await site.post('/pro/linkedin/connect', { csrf, consent: 'on' }); assert.equal(cont.status, 200); capture('pro-continue', cont.html)
  assert.match(cont.html, /<title>Continue to LinkedIn sign-in · Unlinked<\/title>/); assert.match(cont.html, /href="https:\/\/account\.unipile\.com\/hosted\/[A-Za-z0-9_-]+" rel="noreferrer"/)
  const token = new URL(site.links[0].notifyUrl).pathname.split('/').pop(), name = site.links[0].name
  assert.ok(!cont.html.includes(token), 'the notify token is never shown to the browser')
  // Coming back from the provider page proves nothing.
  const returned = await site.get('/pro?linkedin=returned'); capture('pro-waiting', returned.html)
  assert.match(returned.html, /Waiting for LinkedIn sign-in to be confirmed/); assert.doesNotMatch(returned.html, /pro-state ok/)
  // The provider's callback: wrong method, wrong type, forged token, then the real one, then a replay.
  site.accounts.set('AcctJacob0001', { providerId: 'li-1', name: 'Jacob Example', publicIdentifier: 'jacob-example' })
  const payload = { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name }
  assert.equal((await fetch(site.endpoint + PRO_NOTIFY_PREFIX + token)).status, 405)
  assert.equal((await site.deliver(token, payload, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await site.deliver(token, payload, { body: '{' })).status, 400)
  assert.equal((await site.deliver(token.slice(0, 42) + (token.endsWith('A') ? 'B' : 'A'), payload)).status, 404)
  assert.equal((await site.deliver(token, { ...payload, account_id: 'OtherAccount01' })).status, 204, 'accepted for processing, but an unknown account binds nothing')
  assert.match((await site.get('/pro')).html, /The provider could not confirm the account/)
  // A fresh attempt completes.
  await site.post('/pro/linkedin/connect', { csrf, consent: 'on' })
  const live = new URL(site.links[1].notifyUrl).pathname.split('/').pop(), good = { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: site.links[1].name }
  const accepted = await site.deliver(live, good); assert.equal(accepted.status, 204); assert.equal(await accepted.text(), '')
  assert.equal((await site.deliver(live, good)).status, 404, 'replay')
  assert.equal((await site.deliver(token, payload)).status, 404, 'the superseded first link is dead')
  const connected = await site.get('/pro'); capture('pro-connected', connected.html)
  assert.match(connected.html, /<b>Jacob Example<\/b><span class="pro-state ok">Connected<\/span>/); assert.match(connected.html, /linkedin\.com\/in\/jacob-example/); assert.match(connected.html, /<dt>Network sync<\/dt><dd>Not available yet<\/dd>/)
  assert.ok(!connected.html.includes('AcctJacob0001'), 'no provider account id in the page')
  assert.equal((await site.post('/pro/linkedin/connect', { csrf, consent: 'on' })).status, 409)
  // Explicit search: zero results, results, and failures are three different pages.
  const none = await site.post('/pro/linkedin/search', { csrf, q: 'nobody' }); assert.equal(none.status, 200); assert.match(none.html, /LinkedIn search ran and found no people/); capture('pro-search-none', none.html)
  site.state.search = [{ publicIdentifier: 'ada-example', name: 'Ada <Example>', headline: 'Founder', networkDistance: 2, linkedinUrl: 'https://www.linkedin.com/in/ada-example', source: 'linkedin_search' }]
  const found = await site.post('/pro/linkedin/search', { csrf, q: 'ada' }); capture('pro-search-results', found.html)
  assert.match(found.html, /<title>“ada” · LinkedIn search · Unlinked<\/title>/); assert.match(found.html, /Ada &lt;Example&gt;<span class="pro-tag">LinkedIn · not yet on Unlinked<\/span>/); assert.match(found.html, /LinkedIn 2nd-degree/); assert.match(found.html, /private preview\. It is not saved, published/)
  site.state.fail = { code: 'rate_limited', retryAfter: 300 }
  const limited = await site.post('/pro/linkedin/search', { csrf, q: 'ada' }); assert.equal(limited.status, 429); assert.match(limited.html, /LinkedIn search did not run/); assert.match(limited.html, /not a “no results” answer/); assert.doesNotMatch(limited.html, /found no people/); capture('pro-search-failed', limited.html)
  site.state.fail = { code: 'reconnect_required' }
  const stale = await site.post('/pro/linkedin/search', { csrf, q: 'ada' }); assert.equal(stale.status, 409); assert.match(stale.html, /Open Pro to reconnect/)
  site.state.fail = null
  const needs = await site.get('/pro'); assert.match(needs.html, /Needs reconnect/); assert.match(needs.html, /action="\/pro\/linkedin\/reconnect"/); capture('pro-reconnect', needs.html)
  assert.equal((await fetch(site.endpoint + '/pro/linkedin/search?q=ada', { headers: { Cookie: 'x=1' } })).status !== 200, true, 'search is never a GET')
  const gone = await site.post('/pro/linkedin/disconnect', { csrf }); assert.equal(gone.status, 303); assert.equal(gone.location, '/pro?done=disconnected'); assert.equal(site.accounts.size, 0)
  assert.match((await site.get('/pro?done=disconnected')).html, /LinkedIn disconnected\./)
})

test('the People page offers LinkedIn search only to a connected Pro owner, only as an explicit button', async t => {
  const site = await app(t), session = { owner, csrf: 'csrf-token' }
  const { createProLinkedinBrowser } = await import('../mcp-server/pro-linkedin-browser.mjs')
  const offer = (pro = site.pro) => createProLinkedinBrowser({ pro, body: readRequestBody }).offer(session, ' ada ')
  assert.equal(await offer(), '', 'not connected: no offer')
  await site.pro.begin(owner); site.accounts.set('AcctJacob0001', { providerId: 'li-1', name: 'Jacob Example' })
  await site.pro.notify(new URL(site.links[0].notifyUrl).pathname.split('/').pop(), { status: 'CREATION_SUCCESS', account_id: 'AcctJacob0001', name: site.links[0].name })
  const html = await offer(); assert.match(html, /<form class="linkedin-expand" method="post" action="\/pro\/linkedin\/search">/); assert.match(html, /name="q" value="ada"/); assert.match(html, /only when you press this/)
  assert.equal(await createProLinkedinBrowser({ pro: site.pro, body: readRequestBody }).offer({ owner: { ownerId: 'other', userId: 'other' }, csrf: 'x' }, 'ada'), '')
  assert.equal(await createProLinkedinBrowser({ pro: site.pro, body: readRequestBody }).offer(session, '  '), '')
  assert.equal(await createProLinkedinBrowser({ pro: (await app(t, { searchEnabled: false })).pro, body: readRequestBody }).offer(session, 'ada'), '')
  // The view shows it only under a finished search with no results, never on failure.
  const expand = linkedinExpandOffer({ csrf: 'csrf-token', query: '"><script>' }); assert.ok(!expand.includes('<script>'))
  const base = { csrf: 'csrf-token', query: 'ada', everyone: [], own: [], scope: 'everyone', linkedinExpand: html }
  assert.match(renderPeople({ ...base, state: 'ready' }).content, /No one on Unlinked matched that yet\.<\/p>.*class="linkedin-expand"/s)
  assert.doesNotMatch(renderPeople({ ...base, state: 'unavailable' }).content, /class="linkedin-expand"/, 'a failed local search is not a no-match')
  assert.doesNotMatch(renderPeople({ ...base, state: 'ready', everyone: [{ id: 'p', name: 'Ada Example' }] }).content, /class="linkedin-expand"/)
  assert.doesNotMatch(renderPeople({ ...base, state: 'ready', linkedinExpand: undefined }).content, /linkedin-expand/)
})

test('the new graph labels are inside the recovery and validation domain', () => {
  assert.ok(LABELS.includes('UnlinkedProSource')); assert.ok(LABELS.includes('UnlinkedProAuthAttempt'))
})
