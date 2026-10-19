import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { applyProfileDecisions, validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { duplicateMembers, unlistedProfiles } from '../src/utils/public-people/unlisted.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { membersOnlySnapshot } from '../src/utils/public-people/members-only.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { operateProfileDecisions } from '../mcp-server/profile-decisions-operator.mjs'

// Unlisted profiles (docs/unlisted-profiles.md): published and reachable, but
// out of the directory, search, suggestions, company pages and AI search.
const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const ABOUT = 'i dont update my profile anymore; see my personal site for what I do'
const fixture = () => ({
  state: 'published', complete: true, revision: 'unlisted-fixture-1',
  profiles: [
    // One person, two accounts: an import (well connected) and a signup lookup (with the LinkedIn address).
    person('harrison-import', 'Harrison Qian', { headline: 'student who lives to learn', about: ABOUT, positions: [{ title: 'Researcher', company: 'Lab' }] }),
    person('harrison-signup', 'Harrison Qian', { headline: 'student who lives to learn', about: ABOUT, linkedinUrl: 'https://www.linkedin.com/in/harqian' }),
    // Same name, different person: never folded.
    person('harrison-other', 'Harrison Qian', { headline: 'Chef', about: 'Cooks things in a small restaurant downtown for many happy years' }),
    // Two member accounts sharing one LinkedIn address.
    person('ada-a', 'Ada Lovelace', { linkedinUrl: 'https://www.linkedin.com/in/ada' }), person('ada-b', 'Ada L.', { linkedinUrl: 'https://linkedin.com/in/Ada/' }),
    // App Review demo accounts and the rest of the directory.
    person('robin', 'Robin Demo', { headline: 'Product designer', positions: [{ title: 'Designer', company: 'Demo Co' }] }),
    person('jordan', 'Jordan Demo', { headline: 'Engineer', positions: [{ title: 'Engineer', company: 'Demo Co' }] }),
    person('casey', 'Casey Demo', { headline: 'Founder', positions: [{ title: 'Founder', company: 'Demo Co' }] }),
    person('ava', 'Ava Stone', { headline: 'Designer', positions: [{ title: 'Designer', company: 'Demo Co' }] }),
    person('shadow', 'Harrison Qian', { headline: 'Researcher' }),
  ],
  connections: [{ fromId: 'harrison-import', toId: 'ava' }, { fromId: 'harrison-import', toId: 'shadow' }, { fromId: 'robin', toId: 'jordan' }, { fromId: 'robin', toId: 'casey' }, { fromId: 'ada-b', toId: 'ava' }],
  members: ['harrison-import', 'harrison-signup', 'harrison-other', 'ada-a', 'ada-b', 'robin', 'jordan', 'casey', 'ava'],
})
const unlist = (id, profileId, group) => ({ id, kind: 'unlist', profileId, ...(group ? { group } : {}) })
const demo = () => applyProfileDecisions(fixture(), ['robin', 'jordan', 'casey'].map((id, index) => unlist(`u${index}`, id, 'appreview')))
const reading = snapshot => { const read = async () => snapshot; read.revisionIdentifiesContent = true; return read }

test('second accounts of one person fold in listings on LinkedIn address or the same name, headline and About; names alone never', () => {
  const duplicates = duplicateMembers(fixture())
  // The better-connected profile stays; the other is unlisted for everyone.
  assert.deepEqual([...duplicates].sort(), [['ada-a', 'ada-b'], ['harrison-signup', 'harrison-import']])
  assert.equal(duplicates.has('harrison-other'), false)
  assert.equal(duplicates.has('shadow'), false, 'imported profiles are not members and are left alone')
  // A short About is not evidence.
  const short = fixture(); for (const value of short.profiles) if (value.about === ABOUT) value.about = 'hello'
  short.profiles.find(value => value.id === 'harrison-signup').linkedinUrl = undefined
  assert.equal(duplicateMembers(short).has('harrison-signup'), false)
  assert.equal(duplicateMembers(short).has('harrison-import'), false)
})

test('an unlist decision keeps the profile, its edges and its page, records a group and changes the revision', () => {
  assert.doesNotThrow(() => validateProfileDecisions([unlist('a', 'robin', 'appreview'), unlist('b', 'jordan')]))
  for (const bad of [[unlist('a', 'robin', 'App Review')], [unlist('a', 'robin'), unlist('b', 'robin')], [{ id: 'a', kind: 'unlist', profileId: 'robin', group: 7 }]]) assert.throws(() => validateProfileDecisions(bad))
  const before = fixture(), after = demo()
  assert.deepEqual(after.profiles, before.profiles); assert.deepEqual(after.connections, before.connections)
  assert.deepEqual(after.unlisted, [{ id: 'casey', group: 'appreview' }, { id: 'jordan', group: 'appreview' }, { id: 'robin', group: 'appreview' }])
  assert.notEqual(after.revision, before.revision)
  // Unknown and invalid stored decisions are inert.
  assert.equal(applyProfileDecisions(before, [unlist('x', 'ghost')]).unlisted, undefined)
  const hidden = unlistedProfiles(after)
  assert.equal(hidden.get('robin'), 'appreview'); assert.equal(hidden.get('harrison-signup'), null)
  // The members-only directory (the iOS app) keeps the same unlisting.
  assert.deepEqual(membersOnlySnapshot(after).unlisted, after.unlisted)
})

test('listings, suggestions and company pages leave unlisted profiles out, except for viewers in the same group', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: reading(demo()) })
  const names = rows => rows.map(value => value.id)
  const everyone = await reader.list({ includeTotal: true })
  assert.deepEqual(names(everyone.profiles).filter(id => ['robin', 'jordan', 'casey', 'harrison-signup', 'ada-a'].includes(id)), [])
  assert.equal(everyone.total, 5)
  // Harrison shows once as a member (plus the different Harrison and the imported row).
  assert.deepEqual(names((await reader.list({ query: 'harrison qian', presence: 'member' })).profiles).sort(), ['harrison-import', 'harrison-other'])
  assert.deepEqual(names((await reader.list({ query: 'demo' })).profiles), ['ava'])
  assert.deepEqual(names((await reader.suggest({ query: 'demo' })).people), ['ava'])
  assert.deepEqual(names((await reader.company({ name: 'Demo Co' })).people), ['ava'])
  // A demo account sees the other demo accounts.
  const group = new Set(['appreview'])
  assert.deepEqual(names((await reader.list({ query: 'demo', unlistedGroups: group })).profiles).sort(), ['ava', 'casey', 'jordan', 'robin'])
  assert.deepEqual(names((await reader.suggest({ query: 'demo', unlistedGroups: group })).people).sort(), ['ava', 'casey', 'jordan', 'robin'])
  assert.deepEqual(names((await reader.company({ name: 'Demo Co', unlistedGroups: group })).people).sort(), ['ava', 'casey', 'jordan', 'robin'])
  // Never the duplicates unlisted for everyone, whatever the group.
  assert.equal(names((await reader.list({ query: 'harrison', unlistedGroups: group })).profiles).includes('harrison-signup'), false)
  // Pages, cards, lookups and connection lists still work.
  assert.equal((await reader.profile({ id: 'jordan' })).profile.name, 'Jordan Demo')
  assert.deepEqual(names((await reader.profile({ id: 'robin' })).profile.connections).sort(), ['casey', 'jordan'])
  assert.equal((await reader.lookup({ ids: ['casey'] })).get('casey').name, 'Casey Demo')
  assert.equal(await reader.unlistedGroup({ id: 'robin' }), 'appreview')
  assert.equal(await reader.unlistedGroup({ id: 'harrison-signup' }), null)
  assert.equal(await reader.unlistedGroup({ id: 'ava' }), undefined)
  await assert.rejects(reader.list({ unlistedGroups: new Set(['Bad Group']) }), { status: 400 })
  // A cursor from one viewer's listing is not valid for another's.
  const small = createPublicPeopleReader({ readPublishedSnapshot: reading(demo()), pageSize: 2 })
  const page = await small.list({ unlistedGroups: group })
  await assert.rejects(small.list({ cursor: page.nextCursor }), { status: 400 })
})

