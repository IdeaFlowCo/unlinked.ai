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
    renderPeople({ ...account, query: attack, contacts: [{ name: attack, reason: attack }] }),
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
  const people = renderPeople({ ...account, state: 'welcome' })
  assert.match(people.content, /You're in\. The people you know, ready to search\./)
  assert.match(people.content, /placeholder="Search people, roles, companies"/)
  for (const view of [join, archive, own, people, renderSettings(account), renderImporting(account)]) {
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
    assert.doesNotMatch(renderPeople({ ...account, contacts: [{ name: 'Test', linkedinUrl: url }] }).content, /LinkedIn profile ↗/)
  }
  const view = renderPeople({ ...account, contacts: [{ name: 'Test', linkedinUrl: 'https://www.linkedin.com/in/test?q=a&b=c' }] })
  assert.match(view.content, /href="https:\/\/www.linkedin.com\/in\/test\?q=a&amp;b=c" target="_blank" rel="noopener noreferrer"/)
})

test('unimplemented editing, public discovery and removal are stated truthfully', () => {
  assert.match(renderOwnProfile(account).content, /Editing comes soon/)
  assert.match(renderPeople(account).content, /Friends and member search come soon/)
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
    assert.equal(files.length, 9)
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
