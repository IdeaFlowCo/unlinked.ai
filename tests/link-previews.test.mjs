// Titles and link previews (docs/link-previews.md). All people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createLinkPreviewAdmission, linkUnfurler, personPreview, previewDocument, previewMeta, SITE_PREVIEW } from '../mcp-server/link-preview.mjs'
import { renderPeople } from '../mcp-server/private-onboarding-views.mjs'

const ORIGIN = 'https://unlinked.test'
const meta = (page, name) => page.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)">`))?.[1] ?? null
const ua = agent => ({ headers: { 'user-agent': agent } })
const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'
const CRAWLERS = ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'Slackbot 1.0 (+https://api.slack.com/robots)']
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'

test('the neutral site preview is the default, and nothing external or unescaped gets in', () => {
  const neutral = previewMeta(undefined, ORIGIN)
  assert.equal(meta(neutral, 'og:title'), SITE_PREVIEW.title)
  assert.equal(meta(neutral, 'og:image'), `${ORIGIN}/app-icon-512.png`)
  assert.equal(meta(neutral, 'twitter:card'), 'summary')
  assert.equal(meta(neutral, 'og:url'), null, 'a neutral preview names no address')
  const hostile = previewMeta({ title: 'A "quoted" <b>name</b>', description: 'x'.repeat(400), image: 'https://evil.example/x.png', url: '//evil.example/' }, ORIGIN)
  assert.equal(meta(hostile, 'og:title'), 'A &quot;quoted&quot; &lt;b&gt;name&lt;/b&gt;')
  assert.equal(meta(hostile, 'og:image'), `${ORIGIN}/app-icon-512.png`, 'external images fall back to the site image')
  assert.equal(meta(hostile, 'og:url'), null)
  assert.ok([...meta(hostile, 'og:description')].length <= 300)
})

test('a person preview uses only the public profile fields', () => {
  const photo = '/people/0f8845b4-7def-487a-a404-c67e6aa811b8/photo?v=0123456789abcdef'
  const preview = personPreview({ id: 'x', name: 'Ada Fictional', headline: 'Engineer at Example', location: 'London', photo, email: 'ada@example.invalid', notes: 'private note' }, '/people/ada-fictional')
  assert.deepEqual(preview, { type: 'profile', title: 'Ada Fictional', description: 'Engineer at Example · London', image: photo, url: '/people/ada-fictional' })
  assert.equal(personPreview({ name: 'Sam Fictional', positions: [{ title: 'Founder', company: 'Fictional Co' }] }, '/people/sam').description, 'Founder at Fictional Co')
  assert.equal(personPreview({ name: 'No Photo', photo: 'https://elsewhere.example/p.png' }, '/people/n').image, null)
  assert.equal(personPreview({ name: '' }, '/people/n'), null)
  const page = previewDocument(preview, ORIGIN)
  assert.match(page, /<title>Ada Fictional · Unlinked<\/title>/)
  assert.equal(meta(page, 'og:url'), `${ORIGIN}/people/ada-fictional`)
  assert.equal(meta(page, 'og:image'), `${ORIGIN}${photo}`.replace(/&/g, '&amp;'))
  assert.doesNotMatch(page, /ada@example|private note/)
})

test('only known link unfurlers are recognised; SEO and AI crawlers are not', () => {
  for (const agent of [IMESSAGE, 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'Twitterbot/1.0', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'WhatsApp/2.23.20.0', 'TelegramBot (like TwitterBot)']) assert.equal(linkUnfurler({ headers: { 'user-agent': agent } }), true, agent)
  for (const agent of [...CRAWLERS, BROWSER, '', undefined]) assert.equal(linkUnfurler({ headers: { 'user-agent': agent } }), false, String(agent))
})

test('the unfurl lane is bounded per visitor, overall and in flight, and never queues', () => {
  let time = 0
  const events = []
  const lane = createLinkPreviewAdmission({ now: () => time, perMinute: 5, visitorPerMinute: 2, inFlight: 1, record: event => events.push(event.reason) })
  const first = lane.acquire({ visitor: 'a' })
  assert.equal(first.reason, 'admitted')
  assert.equal(lane.acquire({ visitor: 'b' }).reason, 'capacity', 'one read at a time')
  first.release(); first.release()
  lane.acquire({ visitor: 'a' }).release()
  assert.equal(lane.acquire({ visitor: 'a' }).reason, 'minute', 'per-visitor budget')
  for (const visitor of ['b', 'c', 'd']) lane.acquire({ visitor }).release()
  assert.equal(lane.acquire({ visitor: 'e' }).reason, 'minute', 'overall budget')
  time = 60000
  assert.equal(lane.acquire({ visitor: 'a' }).reason, 'admitted', 'budgets renew each minute')
  assert.deepEqual(events.slice(0, 4), ['admitted', 'capacity', 'admitted', 'minute'])
})

test('a search tab names the query', () => {
  assert.equal(renderPeople({ query: 'founders', state: 'ready' }).title, '“founders” · People')
  assert.equal(renderPeople({ state: 'ready' }).title, 'People')
})