test('AI search never considers unlisted profiles, except for viewers in the same group', async () => {
  const seen = []
  const search = createSharedPeopleSearch({ readPublishedSnapshot: reading(demo()), complete: async ({ input }) => { seen.push(JSON.parse(input).observations.map(value => value.fields.name)); return { matches: [] } } })
  await search({ query: 'demo designer engineer founder harrison' })
  assert.equal(seen[0].filter(name => /Demo/.test(name)).length, 0)
  assert.equal(seen[0].filter(name => name === 'Harrison Qian').length, 3, 'one listed member, the other Harrison and the imported row')
  await search({ query: 'demo designer engineer founder', unlistedGroups: new Set(['appreview']) })
  assert.equal(seen[1].filter(name => /Demo/.test(name)).length, 3)
})

test('the operator records unlist decisions with an optional group', async () => {
  const stored = [], session = {
    executeRead: async work => work({ run: async () => ({ records: stored.map(value => ({ get: () => value })) }) }),
    executeWrite: async work => work({ run: async (query, params) => { if (params?.decision) stored.push(params.decision); return { records: [] } } }),
  }
  const grouped = await operateProfileDecisions({ session, args: ['unlist', 'robin', 'appreview', 'operator', 'App Store review demo account'], now: () => '2026-10-18T00:00:00Z' })
  assert.deepEqual({ kind: grouped.decision.kind, profileId: grouped.decision.profileId, group: grouped.decision.group }, { kind: 'unlist', profileId: 'robin', group: 'appreview' })
  const everyone = await operateProfileDecisions({ session, args: ['unlist', 'harrison-signup', '-', 'operator', 'second account'], now: () => '2026-10-18T00:00:00Z' })
  assert.equal('group' in everyone.decision, false)
  await assert.rejects(operateProfileDecisions({ session, args: ['unlist', 'robin', 'appreview', 'operator', 'again'] }), /profile_decisions_invalid/)
  await assert.rejects(operateProfileDecisions({ session, args: ['unlist', 'ava', 'Bad Group', 'operator', 'x'] }), /profile_decisions_invalid/)
})

