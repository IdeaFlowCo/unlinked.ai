// unlinked-tto.4: one card per person on /network. A published profile, the
// owner's LinkedIn import of the same person and an accepted connection are one
// card; "Everyone on Unlinked" never repeats someone shown under "People you
// know"; counts are cards; people who only share a name stay separate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

const ROGER = 'fda3008a-5990-4816-86ff-3834cfa6825d'
const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = {
  state: 'published', complete: true, revision: 'one-card-test',
  profiles: [
    profile(ROGER, 'Roger Cole', { headline: 'Founder at Sleep Intelligence', linkedinUrl: 'https://www.linkedin.com/in/roger-cole' }),
    profile('alex-a', 'Alex Kim', { headline: 'Designer', company: 'Northwind' }),
    profile('alex-c', 'Alex Kim', { headline: 'Investor', company: 'Contoso' }),
    profile('owner', 'Jacob Cole'),
  ],
  members: [ROGER, 'alex-c', 'owner'], connections: [],
  aliases: { 'roger-merged-away': ROGER },
}

const section = (page, label) => page.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? ''
const cards = html => [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g)].map(match => match[1])
const strip = page => page.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '')

async function harness(t) {
  const owner = { ownerId: 'one-card-owner', userId: 'one-card-user' }
  const importId = 'a'.repeat(64), rogerRow = 'b'.repeat(64), alexRow = 'c'.repeat(64), otherAlexRow = 'd'.repeat(64)
  const row = (id, fields) => [id, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id, ownerId: owner.ownerId, importId, category: 'connections', fields } }]
  const resources = new Map([
    [importId, { sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: { id: importId, createdAt: Date.UTC(2026, 0, 5), status: 'indexed', assertionIds: [rogerRow, alexRow, otherAlexRow], counts: { accepted: 3, indexed: 3, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } }],
    // The owner's LinkedIn import of Roger: private row, same LinkedIn address as his profile.
    row(rogerRow, { 'first name': 'Roger', 'last name': 'Cole', position: 'Founder', company: 'Sleep Intelligence', url: 'https://www.linkedin.com/in/roger-cole', 'connected on': '12 Mar 2019' }),
    // Two different people named Alex Kim: different LinkedIn addresses, never merged.
    row(alexRow, { 'first name': 'Alex', 'last name': 'Kim', position: 'Designer', company: 'Northwind', url: 'https://www.linkedin.com/in/alex-kim-northwind' }),
    row(otherAlexRow, { 'first name': 'Alex', 'last name': 'Kim', position: 'Engineer', company: 'Fabrikam', url: 'https://www.linkedin.com/in/alex-kim-fabrikam' }),
  ])
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const slugs = { 'roger-cole': ROGER, 'alex-kim-northwind': 'alex-a' }
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://identity.invalid/', transaction: { state: 'test' } }), finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test' }) }, resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    readPublishedSnapshot: async () => snapshot, ownProfileId: async () => 'owner',
    selfClaims: { lookupSlug: async slug => slugs[slug] ?? null, lookupName: async () => null, claimable: async () => null, claim: async () => null },
    getBackend: async () => ({ adapter: {}, listImportIds: async () => [importId], listImportJobIds: async () => [], readResource: async (_, id) => structuredClone(resources.get(id) ?? null),
      // An accepted Unlinked connection with Roger, recorded under an id later merged into his profile.
      readMemberConnections: async () => [{ requestId: 'roger-request', name: 'Roger Cole', publicProfileId: 'roger-merged-away', connectedAt: Date.UTC(2026, 9, 1) }] }) })
  const go = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const callback = await go('/auth/callback/ideaflow?state=test&code=test', loginCookie)
  const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  return { page: async path => { const response = await go(path, cookie); assert.equal(response.status, 200); return response.text() }, rogerRow }
}

