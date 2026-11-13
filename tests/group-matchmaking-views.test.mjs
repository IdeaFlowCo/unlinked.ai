import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadGroupMatchEntries, matchGroupMembers } from '../mcp-server/group-matchmaking.mjs'
import { renderGroupMatchmaking } from '../mcp-server/group-matchmaking-views.mjs'
import { ONBOARDING_STYLE } from '../mcp-server/private-onboarding-style.mjs'

const group = { id: 'fixture-group', urlKey: 'builders-fixture', name: 'Builders' }
const roster = [{ id: 'me', name: 'Alice' }, { id: 'bob', name: 'Bob Builder' }]
const chrome = { csrf: 'fixture-csrf' }
const row = (id, memberId, kind, title, extra = {}) => ({
  id, memberId, kind, title, body: '', audience: 'group', groupId: group.id,
  status: 'open', ...extra,
})
const render = (result, matches, extra = {}) => renderGroupMatchmaking({
  chrome, group, roster, ownId: 'me', result, matches, messagingAvailable: true, ...extra,
})
async function evidence(name, html) {
  const directory = process.env.MATCHMAKING_EVIDENCE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  // Actual product renderer and stylesheet, with a minimal document wrapper.
  // This fixture deliberately does not simulate the authenticated page shell.
  await writeFile(join(directory, name + '.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Find matches · Builders · renderer fixture</title><style>${ONBOARDING_STYLE}</style></head><body><div class="unlinked-onboarding"><main class="journey">${html}</main></div></body></html>`)
}

test('match renderer presents reciprocal evidence and the existing explicit Message form after paged loading', async () => {
  const pages = [
    { entries: [], nextCursor: 10 },
    { entries: [
      row(9, 'me', 'ask', 'React accessibility review'),
      row(8, 'bob', 'offer', 'React WCAG reviews', { body: 'One screen or prototype' }),
      row(7, 'me', 'offer', 'Customer interviews'),
      row(6, 'bob', 'ask', 'Need user research'),
      row(5, 'bob', 'offer', 'PRIVATE_SENTINEL', { audience: 'only_me' }),
    ], nextCursor: null },
  ]
  const calls = []
  const result = await loadGroupMatchEntries({ group: async (_actor, _id, _roster, page) => {
    calls.push(page)
    return pages.shift()
  } }, {}, group.id, roster)
  const matches = await matchGroupMembers(result.entries, 'me')
  const html = render(result, matches)
  assert.deepEqual(calls, [{ limit: 500 }, { limit: 500, cursor: 10 }])
  assert.equal(matches.length, 1)
  assert.equal(matches[0].reciprocal, true)
  assert.match(html, /Ways to help each other/)
  assert.match(html, /They may be able to help you/)
  assert.match(html, /You may be able to help them/)
  assert.match(html, /both entries mention accessibility, react/)
  assert.match(html, /both entries mention user research/)
  assert.match(html, /href="\/groups\/builders-fixture\/community\/bob"/)
  assert.match(html, /method="post" action="\/groups\/builders-fixture\/members\/bob\/message"/)
  assert.match(html, /name="csrf" value="fixture-csrf"/)
  assert.doesNotMatch(html, /PRIVATE_SENTINEL/)
  await evidence('reciprocal-renderer', html)
})

test('match renderer distinguishes partial coverage, unavailable data and an empty group', async () => {
  let cursor = 100
  const partial = await loadGroupMatchEntries({ group: async () => ({ entries: [], nextCursor: --cursor }) }, {}, group.id, roster)
  // The bounded scan returns no fabricated candidates even when filtered pages are empty.
  assert.equal(partial.complete, false)
  const html = render(partial, [])
  assert.match(html, /Partial results: checked up to the newest 2,000 shared entries/)
  assert.match(html, /Older entries were not checked/)
  await evidence('partial-renderer', html)
  const unavailable = render({ unavailable: true }, [])
  assert.match(unavailable, /Matches could not be loaded/)
  assert.doesNotMatch(unavailable, /No complementary match|Give people a way to help you|Checked the group/)
  await evidence('unavailable-renderer', unavailable)
  const empty = render({ entries: [], complete: true }, [])
  assert.match(empty, /Give people a way to help you/)
  assert.match(empty, /0 open asks and offers from 0 members/)
  await evidence('empty-renderer', empty)
})

test('transient search renderer escapes the need and labels evidence without creating a send action', async () => {
  const search = 'Need customer interviews <script>alert(1)</script> & feedback'
  const entries = [row(1, 'me', 'ask', search), row(2, 'bob', 'offer', 'User research')]
  const result = { entries, complete: true }
  const html = render(result, await matchGroupMembers(entries, 'me'), { search })
  assert.match(html, /<dt>Your search<\/dt>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; feedback/)
  assert.doesNotMatch(html, /<script>|action="[^\"]*\/messages/)
  assert.match(html, /Your search is only used to show this page/)
  assert.match(html, /Show matches for my saved asks and offers/)
  assert.match(html, /method="post" action="\/groups\/builders-fixture\/matches\/search"/)
  await evidence('search-renderer', html)
})