test('signed-in pages: demo accounts see each other in Everyone and suggestions; other members and visitors do not', async t => {
  const owners = { robin: { ownerId: 'robin-owner', userId: 'robin-user' }, ava: { ownerId: 'ava-owner', userId: 'ava-user' } }
  let signingIn = 'robin', handler
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'private_live', readPublishedSnapshot: reading(demo()),
    login: { begin: async () => ({ location: 'https://id.example.invalid/authorize', transaction: { state: 's' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: signingIn, displayName: signingIn }) },
    resolveOwner: async identity => owners[identity.subject], signup: async () => owners[signingIn], ownProfileId: async owner => owner.ownerId.replace('-owner', ''),
    issueAccountGrant: async () => ({ accessToken: 'x' }), revokeAccountGrant: async () => {},
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [], readLegacyFiles: async () => null, readLegacyProfile: async () => null }) })
  const signIn = async who => {
    signingIn = who
    const start = await fetch(endpoint + '/login', { redirect: 'manual' })
    const callback = await fetch(endpoint + '/auth/callback/ideaflow?state=s&code=c', { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    return callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  }
  const demoNames = html => [...new Set(html.match(/(Robin|Jordan|Casey) Demo/g) ?? [])].sort()
  const robin = await signIn('robin'), ava = await signIn('ava')
  assert.deepEqual(demoNames(await (await fetch(endpoint + '/network?q=demo', { headers: { Cookie: robin } })).text()), ['Casey Demo', 'Jordan Demo', 'Robin Demo'])
  assert.deepEqual(demoNames(await (await fetch(endpoint + '/network?q=demo', { headers: { Cookie: ava } })).text()), [])
  assert.deepEqual(demoNames(await (await fetch(endpoint + '/network?q=demo')).text()), [])
  // Suggestions are read without waiting; the second keystroke has the viewer's group.
  await fetch(endpoint + '/search-suggestions?q=de', { headers: { Cookie: robin } })
  await new Promise(resolve => setTimeout(resolve, 20))
  const suggested = await (await fetch(endpoint + '/search-suggestions?q=demo', { headers: { Cookie: robin } })).json()
  assert.deepEqual(suggested.people.map(value => value.name).sort(), ['Ava Stone', 'Casey Demo', 'Jordan Demo', 'Robin Demo'])
  assert.deepEqual((await (await fetch(endpoint + '/search-suggestions?q=demo', { headers: { Cookie: ava } })).json()).people.map(value => value.name), ['Ava Stone'])
  // The profile pages stay reachable for anyone with the link.
  assert.equal((await fetch(endpoint + '/people/jordan')).status, 200)
})
