// unlinked-ac9.3 (App Store guideline 5.1.1(viii)): the Unlinked iOS app
// (user agent `UnlinkediOS/`) lists only people who joined Unlinked. Imported
// "Not on Unlinked" profiles stay out of its search, browse, company lists,
// suggestions, hover cards and profiles; a signed-in member still sees their
// own imported people. The website is unchanged. All people are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { membersOnlySnapshot, createMembersOnlySnapshotReader, iosAppUserAgent } from '../src/utils/public-people/members-only.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 UnlinkediOS/1.0.0'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = {
  state: 'published', complete: true, revision: 'ios-directory-test',
  profiles: [
    profile('owner', 'Jordan Rivera', { headline: 'Partnerships at Meridian Grid' }),
    profile('avery', 'Avery Lee', { headline: 'Founder at Northwind Solar', positions: [{ title: 'Founder', company: 'Northwind Solar' }] }),
    profile('morgan', 'Morgan Singh', { headline: 'Engineer at Northwind Solar', positions: [{ title: 'Engineer', company: 'Northwind Solar' }], linkedinUrl: 'https://www.linkedin.com/in/morgan-singh' }),
    profile('sasha', 'Sasha Baptiste', { headline: 'Counsel at Northwind Solar', positions: [{ title: 'Counsel', company: 'Northwind Solar' }] }),
    profile('lena', 'Lena Ito', { headline: 'Former member' }),
  ],
  // Jordan and Avery joined; Morgan and Sasha were imported; Lena is a recovered legacy account.
  members: ['owner', 'avery'], legacyMembers: ['lena'],
  connections: [{ fromId: 'owner', toId: 'avery' }, { fromId: 'owner', toId: 'morgan' }, { fromId: 'avery', toId: 'sasha' }, { fromId: 'avery', toId: 'lena' }],
  aliases: { 'avery-old': 'avery', 'morgan-old': 'morgan' },
}

async function site(t) {
  const owner = { ownerId: 'ios-owner', userId: 'ios-user' }
  const importId = 'a'.repeat(64), morganRow = 'b'.repeat(64), privateRow = 'c'.repeat(64)
  const row = (id, fields) => [id, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id, ownerId: owner.ownerId, importId, category: 'connections', fields } }]
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: Date.UTC(2026, 0, 5), status: 'indexed', assertionIds: [morganRow, privateRow], counts: { accepted: 2, indexed: 2, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    // Jordan's own import lists Morgan (also published as an imported profile) and Kai (private only).
    row(morganRow, { 'first name': 'Morgan', 'last name': 'Singh', position: 'Engineer', company: 'Northwind Solar', url: 'https://www.linkedin.com/in/morgan-singh' }),
    row(privateRow, { 'first name': 'Kai', 'last name': 'Moreau', position: 'Analyst', company: 'Fieldstone', url: 'https://www.linkedin.com/in/kai-moreau' }),
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
  return { go, signIn, morganRow, privateRow }
}
const names = page => [...new Set([...page.matchAll(/(Jordan Rivera|Avery Lee|Morgan Singh|Sasha Baptiste|Lena Ito|Kai Moreau)/g)].map(match => match[1]))].sort()
const main = page => page.match(/<main class="journey">([\s\S]*)<\/main>/)?.[1] ?? page
const section = (page, label) => page.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? ''

test('the app user agent is recognized exactly, and the members-only index keeps members, their edges and their aliases', async () => {
  assert.equal(iosAppUserAgent(IOS), true)
  for (const agent of [SAFARI, 'UnlinkediOS', 'UnlinkediOS/', 'unlinkedios/1.0', 'FooUnlinkediOS/1.0', undefined, 'x'.repeat(2000) + 'UnlinkediOS/1']) assert.equal(iosAppUserAgent(agent), false, String(agent).slice(0, 40))
  const only = membersOnlySnapshot(snapshot)
  assert.deepEqual(only.profiles.map(value => value.id), ['owner', 'avery'])
  assert.deepEqual(only.connections, [{ fromId: 'owner', toId: 'avery' }])
  assert.deepEqual(only.members, ['avery', 'owner']); assert.deepEqual(only.legacyMembers, [])
  assert.deepEqual(only.aliases, { 'avery-old': 'avery' })
  assert.notEqual(only.revision, snapshot.revision); assert.ok(only.revision.length <= 128)
  // Without a member list nobody is a member.
  assert.deepEqual(membersOnlySnapshot({ ...snapshot, members: undefined }).profiles, [])
  // The reader wrapper keeps the source's content-identity flag and reuses its last result.
  let reads = 0
  const source = async () => { reads++; return snapshot }
  source.revisionIdentifiesContent = true
  const filtered = createMembersOnlySnapshotReader(source)
  assert.equal(filtered.revisionIdentifiesContent, true)
  assert.equal(await filtered(), await filtered()); assert.equal(reads, 2)
  // The whole and members-only indexes never share a compiled index or cursor.
  const whole = createPublicPeopleReader({ readPublishedSnapshot: source }), members = createPublicPeopleReader({ readPublishedSnapshot: filtered })
  assert.equal((await whole.list({ includeTotal: true })).total, 5)
  assert.equal((await members.list({ includeTotal: true })).total, 2)
  assert.equal((await whole.list({ includeTotal: true })).total, 5)
})