const PERSON = '0f8845b4-7def-487a-a404-c67e6aa811b8'
const snapshot = { state: 'published', complete: true, revision: 'previews-1', connections: [], profiles: [{ id: PERSON, name: 'Ada Fictional', headline: 'Engineer at Example', location: 'London', positions: [], education: [], skills: [] }] }

async function runtime(t, recordPublicAdmission) {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const baseUrl = origin.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, readPublishedSnapshot: async () => snapshot, recordPublicAdmission,
    login: { begin: async () => ({ location: 'https://id.example.invalid/authorize', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: 'test' }) },
    resolveOwner: async () => ({ ownerId: 'viewer-owner', userId: 'viewer-user' }), getBackend: async () => { throw Error('unexpected private read') },
  })
  // Through a Cloudflare edge; visitors carry their own address when given.
  return Object.assign((path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options, headers: { 'x-forwarded-for': '172.70.1.2', ...options.headers } }), { base: baseUrl })
}

test('public pages preview as themselves; missing and error pages stay neutral', async t => {
  const request = await runtime(t)
  const profile = await request(`/people/${PERSON}`, ua(BROWSER))
  assert.equal(profile.status, 200)
  const page = await profile.text()
  assert.match(page, /<title>Ada Fictional · Unlinked<\/title>/)
  assert.equal(meta(page, 'og:title'), 'Ada Fictional')
  assert.equal(meta(page, 'og:description'), 'Engineer at Example · London')
  assert.equal(meta(page, 'og:type'), 'profile')
  assert.equal(meta(page, 'og:url'), `${request.base}/people/${PERSON}`)
  const home = await (await request('/', ua(BROWSER))).text()
  assert.equal(meta(home, 'og:title'), 'Unlinked: your professional profile and network')
  const agents = await (await request('/agents', ua(BROWSER))).text()
  assert.equal(meta(agents, 'og:title'), 'Unlinked for AI agents')
  assert.equal(meta(agents, 'og:url'), `${request.base}/agents`)
  const missing = await request('/people/missing', ua(BROWSER))
  assert.equal(missing.status, 404)
  const missingPage = await missing.text()
  assert.equal(meta(missingPage, 'og:title'), SITE_PREVIEW.title)
  assert.equal(meta(missingPage, 'og:url'), null)
  const signIn = await (await request('/settings', ua(BROWSER))).text()
  assert.equal(meta(signIn, 'og:title'), SITE_PREVIEW.title, 'member pages read without a session preview neutrally')
})

test('link unfurlers preview a profile while crawlers hold the shared fuse; crawlers stay on it', async t => {
  const admissions = []
  const request = await runtime(t, event => admissions.push(event))
  for (let i = 0; i < 120; i++) { const response = await request('/api/people'); assert.equal(response.status, 200); await response.text() }
  for (const agent of CRAWLERS) {
    const crawler = await request(`/people/${PERSON}`, { headers: { 'user-agent': agent, 'cf-connecting-ip': '198.51.100.8' } })
    assert.equal(crawler.status, 429, agent)
    await crawler.text()
  }
  const unfurl = await request(`/people/${PERSON}?via=card`, { headers: { 'user-agent': IMESSAGE, 'cf-connecting-ip': '198.51.100.9' } })
  assert.equal(unfurl.status, 200)
  assert.equal(unfurl.headers.get('cache-control'), 'no-store')
  assert.match(unfurl.headers.get('vary'), /User-Agent/)
  const page = await unfurl.text()
  assert.equal(meta(page, 'og:title'), 'Ada Fictional')
  assert.equal(meta(page, 'og:description'), 'Engineer at Example · London')
  assert.doesNotMatch(page, /<script/, 'the unfurl page is meta only')
  assert.deepEqual(admissions.at(-1), { lane: 'preview', route: 'profile', reason: 'admitted' })
  const head = await request(`/people/${PERSON}`, { method: 'HEAD', headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'cf-connecting-ip': '198.51.100.10' } })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const unknown = await request('/people/nobody-here', { headers: { 'user-agent': 'Twitterbot/1.0', 'cf-connecting-ip': '198.51.100.11' } })
  assert.equal(unknown.status, 404)
  assert.equal(meta(await unknown.text(), 'og:title'), SITE_PREVIEW.title)
  // Connections pages are not on the lane.
  const connections = await request(`/people/${PERSON}/connections`, { headers: { 'user-agent': IMESSAGE, 'cf-connecting-ip': '198.51.100.12' } })
  assert.equal(connections.status, 429)
  await connections.text()
  // One visitor past its unfurl budget is back on the drained shared fuse.
  let last
  for (let i = 0; i < 10; i++) { last = await request(`/people/${PERSON}`, { headers: { 'user-agent': IMESSAGE, 'cf-connecting-ip': '198.51.100.13' } }); await last.text() }
  assert.equal(last.status, 200)
  const over = await request(`/people/${PERSON}`, { headers: { 'user-agent': IMESSAGE, 'cf-connecting-ip': '198.51.100.13' } })
  assert.equal(over.status, 429)
  await over.text()
  assert.deepEqual(admissions.slice(-2), [{ lane: 'preview', route: 'profile', reason: 'minute' }, { lane: 'anonymous', route: 'profile', reason: 'minute' }])
})
