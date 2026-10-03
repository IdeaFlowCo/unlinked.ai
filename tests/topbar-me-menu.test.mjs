import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { renderPeople, renderLanding, renderScan, fillMeHeadline, ME_HEADLINE_SLOT, TOP_BAR_SCRIPT, SCAN_TABS_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'

const account = { accountLabel: 'sam@example.test', displayName: 'Sam Rivera', csrf: 'csrf-value' }
const header = view => view.content.match(/<header>(.*?)<\/header>/s)[1]

test('the search field ends in a QR scan button for everyone', () => {
  for (const view of [renderLanding(), renderPeople({ ...account, state: 'ready' })]) {
    const search = header(view).match(/<form class="header-search".*?<\/form>/s)[0]
    assert.match(search, /<a class="scan" href="\/scan" aria-label="Scan a QR code or show your card"/)
    assert.doesNotMatch(search, /data:/)
  }
})

test('signed-in members get one Me menu: profile header, card, settings, then switch account and sign-out last', () => {
  const nav = header(renderPeople({ ...account, state: 'ready' })).match(/<nav[^>]*>(.*?)<\/nav>/s)[1]
  // The bar itself carries no separate profile, name chip or sign-out.
  const outside = nav.replace(/<details class="me">.*<\/details>/s, '')
  // The avatar is the one-click way to your own profile; nothing else outside the menu.
  assert.match(nav, /<a class="me-face" href="\/profile" aria-label="Your profile" title="Your profile"><span class="initials avatar" aria-hidden="true">SR<\/span><\/a><details class="me">/)
  assert.doesNotMatch(outside.replace(/<a class="me-face"[^>]*>.*?<\/a>/s, ''), /href="\/profile"|class="chip"|logout|Sign out/)
  const menu = nav.match(/<details class="me">(.*)<\/details>/s)[1]
  assert.match(menu, /^<summary aria-haspopup="menu" aria-label="Me: account menu for Sam Rivera"><span class="me-l">Me/)
  assert.match(menu, /<div class="me-panel" role="menu" aria-label="Account">/)
  assert.match(menu, /<div class="me-who"><b>Sam Rivera<\/b><!--me-headline--><\/div><a class="button sec sm me-view" role="menuitem" href="\/profile">View profile<\/a>/)
  const items = [...menu.matchAll(/role="menuitem"[^>]*?(?:href="([^"]+)")?>([^<]*)/g)].map(match => match[1] ?? match[2])
  assert.deepEqual(items, ['/profile', '/card', '/scan', '/settings', 'Switch account', 'Sign out'])
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

test('the scan sheet defaults to Scan, honours ?tab=card, and asks for the camera', () => {
  const scan = renderScan({ ...account }), card = renderScan({ ...account, tab: 'card' })
  assert.equal(scan.camera, true)
  assert.match(scan.content, /id="panel-scan" aria-labelledby="tab-scan">/); assert.match(scan.content, /id="panel-card" aria-labelledby="tab-card" hidden>/)
  assert.match(card.content, /id="panel-scan" aria-labelledby="tab-scan" hidden>/); assert.match(card.content, /id="panel-card" aria-labelledby="tab-card">/)
  assert.match(scan.content, /class="sheet-close" href="\/network" aria-label="Close"/)
  assert.match(renderScan({}).content, /class="sheet-close" href="\/" aria-label="Close"/)
  assert.match(renderScan({ tab: '<x>' }).content, /aria-selected="true">Scan</)
})

test('the menu and tab scripts are syntactically valid and carry no markup', () => {
  for (const source of [TOP_BAR_SCRIPT, SCAN_TABS_SCRIPT]) {
    assert.doesNotThrow(() => new vm.Script(source))
    assert.doesNotMatch(source, /<\/script|innerHTML/)
  }
  assert.match(TOP_BAR_SCRIPT, /Escape/); assert.match(TOP_BAR_SCRIPT, /aria-expanded/)
})
