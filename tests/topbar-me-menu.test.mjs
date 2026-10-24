import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { renderPeople, renderLanding, renderScan, fillMeHeadline, ME_HEADLINE_SLOT, TOP_BAR_SCRIPT, SCAN_TABS_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'

const account = { accountLabel: 'sam@example.test', displayName: 'Sam Rivera', csrf: 'csrf-value' }
const header = view => view.content.match(/<header>(.*?)<\/header>/s)[1]

test('every header keeps the global search, People included, and no QR button inside the field', () => {
  for (const view of [renderLanding(), renderPeople({ ...account, state: 'ready' })]) {
    const search = header(view)
    assert.match(search, /<form class="header-search" method="get" action="\/network" role="search">/)
    assert.doesNotMatch(search, /class="scan"|href="\/scan"[^>]*>(?!\s*<svg)|data:/)
  }
  // The directory's own toolbar holds the filter; the header field stays empty there.
  const people = header(renderPeople({ ...account, state: 'ready', query: 'designers', presence: 'member' }))
  assert.match(people, /name="q" type="search"[^>]* value=""/)
  assert.match(people, /<input type="hidden" name="presence" value="member">/)
})

test('the current page is marked in the main navigation, and My card is one QR entry point', () => {
  const nav = view => header(view).match(/<nav[^>]*>(.*?)<\/nav>/s)[1]
  const people = nav(renderPeople({ ...account, state: 'ready' }))
  assert.match(people, /<a href="\/network\?connected=1" aria-current="page">People<\/a>/)
  assert.equal(people.match(/aria-current="page"/g).length, 1)
  assert.equal(people.match(/<a class="my-card-link" href="\/card" aria-label="My card">/g).length, 1)
  assert.doesNotMatch(people.replace(/<details class="me">.*<\/details>/s, ''), /href="\/scan"/)
  const scan = nav(renderScan({ ...account, tab: 'card', profile: { name: 'Sam Rivera' }, cardUrl: 'https://www.unlinked.ai/c/abc', qr: '<svg></svg>' }))
  assert.doesNotMatch(scan, /aria-current/)
  assert.doesNotMatch(nav(renderLanding()), /aria-current/)
})

test('signed-in members get one Me menu: profile header, card, settings, help, then switch account and sign-out last', () => {
  const nav = header(renderPeople({ ...account, state: 'ready' })).match(/<nav[^>]*>(.*?)<\/nav>/s)[1]
  // The bar itself carries no separate profile, name chip or sign-out.
  const outside = nav.replace(/<details class="me">.*<\/details>/s, '')
  // The avatar is the menu trigger itself: no separate profile link outside the menu.
  assert.doesNotMatch(outside, /href="\/profile"|class="chip"|class="me-face"|logout|Sign out/)
  const menu = nav.match(/<details class="me">(.*)<\/details>/s)[1]
  assert.match(menu, /^<summary aria-haspopup="menu" aria-label="Me: account menu for Sam Rivera"><span class="initials avatar" aria-hidden="true">SR<\/span><span class="me-l">Me/)
  assert.match(menu, /<div class="me-panel" role="menu" aria-label="Account">/)
  assert.match(menu, /<div class="me-who"><b>Sam Rivera<\/b><!--me-headline--><\/div><a class="button sec sm me-view" role="menuitem" href="\/profile">View profile<\/a>/)
  const items = [...menu.matchAll(/role="menuitem"[^>]*?(?:href="([^"]+)")?>([^<]*)/g)].map(match => match[1] ?? match[2])
  assert.deepEqual(items, ['/profile', '/card', '/scan', '/settings', '/support', 'Switch account', 'Sign out'])
  // Switch account and Sign out are CSRF-protected POSTs, never links.
  assert.match(menu, /<div class="me-sep" role="separator"><\/div><form method="post" action="\/switch-account" role="none"><input type="hidden" name="csrf" value="csrf-value"><button type="submit" class="me-out" role="menuitem">Switch account<\/button><\/form><form method="post" action="\/logout" role="none"><input type="hidden" name="csrf" value="csrf-value"><button type="submit" class="me-out" role="menuitem">Sign out<\/button><\/form><\/div>$/)
  assert.doesNotMatch(header(renderLanding()), /class="me"|role="menu"/)
})

test('the headline slot is filled per request, escaped, and empty when unknown', () => {
  const content = renderPeople({ ...account, state: 'ready' }).content
  assert.ok(content.includes(ME_HEADLINE_SLOT))
  assert.match(fillMeHeadline(content, 'Partnerships <lead>'), /<b>Sam Rivera<\/b><span class="me-hl">Partnerships &lt;lead&gt;<\/span><\/div>/)
  assert.match(fillMeHeadline(content, '  '), /<b>Sam Rivera<\/b><\/div>/)
  assert.match(fillMeHeadline(content, undefined), /<b>Sam Rivera<\/b><\/div>/)
  assert.ok(!fillMeHeadline(content, 'x').includes(ME_HEADLINE_SLOT))
})

test('the scan sheet opens My card for members, Scan for visitors, honours ?tab=, and asks for the camera', () => {
  const member = renderScan({ ...account }), scan = renderScan({ ...account, tab: 'scan' }), card = renderScan({ ...account, tab: 'card' })
  assert.equal(member.camera, true)
  for (const page of [member, card]) { assert.match(page.content, /id="panel-scan" aria-labelledby="tab-scan" hidden>/); assert.match(page.content, /id="panel-card" aria-labelledby="tab-card">/) }
  assert.match(member.content, /id="tab-card"[^>]*>My card<\/a><a role="tab" id="tab-scan"/)
  assert.match(scan.content, /id="panel-scan" aria-labelledby="tab-scan">/); assert.match(scan.content, /id="panel-card" aria-labelledby="tab-card" hidden>/)
  assert.match(member.content, /class="sheet-close" href="\/network" aria-label="Close"/)
  const visitor = renderScan({})
  assert.match(visitor.content, /class="sheet-close" href="\/" aria-label="Close"/)
  assert.match(visitor.content, /aria-selected="true">Scan</); assert.match(visitor.content, /id="tab-scan"[^>]*>Scan<\/a><a role="tab" id="tab-card"/)
  assert.match(renderScan({ tab: '<x>' }).content, /aria-selected="true">Scan</)
  assert.match(renderScan({ ...account, tab: '<x>' }).content, /aria-selected="true">My card</)
})

test('the menu and tab scripts are syntactically valid and carry no markup', () => {
  for (const source of [TOP_BAR_SCRIPT, SCAN_TABS_SCRIPT]) {
    assert.doesNotThrow(() => new vm.Script(source))
    assert.doesNotMatch(source, /<\/script|innerHTML/)
  }
  assert.match(TOP_BAR_SCRIPT, /Escape/); assert.match(TOP_BAR_SCRIPT, /aria-expanded/)
})
