// unlinked-qthj (Jacob, 2026-10-24): on a profile the connections count is a
// link to the connections card, a signed-in viewer sees who they both know up
// top, and the stray "Search everyone" button is gone (the header search is on
// every page). In the iOS app the count is of members only and says so, and
// the mutual line names members only. All people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPerson, mutualLine } from '../mcp-server/private-onboarding-views.mjs'
import { PROFILE_CONNECTIONS_SCRIPT } from '../mcp-server/network-filter-script.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 UnlinkediOS/1.0.0'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const base = { id: 'p1', name: 'Peter Example', location: 'Toronto, Canada', industry: 'Investment Banking', connectionCount: 2004, positions: [], education: [], skills: [], connections: [person('c1', 'Ada Lee')] }
const signedIn = { csrf: 'c'.repeat(43), accountLabel: 'Me', displayName: 'Me' }

test('the connections count links to the connections card; the app counts members only and says so', () => {
  const page = renderPerson({ profile: base }).content
  assert.match(page, /<span class="small">Toronto, Canada · Investment Banking · <a class="pcount" href="#connections">2,004 connections<\/a><\/span>/)
  assert.match(page, /<div class="card sec pconn" id="connections"/)
  assert.match(renderPerson({ profile: { ...base, connectionCount: 1 }, membersOnly: true }).content, /<a class="pcount" href="#connections">1 connection on Unlinked<\/a>/)
  assert.doesNotMatch(page, /on Unlinked<\/a>/)
  // Location text is still escaped around the link.
  assert.match(renderPerson({ profile: { ...base, location: 'A <b>&</b> B' } }).content, /A &lt;b&gt;&amp;&lt;\/b&gt; B · Investment Banking · <a class="pcount"/)
})

test('no profile has a Search everyone button any more; the header search is on every page', () => {
  for (const view of [renderPerson({ profile: base }), renderPerson({ ...signedIn, profile: base, connect: { state: 'none' } }), renderPerson({ ...signedIn, profile: { ...base, presence: 'member' }, connect: { state: 'self' } })]) {
    assert.doesNotMatch(view.content, />Search everyone</)
    assert.match(view.content, /<form class="header-search" method="get" action="\/network" role="search">/)
  }
})

