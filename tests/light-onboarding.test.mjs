import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderJoin, renderBringArchive, renderOwnProfile, renderPeople, renderSettings, renderImporting, uploadProgressScript, agentSetupCopyScript } from '../mcp-server/private-onboarding-views.mjs'
import { buildPreviews } from '../mcp-server/private-onboarding-preview.mjs'

const account = { accountLabel: 'Test person', csrf: 'csrf-value' }

test('production upload uses only native archive and csrf fields, without consent checkbox', () => {
  const view = renderBringArchive(account)
  assert.match(view.content, /method="post" action="\/upload" enctype="multipart\/form-data"/)
  assert.match(view.content, /name="archive"/)
  assert.match(view.content, /name="csrf" value="csrf-value"/)
  assert.match(view.content, /By importing, your profile and connections join your Unlinked network, searchable by you and by any agent you connect. Contact details stay private\./)
  assert.match(renderSettings(account).content, /file, profile and connections stay private/)
  assert.match(renderSettings(account).content, /When you or an agent you connect searches, OpenAI receives the search query and a limited set/)
  assert.doesNotMatch(view.content, /type="checkbox"|name="consent"|name="syntheticConsent"/)
  assert.match(renderBringArchive({ ...account, syntheticMode: true }).content, /required type="checkbox" name="syntheticConsent"/)
})

test('all raw profile, contact, account, error and configuration values are escaped', () => {
  const attack = '<script>alert("bad")</script>'
  const views = [
    renderBringArchive({ ...account, accountLabel: attack, state: 'error', errorMessage: attack }),
    renderOwnProfile({ ...account, profile: { name: attack, headline: attack, skills: [attack], positions: [{ title: attack, company: attack }], education: [{ institution: attack }] }, contacts: [{ name: attack, linkedinUrl: 'javascript:alert(1)' }] }),
    renderPeople({ ...account, query: attack, own: [{ name: attack, reason: attack }] }),
    renderSettings({ ...account, agentConfiguration: attack, imports: [{ id: '..', filename: attack, status: attack }], grants: [{ id: attack }] }),
  ]
  for (const view of views) {
    assert.doesNotMatch(view.content, /<script>|javascript:|href="\/imports\/\.\."/)
    assert.match(view.content, /&lt;script&gt;/)
  }
})

test('job status persists across signed views and never treats staged records as searchable', () => {
  const importJob = { id: 'job', status: 'indexing', processed: 412, total: 1005, profileReady: true }
  for (const render of [renderBringArchive, renderOwnProfile, renderPeople, renderSettings, renderImporting, props => renderJoin({ ...props, signedIn: true })]) {
    const view = render({ ...account, importJob })
    assert.match(view.content, /role="search"/)
    assert.match(view.content, /action="\/search-account"/)
    assert.match(view.content, /name="csrf" value="csrf-value"/)
    assert.match(view.content, /action="\/logout"/)
    assert.match(view.content, /Signed in as Test person/)
    assert.match(view.content, /Importing · 41% · 412 of 1,005 records/)
    assert.match(view.content, /<progress aria-label="Import in progress" value="412" max="1005">/)
    assert.match(view.content, /Keeps running even if you leave this page\./)
    assert.match(view.content, /Your profile is ready; connections are still coming in/)
    assert.doesNotMatch(view.content.match(/<aside class="import-status"[^>]*>(.*?)<\/aside>/s)[1], /searchable/)
  }
  assert.doesNotMatch(renderJoin({ ...account, importJob }).content, /role="search"|action="\/logout"|class="import-status"/)
  for (const [status, title, body] of [
    ['failed', 'Import could not finish', /Your file could not be imported/],
    ['partial', 'Import needs attention', /did not finish completely/],
    ['indexed', 'Import finished', /Open People to search your connections/],
  ]) {
    const view = renderImporting({ ...account, importJob: { ...importJob, status, errorMessage: status === 'failed' ? '<Invalid archive>' : undefined } })
    assert.equal(view.title, title)
    assert.match(view.content, body)
    assert.doesNotMatch(view.content, /<progress|continue when your file is ready|Reading your profile and connections/)
    if (status === 'failed') assert.match(view.content, /&lt;Invalid archive&gt;/)
  }
  assert.doesNotMatch(renderPeople({ ...account, importJob: { ...importJob, total: null } }).content, /Importing · \d+% ·/)
  assert.match(renderPeople({ ...account, importJob: { ...importJob, status: 'failed' } }).content, /Import could not finish/)
  assert.match(renderPeople({ ...account, importJob: { ...importJob, status: 'indexed' } }).content, /Import finished · 1,005 records/)
})

