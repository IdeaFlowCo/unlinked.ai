import test from 'node:test'
import assert from 'node:assert/strict'
import { publishedPeopleFor } from '../mcp-server/private-browser.mjs'
import { renderFindMe, renderOwnProfile, renderSettings } from '../mcp-server/private-onboarding-views.mjs'

const row = (id, url) => ({ id, fields: { 'first name': 'A', 'last name': 'B', url } })
const people = new Map([['public-own', { id: 'public-own' }], ['legacy-1', { id: 'legacy-1' }]])
const reader = ids => { reader.calls.push(ids); return new Map(ids.filter(id => people.has(id)).map(id => [id, people.get(id)])) }

test('own connection rows link to their published person, else the public profile with the same LinkedIn address', async () => {
  reader.calls = []
  const slugs = { known: 'legacy-1', ghost: 'not-published' }
  const matches = await publishedPeopleFor([
    row('own', 'https://www.linkedin.com/in/known'),      // own published person wins
    row('private', 'https://www.linkedin.com/in/known'),  // not published: falls back to the legacy profile
    row('private2', 'https://www.linkedin.com/in/ghost'), // slug maps to an unpublished id: no link
    row('private3', 'not a url'),                          // nothing to match
  ], { publicTarget: value => 'public-' + value.id, lookupSlug: slug => slugs[slug] ?? null, lookup: reader })
  assert.deepEqual(matches.map(match => match?.id ?? null), ['public-own', 'legacy-1', null, null])
  assert.equal(reader.calls.length, 1, 'one batched lookup')
  // Without a slug index (no self-claims), only own published people link.
  const plain = await publishedPeopleFor([row('private', 'https://www.linkedin.com/in/known')], { publicTarget: value => 'public-' + value.id, lookupSlug: null, lookup: reader })
  assert.deepEqual(plain, [null])
})

test('"Is this you?" links to the candidate profile; test profiles are not linked', () => {
  const lookupResult = { status: 'found', id: 'fda3008a', profileName: 'Roger Cole', headline: 'Founder at Sleep Intelligence', listedBy: 3, claimAction: '/claim-me', claimToken: 't' }
  const page = renderFindMe({ accountLabel: 'r@example.invalid', displayName: 'Roger Cole', csrf: 'c', lookupResult }).content
  assert.match(page, /<a href="\/people\/fda3008a" target="_blank" rel="noopener">Roger Cole<\/a>/)
  assert.match(page, /View profile ↗/); assert.match(page, /Founder at Sleep Intelligence/); assert.match(page, /Listed by 3 members/)
  const testCard = renderFindMe({ csrf: 'c', lookupResult: { ...lookupResult, test: true } }).content
  assert.doesNotMatch(testCard, /href="\/people\/fda3008a"/)
})

test('an import with only skipped rows reads as finished, not "needs attention"', () => {
  const job = { id: 'j', status: 'partial', total: 51, processed: 51, rejected: 1, failedFiles: 0 }
  const profile = renderOwnProfile({ accountLabel: 'a', displayName: 'Roger Cole', csrf: 'c', importJob: job }).content
  assert.match(profile, /Import finished · 51 people · 1 row skipped/)
  assert.doesNotMatch(profile, /Import needs attention/)
  const failedFile = renderOwnProfile({ accountLabel: 'a', displayName: 'R', csrf: 'c', importJob: { ...job, failedFiles: 1 } }).content
  assert.match(failedFile, /Import needs attention/)
  const settings = renderSettings({ accountLabel: 'a', displayName: 'R', csrf: 'c', imports: [{ id: 'x', filename: 'Connections.csv', status: 'partial', accepted: 51, indexed: 51, rejected: 1, failedFiles: 0, visibility: 'public' }] }).content
  assert.match(settings, /51 records accepted · 51 indexed · 1 row skipped\./)
  assert.match(settings, /finished · rows with no name or LinkedIn address were skipped/)
  assert.doesNotMatch(settings, /notice error/)
})