test('the mutual line names up to two people, counts the rest and links to You both know', () => {
  const people = n => Array.from({ length: n }, (_, i) => person(`m${i}`, ['Ada Lee', 'Bo Chen', 'Cy Park'][i]))
  const line = (total, n) => mutualLine({ id: 'p1', mutual: { total, preview: people(n) } })
  assert.match(line(1, 1), /^<a class="mutuals" data-connections-link href="\/people\/p1\?show=known#connections"><span class="mfaces" aria-hidden="true"><span class="initials avatar tone-\d+" aria-hidden="true">AL<\/span><\/span><span class="mutuals-text">Ada Lee is a mutual connection<\/span><\/a>$/)
  assert.match(line(2, 2), /Ada Lee and Bo Chen are mutual connections</)
  assert.match(line(3, 3), /Ada Lee, Bo Chen and 1 other mutual connection</)
  assert.match(line(14, 3), /Ada Lee, Bo Chen and 12 other mutual connections</)
  assert.equal((line(14, 3).match(/class="initials avatar/g) ?? []).length, 3)
  assert.match(line(5, 0), /<span class="mfaces" aria-hidden="true"><\/span><span class="mutuals-text">5 mutual connections</)
  assert.equal(line(0, 0), ''); assert.equal(mutualLine({ id: 'p1' }), ''); assert.equal(mutualLine({ id: '', mutual: { total: 2, preview: people(2) } }), '')
  assert.match(mutualLine({ id: 'p1', mutual: { total: 1, preview: [person('x', '<Ada>')] } }), /&lt;Ada&gt; is a mutual connection/)
})

test('the profile shows the mutual line to a signed-in viewer of someone else, never signed out or on your own profile', () => {
  const mutual = { total: 14, preview: [person('m0', 'Ada Lee'), person('m1', 'Bo Chen'), person('m2', 'Cy Park')] }
  const page = renderPerson({ ...signedIn, profile: { ...base, presence: 'member', mutual }, connect: { state: 'none' } }).content
  assert.match(page, /2,004 connections<\/a><\/span><a class="mutuals" data-connections-link href="\/people\/p1\?show=known#connections"><span class="mfaces" aria-hidden="true">(?:<span class="initials avatar tone-\d+" aria-hidden="true">\w\w<\/span>){3}<\/span><span class="mutuals-text">Ada Lee, Bo Chen and 12 other mutual connections<\/span><\/a>/)
  assert.ok(page.indexOf('class="mutuals"') < page.indexOf('<div class="actions">'), 'the line sits in the header, above the actions')
  assert.doesNotMatch(renderPerson({ profile: { ...base, mutual } }).content, /class="mutuals"/)
  assert.doesNotMatch(renderPerson({ ...signedIn, profile: { ...base, presence: 'member', mutual }, connect: { state: 'self' } }).content, /class="mutuals"/)
  assert.doesNotMatch(renderPerson({ ...signedIn, profile: { ...base, mutual: { total: 0, preview: [] } }, connect: { state: 'none' } }).content, /class="mutuals"/)
  assert.doesNotMatch(renderPerson({ ...signedIn, profile: base, connect: { state: 'none' } }).content, /class="mutuals"/)
  // The sidebar script also takes the header link and reveals the card.
  assert.match(PROFILE_CONNECTIONS_SCRIPT, /a\[data-connections-link\]/); assert.match(PROFILE_CONNECTIONS_SCRIPT, /scrollIntoView/)
})

test('the reader answers who they both know for a viewer\'s set, members first, only with that set', async () => {
  const snapshot = { state: 'published', complete: true, revision: 'mutual-v1', members: ['owner', 'zed', 'peter'],
    profiles: [person('owner', 'Owner'), person('peter', 'Peter Example'), person('ann', 'Ann Imported'), person('bob', 'Bob Imported'), person('zed', 'Zed Member'), person('out', 'Outside')],
    connections: [{ fromId: 'peter', toId: 'ann' }, { fromId: 'peter', toId: 'bob' }, { fromId: 'peter', toId: 'zed' }, { fromId: 'peter', toId: 'owner' }, { fromId: 'out', toId: 'ann' }] }
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot, pageSize: 1 })
  const plain = await reader.profile({ id: 'peter' })
  assert.equal('mutual' in plain.profile, false)
  const known = new Set(['ann', 'bob', 'zed', 'out'])
  const { profile } = await reader.profile({ id: 'peter', known })
  assert.deepEqual(profile.mutual, { total: 3, preview: [{ id: 'zed', name: 'Zed Member', presence: 'member', connectionCount: 1, detailLevel: 'basic' }, { id: 'ann', name: 'Ann Imported', presence: 'shadow', connectionCount: 2, detailLevel: 'basic' }, { id: 'bob', name: 'Bob Imported', presence: 'shadow', connectionCount: 1, detailLevel: 'basic' }] })
  // The whole set counts even while the sidebar is searched or paged; a bigger set previews three.
  assert.equal((await reader.profile({ id: 'peter', known, query: 'zed' })).profile.mutual.total, 3)
  assert.equal((await reader.profile({ id: 'peter', known: new Set(['ann', 'bob', 'zed', 'owner']) })).profile.mutual.preview.length, 3)
  assert.equal((await reader.profile({ id: 'peter', known: new Set(['nobody']) })).profile.mutual.total, 0)
  assert.equal((await reader.profile({ id: 'peter', known: new Set(['out']) })).profile.mutual.total, 0, 'only this person’s own connections count')
})

// A signed-in member viewing someone else over HTTP: their own import decides
// the mutual line; in the app it names members only and the count says so.
async function site(t) {
  const snapshot = { state: 'published', complete: true, revision: 'mutual-http-v1',
    profiles: [person('owner', 'Jordan Rivera'), person('casey', 'Casey Demo', { headline: 'Founder' }), person('avery', 'Avery Lee'), person('morgan', 'Morgan Singh', { linkedinUrl: 'https://www.linkedin.com/in/morgan-singh' }), person('sasha', 'Sasha Baptiste')],
    members: ['owner', 'casey', 'avery'],
    connections: [{ fromId: 'owner', toId: 'avery' }, { fromId: 'casey', toId: 'avery' }, { fromId: 'casey', toId: 'morgan' }, { fromId: 'casey', toId: 'sasha' }, { fromId: 'casey', toId: 'owner' }] }
  const owner = { ownerId: 'mutual-owner', userId: 'mutual-user' }
  const importId = 'a'.repeat(64), morganRow = 'b'.repeat(64)
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: Date.UTC(2026, 0, 5), status: 'indexed', assertionIds: [morganRow], counts: { accepted: 1, indexed: 1, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    [morganRow, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: morganRow, ownerId: owner.ownerId, importId, category: 'connections', fields: { 'first name': 'Morgan', 'last name': 'Singh', position: 'Engineer', company: 'Northwind Solar', url: 'https://www.linkedin.com/in/morgan-singh' } } }],
  ])
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const read = async () => snapshot
  read.revisionIdentifiesContent = true
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live',
    login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test' }) },
    resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    readPublishedSnapshot: read, ownProfileId: async () => 'owner',
    selfClaims: { lookupSlug: async slug => ({ 'morgan-singh': 'morgan' })[slug] ?? null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [importId], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readResource: async (_, id) => structuredClone(resources.get(id) ?? null) }) })
  const go = (path, { agent = SAFARI, cookie } = {}) => fetch(endpoint + path, { redirect: 'manual', headers: { 'User-Agent': agent, ...(cookie ? { Cookie: cookie } : {}) } })
  const signIn = async () => {
    const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
    const callback = await go('/auth/callback/ideaflow?state=test&code=test', { cookie: loginCookie })
    return callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  }
  return { go, signIn }
}
const header = page => page.match(/<div class="card phead">([\s\S]*?)<div class="actions">/)?.[1] ?? ''