test('indexed header and Settings totals count records, including profile and skills rows', () => {
  const importJob = { status: 'indexed', processed: 1005, total: 1005, profileReady: true }
  const header = renderPeople({ ...account, importJob }).content.match(/<aside class="import-status"[^>]*>(.*?)<\/aside>/s)[1]
  assert.match(header, /Import finished · 1,005 records/)
  assert.doesNotMatch(header, /\d[\d,]*\s+connections/i)

  const settings = renderSettings({ ...account, imports: [{ id: 'mixed-records', filename: 'Full.zip', accepted: 1005, indexed: 1003, status: 'partial' }] })
  const details = settings.content.match(/<details>(.*?)<\/details>/s)[1]
  assert.match(details, /1,005 records accepted · 1,003 indexed/)
  assert.doesNotMatch(details, /\d[\d,]*\s+connections/i)
  assert.doesNotMatch(details, /ready to search/)
})

test('unknown or inconsistent counts are indeterminate, never invented', () => {
  for (const counts of [{ total: null, processed: 0 }, { total: 0, processed: 0 }, { total: 1005 }, { total: 1005, processed: -1 }, { total: 1005, processed: 1006 }]) {
    const view = renderImporting({ ...account, importJob: { status: 'parsing', ...counts } })
    assert.match(view.content, /<strong>Importing…<\/strong>/)
    assert.match(view.content, /<progress aria-label="Import in progress"><\/progress>/)
    assert.doesNotMatch(view.content.match(/<aside class="import-status"[^>]*>(.*?)<\/aside>/s)[1], /NaN|Infinity|\d+%/)
  }
  for (const [processed, percent] of [[0, 0], [1, 10], [10, 100]]) {
    assert.match(renderPeople({ ...account, importJob: { status: 'indexing', processed, total: 10 } }).content, new RegExp(`Importing · ${percent}% · ${processed} of 10 records`))
  }
  for (const status of ['uploaded', 'parsing', 'indexing']) {
    assert.match(renderPeople({ ...account, importJob: { status, total: null } }).content, /Keeps running even if you leave this page/)
  }
  assert.doesNotMatch(renderPeople({ ...account, importJob: { status: 'invented' } }).content, /class="import-status"/)
  const partial = renderPeople({ ...account, importJob: { status: 'partial' } }).content
  assert.match(partial, /Import needs attention.*href="\/settings">Review in Settings/s)
})