test('signed out, the app lists only members in browse, search, the JSON list, suggestions and company pages; the website is unchanged', async t => {
  const app = await site(t)
  for (const path of ['/people', '/people?q=northwind', '/network']) {
    const ios = await (await app.go(path, { agent: IOS })).text(), web = await (await app.go(path)).text()
    assert.deepEqual(names(main(ios)).filter(name => name !== 'Jordan Rivera'), path.includes('northwind') ? ['Avery Lee'] : ['Avery Lee'], path)
    assert.ok(names(main(web)).includes('Morgan Singh') && names(main(web)).includes('Sasha Baptiste'), path)
    // No membership filter in the app: everyone listed is a member.
    assert.doesNotMatch(ios, /aria-label="Membership status"/)
    assert.match(web, /aria-label="Membership status"/)
  }
  const api = await (await app.go('/api/people?q=northwind', { agent: IOS })).json()
  assert.deepEqual(api.profiles.map(value => value.id), ['avery'])
  assert.deepEqual((await (await app.go('/api/people?q=northwind')).json()).profiles.map(value => value.id).sort(), ['avery', 'morgan', 'sasha'])
  // A filter for imported people finds nobody in the app.
  assert.deepEqual((await (await app.go('/api/people?presence=shadow', { agent: IOS })).json()).profiles, [])
  assert.deepEqual((await (await app.go('/search-suggestions?q=mor', { agent: IOS })).json()).people, [])
  assert.deepEqual((await (await app.go('/search-suggestions?q=mor')).json()).people.map(value => value.id), ['morgan'])
  assert.deepEqual((await (await app.go('/search-suggestions?q=ave', { agent: IOS })).json()).people.map(value => value.id), ['avery'])
  const company = await (await app.go('/companies/Northwind%20Solar', { agent: IOS })).text()
  assert.deepEqual(names(main(company)), ['Avery Lee'])
  assert.deepEqual(names(main(await (await app.go('/companies/Northwind%20Solar')).text())), ['Avery Lee', 'Morgan Singh', 'Sasha Baptiste'])
  const companyApi = await (await app.go('/api/companies/Northwind%20Solar', { agent: IOS })).json()
  assert.equal(companyApi.company.total, 1)
})

test('in the app, imported profiles have no page or hover card, and a member profile lists only member connections', async t => {
  const app = await site(t)
  for (const id of ['morgan', 'sasha', 'lena']) {
    const page = await app.go(`/people/${id}`, { agent: IOS })
    assert.equal(page.status, 404, id)
    assert.match(await page.text(), /<h1 class="hq">Profile not available<\/h1>/)
    assert.equal((await app.go(`/api/people/${id}`, { agent: IOS })).status, 404)
    assert.equal((await app.go(`/api/people/${id}/card`, { agent: IOS })).status, 404)
    // The website still shows it, with a way to request its removal.
    const web = await app.go(`/people/${id}`)
    assert.equal(web.status, 200)
    assert.match(await web.text(), new RegExp(`href="/people/${id}/removal">Request removal</a>`))
  }
  // A merged address of an imported profile does not resolve in the app; a member's still does.
  assert.equal((await app.go('/people/morgan-old', { agent: IOS })).status, 404)
  assert.equal((await app.go('/people/avery-old', { agent: IOS })).status, 301)
  const avery = await (await app.go('/people/avery', { agent: IOS })).text()
  assert.deepEqual(names(avery.match(/data-profile-connections>([\s\S]*?)<\/div><\/aside>/)?.[1] ?? ''), ['Jordan Rivera'])
  assert.doesNotMatch(avery, /Request removal/)
  const webAvery = await (await app.go('/people/avery')).text()
  assert.deepEqual(names(webAvery.match(/data-profile-connections>([\s\S]*?)<\/div><\/aside>/)?.[1] ?? ''), ['Jordan Rivera', 'Lena Ito', 'Sasha Baptiste'])
  assert.equal((await app.go('/api/people/avery/card', { agent: IOS })).status, 200)
  // A LinkedIn link to an imported person does not open its public page in the app.
  const lookup = await app.go(`/people/lookup?url=${encodeURIComponent('https://www.linkedin.com/in/morgan-singh')}`, { agent: IOS })
  assert.notEqual(lookup.headers.get('location'), '/people/morgan')
  assert.equal((await app.go(`/people/lookup?url=${encodeURIComponent('https://www.linkedin.com/in/morgan-singh')}`)).headers.get('location'), '/people/morgan')
})

test('signed in, the app still shows the member their own imported people, as their own contacts', async t => {
  const app = await site(t)
  const cookie = await app.signIn()
  const ios = await (await app.go('/network', { agent: IOS, cookie })).text()
  const own = section(ios, 'People you know'), everyone = section(ios, 'Everyone on Unlinked')
  assert.ok(names(own).includes('Morgan Singh') && names(own).includes('Kai Moreau'), own)
  // Their own people link to their own contact records, never to an imported public profile.
  assert.match(own, new RegExp(`href="/network/contacts/${app.morganRow}"`))
  assert.doesNotMatch(own, /href="\/people\/morgan"/)
  assert.deepEqual(names(everyone).filter(name => name !== 'Jordan Rivera'), ['Avery Lee'])
  assert.doesNotMatch(ios, /aria-label="Membership status"/)
  assert.equal((await app.go(`/network/contacts/${app.morganRow}`, { agent: IOS, cookie })).status, 200)
  // The website keeps linking the published profile.
  const web = await (await app.go('/network', { cookie })).text()
  assert.match(section(web, 'People you know'), /href="\/people\/morgan"/)
  assert.ok(names(section(web, 'Everyone on Unlinked')).includes('Sasha Baptiste'))
})