test('profile + LinkedIn import + accepted connection of one person are one card, never repeated under Everyone', async t => {
  const { page, rogerRow } = await harness(t)
  const result = await page('/network?q=roger+cole')
  const own = cards(section(result, 'People you know')), everyone = cards(section(result, 'Everyone on Unlinked'))
  assert.equal(own.length, 1, strip(result))
  assert.equal(everyone.length, 0, strip(result))
  assert.match(result, /Showing 1 of 1 matching people/)
  const [card] = own
  // The published profile's link, headline and membership; the import's LinkedIn link.
  assert.match(card, new RegExp(`href="/people/${ROGER}"`))
  assert.match(card, /Founder at Sleep Intelligence/)
  assert.doesNotMatch(card, /Founder at Sleep Intelligence · Sleep Intelligence/)
  assert.match(card, /On Unlinked/)
  assert.match(card, /href="https:\/\/www\.linkedin\.com\/in\/roger-cole"/)
  // A quiet disclosure lists both records with provenance; the import links to its own record.
  assert.match(card, /<details class="sources"><summary>2 sources<\/summary>/)
  assert.match(card, new RegExp(`<a href="/network/contacts/${rogerRow}">Imported contact</a> · connected <time datetime="2019-03-12">`))
  assert.match(card, /Accepted Unlinked connection(<\/a>)? · connected <time datetime="2026-10-01">/)
  assert.equal((result.match(new RegExp(`data-network-row="${rogerRow}"`, 'g')) ?? []).length, 1)
  // Without a query the person is still once on the page.
  const all = await page('/network')
  assert.equal((all.match(new RegExp(`href="/people/${ROGER}"`, 'g')) ?? []).length, 1, strip(all))
  // "Recently connected" uses the earliest date of the person's records.
  const mine = await page('/network?connected=1&sort=connected')
  assert.match(mine, /Connected <time datetime="2019-03-12"/)
})

test('people who only share a name stay separate cards with their company; counts match cards', async t => {
  const { page } = await harness(t)
  const result = await page('/network?q=alex+kim')
  const own = cards(section(result, 'People you know')), everyone = cards(section(result, 'Everyone on Unlinked'))
  assert.equal(own.length, 2, strip(result))
  assert.ok(own.some(card => /href="\/people\/alex-a"/.test(card) && /Designer · Northwind|Designer/.test(card)))
  assert.ok(own.some(card => !/href="\/people\//.test(card) && /Engineer · Fabrikam/.test(card)))
  assert.ok(own.every(card => !/class="sources"/.test(card)))
  // The other Alex Kim on Unlinked is someone else: shown once under Everyone.
  assert.equal(everyone.length, 1)
  assert.match(everyone[0], /href="\/people\/alex-c"/)
  assert.match(everyone[0], /Investor/)
  assert.match(result, /Showing 3 of 3 matching people/)
})

test('the public list leaves out excluded people before paging and totals, following merges, with its own cursors', async () => {
  const people = Array.from({ length: 5 }, (_, i) => profile(`p${i}`, `Person ${i}`))
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'exclude-test', profiles: people, connections: [], aliases: { old: 'p1' } }), pageSize: 2 })
  const first = await reader.list({ includeTotal: true, exclude: ['old', 'p3'] })
  assert.deepEqual(first.profiles.map(p => p.id), ['p0', 'p2']); assert.equal(first.total, 3)
  assert.deepEqual((await reader.list({ exclude: ['old', 'p3'], cursor: first.nextCursor })).profiles.map(p => p.id), ['p4'])
  // A cursor never crosses to a listing with other exclusions.
  await assert.rejects(reader.list({ cursor: first.nextCursor }), { status: 400 })
  const searched = await reader.list({ query: 'person', exclude: ['p0'] })
  assert.equal(searched.total, 4); assert.ok(!searched.profiles.some(p => p.id === 'p0'))
  await assert.rejects(reader.list({ exclude: 'p0' }), { status: 400 })
})