test('the accepted member journey uses light copy and the shared navigation', () => {
  const join = renderJoin()
  assert.match(join.content, /href="\/login">Continue with Google/)
  assert.match(join.content, /href="\/login">Continue with email/)
  assert.match(join.content, /Same sign-in as OpenChat\./)
  assert.equal(join.content.match(/class="button[^\"]*"/g).length, 2)
  assert.match(join.content, /1\. Account.*·.*2\. Your LinkedIn export.*·.*3\. Your profile/s)
  const archive = renderBringArchive({ ...account, limitBytes: 32 * 1048576 })
  assert.match(archive.content, /Your full LinkedIn ZIP builds your profile and brings your connections\. Connections-only ZIP or CSV also works\./)
  assert.match(archive.content, /up to 32 MB/)
  assert.match(archive.content, /href="\/profile">Skip for now/)
  const uploadForm = archive.content.match(/<form id="onboarding-upload"[^>]*>(.*?)<\/form>/s)[1]
  assert.deepEqual([...uploadForm.matchAll(/name="([^"]+)"/g)].map(match => match[1]), ['csrf', 'archive'])
  assert.match(uploadForm, /<button[^>]*>Import my file<\/button><p class="small">By importing,/)
  const own = renderOwnProfile(account)
  assert.equal(own.title, "Here's your profile")
  assert.match(own.content, /Built from your file\. Fix anything later\./)
  assert.match(own.content, /class="button" href="\/network">Looks good<\/a>/)
  const people = renderPeople({ ...account, state: 'welcome', own: [] })
  assert.match(people.content, /You're in\. The people you know, ready to search\./)
  assert.match(people.content, /placeholder="Search people, roles, companies"/)
  for (const view of [renderJoin({ ...account, signedIn: true }), archive, own, people, renderSettings(account), renderImporting(account)]) {
    const header = view.content.match(/<header>(.*?)<\/header>/s)[1]
    assert.match(header, /href="https:\/\/www\.unlinked\.ai\/"/)
    assert.match(header, /href="\/network">People/)
    assert.match(header, /href="\/profile">My profile/)
    assert.match(header, /href="\/settings">Settings/)
    assert.match(header, /href="https:\/\/www\.unlinked\.ai\/meet" target="_blank" rel="noopener noreferrer"/)
  }
  const importing = renderImporting({ ...account, importJob: { status: 'indexing', profileReady: true } })
  assert.match(importing.content, /Your profile is ready as soon as your file is read\./)
  assert.match(importing.content, /You can leave this page\. The import keeps running\./)
  assert.match(importing.content, /href="\/profile">See your profile/)
  assert.doesNotMatch(renderImporting({ ...account, importJob: { status: 'parsing' } }).content, /See your profile/)
})

test('People has one shared header search, preserving its action, fields and escaped query', () => {
  const query = '<"climate&>'
  for (const props of [{}, { state: 'welcome', own: [{ name: 'Avery Lee' }] }, { query, own: [] }, { state: 'error' }]) {
    const view = renderPeople({ ...account, ...props })
    const forms = [...view.content.matchAll(/<form\b[^>]*action="\/search-account"[^>]*>.*?<\/form>/gs)]
    assert.equal(forms.length, 1)
    const header = view.content.match(/<header>(.*?)<\/header>/s)[1]
    assert.ok(header.includes(forms[0][0]))
    assert.match(forms[0][0], /method="post" action="\/search-account" role="search"/)
    assert.match(forms[0][0], /name="csrf" value="csrf-value"/)
    assert.match(forms[0][0], /name="query" type="search"/)
    assert.equal([...view.content.matchAll(/<input\b[^>]*type="(?:search|text)"/g)].length, 1)
    assert.doesNotMatch(view.content, /Ask your network|Search my people|Filter by name or company|name="q"|method="get" action="\/network"/)
    const journey = view.content.match(/<section class="journey">(.*?)<\/section>/s)[1]
    assert.doesNotMatch(journey, /<form|<input/)
    if (props.query) assert.match(header, /value="&lt;&quot;climate&amp;&gt;"/)
  }
})

test('People distinguishes empty own browsing, own no-match results and absent imports', () => {
  const empty = renderPeople({ ...account, own: [], query: '' })
  assert.match(empty.content, /Bring your LinkedIn export to see your people\./)
  assert.match(empty.content, /href="\/">Add a file →/)
  assert.doesNotMatch(empty.content, /No people matched/)
  const noMatch = renderPeople({ ...account, own: [], query: 'ocean logistics' })
  assert.match(noMatch.content, /No people matched\. Try another name or company\./)
  assert.doesNotMatch(noMatch.content, /Bring your LinkedIn export/)
  assert.match(noMatch.content, /Friends come soon\./)
  for (const query of ['', 'climate']) {
    const absent = renderPeople({ ...account, query })
    assert.doesNotMatch(absent.content, /People you know|Bring your LinkedIn export|No people matched/)
  }
  const contacts = [{ name: 'Avery Lee' }]
  assert.match(renderPeople({ ...account, own: contacts }).content, /Avery Lee/)
  assert.doesNotMatch(renderPeople({ ...account, own: contacts }).content, /No people matched|Bring your LinkedIn export/)
})

test('signed-out Join header keeps logo and Meet without member navigation or session controls', () => {
  for (const props of [{}, { ...account, signedIn: false }]) {
    const view = renderJoin(props)
    const header = view.content.match(/<header>(.*?)<\/header>/s)[1]
    assert.deepEqual([...header.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]), ['https://www.unlinked.ai/', 'https://www.unlinked.ai/meet'])
    assert.doesNotMatch(header, /href="\/(?:network|profile|settings)"|<form|<input/)
    assert.doesNotMatch(view.content, /action="\/logout"|Signed in as/)
  }
})

test('Join and Bring-export offer one quiet LinkedIn export link with safe outbound attributes', () => {
  for (const view of [renderJoin(), renderBringArchive(account), renderBringArchive({ ...account, state: 'error' })]) {
    const links = [...view.content.matchAll(/<a\b[^>]*href="https:\/\/www\.linkedin\.com\/mypreferences\/d\/download-my-data"[^>]*>.*?<\/a>/gs)]
    assert.equal(links.length, 1)
    assert.match(links[0][0], /target="_blank"/)
    assert.match(links[0][0], /rel="noopener noreferrer"/)
    assert.match(links[0][0], />Don't have your LinkedIn export yet\? Request it now ↗<\/a>/)
    assert.doesNotMatch(links[0][0], /class="button/)
    assert.match(view.content, /<p class="small">It takes LinkedIn a few minutes for Connections, up to a day for the complete archive\. Sign up while you wait\.<\/p>/)
  }
  assert.doesNotMatch(renderJoin({ ...account, signedIn: true }).content, /download-my-data/)
  assert.match(renderBringArchive(account).content, /<details><summary>Don’t have your export yet\?<\/summary><ol><li>Open LinkedIn’s data download settings/)
})

test('own-profile lookup is optional and uses a separate native POST with the existing CSRF token', () => {
  assert.doesNotMatch(renderOwnProfile(account).content, /Find yourself on Unlinked|name="linkedinUrl"|Is this you\?|Yes, that's me/)
  const view = renderOwnProfile({ ...account, linkedinLookup: { action: '/find-me' }, contacts: [{ name: 'Avery Lee' }] })
  const form = view.content.match(/<form class="linkedin-lookup"[^>]*>(.*?)<\/form>/s)[0]
  assert.match(form, /method="post" action="\/find-me"/)
  assert.deepEqual([...form.matchAll(/name="([^"]+)"/g)].map(match => match[1]), ['csrf', 'linkedinUrl'])
  assert.match(form, /name="csrf" value="csrf-value"/)
  assert.match(form, /Find yourself on Unlinked/)
  assert.match(form, /Your LinkedIn address/)
  assert.match(form, /placeholder="linkedin.com\/in\/your-name"/)
  assert.match(form, /class="quiet" type="submit">Find me/)
  assert.match(form, /Shows what Unlinked already knows about you: your old profile and members who list you\. Nothing is claimed until you confirm\./)
  assert.doesNotMatch(form, /required|<script|Import from LinkedIn/i)
  assert.ok(view.content.indexOf(form) > view.content.indexOf('Editing comes soon.'))
  assert.ok(view.content.indexOf(form) < view.content.indexOf('People from your file'))
  assert.doesNotMatch(renderOwnProfile({ ...account, linkedinLookup: { action: '/find-me' }, lookupResult: { status: 'none', claimAction: '/claim-me' } }).content, /Is this you\?|Yes, that's me/)
})

test('found lookup results render escaped information and an explicit native claim confirmation', () => {
  const view = renderOwnProfile({ ...account, csrf: 'csrf-"<&', lookupResult: { status: 'found', profileName: '<script>name</script>', headline: '<img src=x>', listedBy: 1234, claimAction: '/claim-me?match="<sam>&source=old' } })
  const card = view.content.match(/<div class="panel lookup-result">(.*?)<\/form><\/div>/s)[0]
  assert.match(card, /Is this you\?/)
  assert.match(card, /&lt;script&gt;name&lt;\/script&gt;/)
  assert.match(card, /&lt;img src=x&gt;/)
  assert.match(card, /Listed by 1,234 members/)
  assert.match(card, /method="post" action="\/claim-me\?match=&quot;&lt;sam&gt;&amp;source=old"/)
  assert.match(card, /name="csrf" value="csrf-&quot;&lt;&amp;"/)
  assert.deepEqual([...card.matchAll(/name="([^"]+)"/g)].map(match => match[1]), ['csrf'])
  assert.match(card, /type="submit">Yes, that's me/)
  assert.match(card, /href="\/profile">Not me/)
  assert.doesNotMatch(card, /<script|<img|onclick=|onsubmit=/)
  const oneMember = renderOwnProfile({ ...account, lookupResult: { status: 'found', listedBy: 1, claimAction: '/claim-me' } })
  assert.match(oneMember.content, /Listed by 1 member<\/p>/)
})

test('lookup and claim forms reject actions that could send CSRF tokens off-host', () => {
  for (const action of ['https://evil.test/find-me', '//evil.test/find-me', 'javascript:alert(1)', '/\\evil.test', '/find-me\n', '/find-me\u0000', '/find-me#fragment', undefined]) {
    const view = renderOwnProfile({ ...account, linkedinLookup: { action }, lookupResult: { status: 'found', profileName: 'Sam', claimAction: action } })
    assert.doesNotMatch(view.content, /class="linkedin-lookup"|class="panel lookup-result"|name="linkedinUrl"/)
  }
  const view = renderOwnProfile({ ...account, linkedinLookup: { action: '/find-me?from="profile"&mode=lookup' } })
  assert.match(view.content, /action="\/find-me\?from=&quot;profile&quot;&amp;mode=lookup"/)
})

test('People header defaults to everyone without own and offers native scope toggles with own', () => {
  const defaultHeader = renderPeople({ ...account, scope: 'own', everyone: [] }).content.match(/<header>(.*?)<\/header>/s)[1]
  assert.match(defaultHeader, /type="hidden" name="scope" value="everyone"/)
  assert.doesNotMatch(defaultHeader, /name="scope" value="own"|class="scope-controls"/)
  for (const scope of ['everyone', 'own']) {
    const header = renderPeople({ ...account, scope, everyone: [], own: [] }).content.match(/<header>(.*?)<\/header>/s)[1]
    assert.match(header, new RegExp(`type="hidden" name="scope" value="${scope}"`))
    assert.match(header, /method="post" action="\/search-account" role="search"/)
    assert.match(header, /name="csrf" value="csrf-value"/)
    assert.match(header, /name="query" type="search"/)
    assert.match(header, /type="submit" name="scope" value="everyone"[^>]*formnovalidate>Everyone/)
    assert.match(header, /type="submit" name="scope" value="own"[^>]*formnovalidate>My people/)
    assert.match(header, new RegExp(`name="scope" value="${scope}" aria-pressed="true"`))
    assert.equal([...header.matchAll(/<input\b[^>]*type="search"/g)].length, 1)
    assert.doesNotMatch(header, /<script|onclick=|onsubmit=/)
  }
})

test('everyone rows use only member fields and encoded original profile ids', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  const view = renderPeople({ ...account, everyone: [{ id, name: 'Maya Chen', headline: 'Climate lead', company: 'Harbor', location: 'Portland', listedBy: 8, isMember: true, mutuals: 'secret-mutuals', linkedinUrl: 'https://www.linkedin.com/in/maya', reason: 'secret-reason' }] })
  const group = view.content.match(/<section class="everyone-group"[^>]*>(.*?)<\/section>/s)[1]
  assert.match(group, /Everyone on Unlinked/)
  assert.match(group, /class="initials" aria-hidden="true">MC/)
  assert.match(group, new RegExp(`href="/people/${id}">Maya Chen`))
  assert.match(group, /Climate lead · Harbor/)
  assert.match(group, /<p class="small">Portland<\/p>/)
  assert.doesNotMatch(group, /Listed by|isMember|secret-mutuals|secret-reason|LinkedIn|linkedin\.com/)
  assert.doesNotMatch(view.content, /People you know|class="own-group"/)

  const attack = '<script>alert("bad")</script>'
  const escaped = renderPeople({ ...account, everyone: [{ id: 'uuid/"<&', name: attack, headline: attack, company: attack, location: attack }] }).content
  assert.match(escaped, /href="\/people\/uuid%2F%22%3C%26"/)
  assert.match(escaped, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/)
  assert.doesNotMatch(escaped, /<script>|onclick=/)
  assert.match(renderPeople({ ...account, everyone: [{ id, name: 'Maya Chen' }] }).content, /Maya Chen/)
})

test('People renders own contacts and reasons before everyone without inventing membership', () => {
  const view = renderPeople({ ...account, own: [{ name: 'Avery Lee', reason: 'Worked together & introduced partners', linkedinUrl: 'https://www.linkedin.com/in/avery' }], everyone: [{ id: '123e4567-e89b-42d3-a456-426614174000', name: 'Maya Chen' }] })
  assert.ok(view.content.indexOf('People you know') < view.content.indexOf('Everyone on Unlinked'))
  const ownGroup = view.content.match(/<section class="own-group"[^>]*>(.*?)<\/section>/s)[1]
  assert.match(ownGroup, /Avery Lee/)
  assert.match(ownGroup, /Worked together &amp; introduced partners/)
  assert.match(ownGroup, /LinkedIn profile ↗/)
  assert.doesNotMatch(ownGroup, /href="\/people\//)
  assert.match(view.content, /Friends come soon\./)
  assert.doesNotMatch(view.content, /Friends and member search come soon/)
})

test('everyone unavailable, empty browse and empty search have distinct copy', () => {
  const cases = [
    [{ state: 'unavailable', query: 'climate', everyone: [{ id: 'ignored', name: 'Hidden stale member' }] }, 'Member search is on its way.'],
    [{ state: 'ready', query: 'climate', everyone: [] }, 'No one on Unlinked matched that yet.'],
    [{ state: 'ready', query: '', everyone: [] }, 'No members to show yet.'],
  ]
  for (const [props, message] of cases) {
    const group = renderPeople({ ...account, ...props }).content.match(/<section class="everyone-group"[^>]*>(.*?)<\/section>/s)[1]
    assert.ok(group.includes(message))
    assert.doesNotMatch(group, /<article|Hidden stale member/)
    for (const other of cases.map(([, copy]) => copy).filter(copy => copy !== message)) assert.ok(!group.includes(other))
  }
})

test('Show more is a native GET link with encoded query and cursor, omitting empty q', () => {
  const view = renderPeople({ ...account, query: 'climate & energy', nextCursor: 'page/2?after=Sam+Rivera&x="<' })
  assert.match(view.content, /href="\/network\?q=climate%20%26%20energy&amp;cursor=page%2F2%3Fafter%3DSam%2BRivera%26x%3D%22%3C">Show more<\/a>/)
  assert.match(renderPeople({ ...account, query: '', nextCursor: 'next/2' }).content, /href="\/network\?cursor=next%2F2">Show more<\/a>/)
  assert.doesNotMatch(renderPeople(account).content, /Show more/)
  assert.doesNotMatch(renderPeople({ ...account, nextCursor: '' }).content, /Show more/)
})

test('member copy avoids forbidden technical and legacy words outside Settings details', () => {
  const imports = [{ id: 'fixture', filename: 'Fictional.zip', accepted: 1005, indexed: 1005, status: 'indexed', sha256: 'a'.repeat(64) }]
  const views = [renderJoin(), renderBringArchive(account), renderBringArchive({ ...account, state: 'error' }), renderImporting(account), renderOwnProfile(account), renderPeople(account), renderSettings({ ...account, imports })]
  const forbidden = /observations|parser records|durable receipt|SHA-256|Ideaflow ID|invitation|private pilot|no feed/i
  for (const view of views) {
    const outsideDetails = view.content.replace(/<details\b[^>]*>.*?<\/details>/gs, '')
    assert.doesNotMatch(outsideDetails, forbidden)
    if (view.title !== 'Settings') assert.doesNotMatch(view.content, forbidden)
    assert.doesNotMatch(view.content, /<script|onclick=|onsubmit=/)
  }
  const settings = views.at(-1)
  assert.match(settings.content, /<details>.*records accepted.*SHA-256.*<\/details>/s)
  assert.match(settings.content, /<h2>Your agent<\/h2>/)
})

test('only HTTPS LinkedIn profile links are exposed, with safe outbound attributes', () => {
  for (const url of ['javascript:alert(1)', 'http://www.linkedin.com/in/test', 'https://linkedin.com.evil.test/in/test', 'https://attacker@linkedin.com/in/test', 'https://evil.test/']) {
    assert.doesNotMatch(renderPeople({ ...account, own: [{ name: 'Test', linkedinUrl: url }] }).content, /LinkedIn profile ↗/)
  }
  const view = renderPeople({ ...account, own: [{ name: 'Test', linkedinUrl: 'https://www.linkedin.com/in/test?q=a&b=c' }] })
  assert.match(view.content, /href="https:\/\/www.linkedin.com\/in\/test\?q=a&amp;b=c" target="_blank" rel="noopener noreferrer"/)
})

test('unimplemented editing, public discovery and removal are stated truthfully', () => {
  assert.match(renderOwnProfile(account).content, /Editing comes soon/)
  assert.match(renderPeople(account).content, /Friends come soon/)
  assert.match(renderSettings(account).content, /Permanent removal and data export are not available/)
  assert.match(renderPeople({ ...account, state: 'error' }).content, /does not mean your network is empty/)
  assert.match(renderJoin().content, /href="\/login"/)
})

test('progress enhancement is separate from HTML and preserves native submission', () => {
  let submit
  const button = { disabled: false, textContent: 'Import my file' }
  const progress = { hidden: true }
  const form = { reportValidity: () => true, addEventListener: (event, handler) => { assert.equal(event, 'submit'); submit = handler } }
  vm.runInNewContext(uploadProgressScript(), { document: { getElementById: id => ({ 'onboarding-upload': form, 'onboarding-import': button, 'onboarding-progress': progress }[id]) } })
  submit({ preventDefault: () => assert.fail('must preserve native submission') })
  assert.equal(button.disabled, true)
  assert.equal(button.textContent, 'Importing…')
  assert.equal(progress.hidden, false)
  assert.doesNotMatch(renderBringArchive(account).content, /<script|onsubmit=|onclick=/)
})

test('agent copy enhancement is nonce-ready, copies exact setup and selects it on failure', async () => {
  for (const fails of [false, true]) {
    let click
    let focused = false
    let selected = false
    const configuration = { value: '{"token":"fictional"}', focus: () => { focused = true }, select: () => { selected = true } }
    const button = { addEventListener: (event, handler) => { assert.equal(event, 'click'); click = handler } }
    const help = { textContent: '' }
    vm.runInNewContext(agentSetupCopyScript(), { document: { getElementById: id => ({ 'onboarding-copy-agent': button, 'onboarding-agent-configuration': configuration, 'onboarding-copy-help': help }[id]) }, navigator: { clipboard: { writeText: async value => { assert.equal(value, configuration.value); if (fails) throw new Error('clipboard denied') } } } })
    await click()
    assert.equal(focused, true)
    assert.equal(selected, true)
    assert.equal(help.textContent, fails ? 'Setup selected. Copy it from the field above.' : 'Agent setup copied.')
  }
  vm.runInNewContext(agentSetupCopyScript(), { document: { getElementById: () => null } })
  const view = renderSettings({ ...account, agentConfiguration: { example: 'fictional' }, grants: [{ id: 'grant' }] })
  assert.match(view.content, /<textarea id="onboarding-agent-configuration" readonly/)
  assert.match(view.content, /type="button"[^>]*>Copy agent setup/)
  assert.match(view.content, /select and copy the setup above/)
  assert.match(view.content, /method="post" action="\/setup-account"/)
  assert.match(view.content, /method="post" action="\/revoke-account"/)
  assert.match(view.content, /name="grantId" value="grant"/)
  assert.doesNotMatch(view.content, /<script|onclick=/)
})

test('fixture previews cover every requested screen and are reproducible without scripts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unlinked-onboarding-test-'))
  try {
    const files = await buildPreviews(directory)
    assert.equal(files.length, 15)
    const first = await Promise.all(files.map(file => readFile(file, 'utf8')))
    await buildPreviews(directory)
    const second = await Promise.all(files.map(file => readFile(file, 'utf8')))
    assert.deepEqual(second, first)
    for (const content of first) {
      assert.match(content, /^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>/)
      assert.match(content, /<body><main><h1>.*?<\/h1><style>/s)
      assert.doesNotMatch(content, /<script|type="checkbox"|observations|parser records|durable receipt|Ideaflow ID|invitation|private pilot/i)
    }
    const own = first[files.findIndex(file => file.endsWith('/own-profile-importing.html'))]
    assert.equal((own.match(/<article class="person"><div>/g) || []).length, 3)
    assert.equal((own.match(/class="tag"/g) || []).length, 6)
    assert.equal((own.match(/class="initials"/g) || []).length, 8)
    assert.match(own, /Westhaven University/)
    assert.match(own, /Importing · 41% · 412 of 1,005 records/)
    const settings = first[files.findIndex(file => file.endsWith('/settings.html'))]
    assert.equal((settings.match(/action="\/revoke-account"/g) || []).length, 1)
    assert.match(settings, /fictional_fixture_not_a_credential/)
    for (const file of ['people-welcome.html', 'people-empty.html', 'people-no-match.html']) {
      const content = first[files.findIndex(path => path.endsWith('/' + file))]
      assert.equal([...content.matchAll(/<input\b[^>]*type="(?:search|text)"/g)].length, 1)
    }
    assert.match(first[files.findIndex(file => file.endsWith('/people-empty.html'))], /Bring your LinkedIn export to see your people\./)
    assert.match(first[files.findIndex(file => file.endsWith('/people-no-match.html'))], /No people matched\. Try another name or company\./)
    const everyoneDefault = first[files.findIndex(file => file.endsWith('/everyone-default.html'))]
    assert.match(everyoneDefault, /href="\/people\/00000000-0000-4000-8000-000000000001"/)
    assert.doesNotMatch(everyoneDefault, /class="own-group"|class="scope-controls"/)
    assert.match(first[files.findIndex(file => file.endsWith('/people-both-groups.html'))], /name="scope" value="own" aria-pressed="true"/)
    assert.match(first[files.findIndex(file => file.endsWith('/everyone-unavailable.html'))], /Member search is on its way\./)
    assert.match(first[files.findIndex(file => file.endsWith('/everyone-no-match.html'))], /No one on Unlinked matched that yet\./)
    const joinHeader = first[files.findIndex(file => file.endsWith('/join.html'))].match(/<header>(.*?)<\/header>/s)[1]
    assert.doesNotMatch(joinHeader, /href="\/(?:network|profile|settings)"/)
    const lookup = first[files.findIndex(file => file.endsWith('/own-profile-lookup-found.html'))]
    assert.match(lookup, /method="post" action="\/find-me"/)
    assert.match(lookup, /Is this you\?/)
    assert.match(lookup, /Listed by 3 members/)
    assert.match(lookup, /method="post" action="\/claim-me\?match=fictional-sam"/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