test('over HTTP the mutual line comes from the viewer’s own people; the app names members only and labels its count', async t => {
  const app = await site(t)
  const anonymous = await (await app.go('/people/casey')).text()
  assert.match(header(anonymous), /<a class="pcount" href="#connections">4 connections<\/a>/)
  // (The hover-card script mentions mutual connections on every page; the header is what matters.)
  assert.doesNotMatch(anonymous, /class="mutuals"/); assert.doesNotMatch(header(anonymous), /mutual connection/)
  const cookie = await app.signIn()
  // Jordan knows Avery (a member connection) and Morgan (from Jordan's own import).
  // `show=known` waits for that set; later pages have it cached.
  const known = await (await app.go('/people/casey?show=known', { cookie })).text()
  assert.match(header(known), /<a class="mutuals" data-connections-link href="\/people\/casey\?show=known#connections">.*Avery Lee and Morgan Singh are mutual connections</s)
  const page = await (await app.go('/people/casey', { cookie })).text()
  assert.match(header(page), /Avery Lee and Morgan Singh are mutual connections/)
  assert.match(header(page), /<a class="pcount" href="#connections">4 connections<\/a>/)
  assert.doesNotMatch(header(page), /on Unlinked<\/a>/)
  assert.doesNotMatch(page, />Search everyone</)
  // In the app: Casey's member connections only, counted as such; Morgan (imported) is not named anywhere.
  await app.go('/people/casey?show=known', { cookie, agent: IOS })
  const ios = await (await app.go('/people/casey', { cookie, agent: IOS })).text()
  assert.match(header(ios), /<a class="pcount" href="#connections">2 connections on Unlinked<\/a>/)
  assert.match(header(ios), /Avery Lee is a mutual connection/)
  assert.doesNotMatch(ios, /Morgan Singh|Sasha Baptiste/)
})
