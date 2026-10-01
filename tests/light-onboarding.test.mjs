import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { renderJoin, renderBringArchive, renderOwnProfile, renderPeople, renderSettings, renderImporting, uploadProgressScript } from '../mcp-server/private-onboarding-views.mjs'

const account = { accountLabel: 'Test person', csrf: 'csrf-value' }

test('production upload uses only native archive and csrf fields, without consent checkbox', () => {
  const view = renderBringArchive(account)
  assert.match(view.content, /method="post" action="\/upload" enctype="multipart\/form-data"/)
  assert.match(view.content, /name="archive"/)
  assert.match(view.content, /name="csrf" value="csrf-value"/)
  assert.match(view.content, /Your professional profile and connections become searchable on Unlinked and by agents you connect; OpenAI receives search queries and relevant professional details, while contact details stay private\./)
  assert.match(renderSettings(account).content, /archive and imported observations are retained privately/)
  assert.match(renderSettings(account).content, /Browser searches and searches by scoped agents.*search queries.*OpenAI at query time/)
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
  const importJob = { id: 'job', status: 'indexing', processed: 12, total: 20, profileReady: true }
  for (const render of [renderBringArchive, renderOwnProfile, renderPeople, renderSettings, renderImporting, props => renderJoin({ ...props, signedIn: true })]) {
    const view = render({ ...account, importJob })
    assert.match(view.content, /role="search"/)
    assert.match(view.content, /action="\/search-account"/)
    assert.match(view.content, /name="csrf" value="csrf-value"/)
    assert.match(view.content, /action="\/logout"/)
    assert.match(view.content, /Signed in as Test person/)
    assert.match(view.content, /12 of 20 records read/)
    assert.match(view.content, /Your profile is ready; connections are still being processed/)
    assert.doesNotMatch(view.content.match(/<aside class="import-status"[^>]*>(.*?)<\/aside>/s)[1], /searchable/)
  }
  assert.doesNotMatch(renderJoin({ ...account, importJob }).content, /role="search"|action="\/logout"|class="import-status"/)
  for (const [status, title, body] of [
    ['failed', 'Import could not finish', /Your file could not be imported/],
    ['partial', 'Import needs attention', /did not finish completely/],
    ['indexed', 'Import ready', /Open People to search your connections/],
  ]) {
    const view = renderImporting({ ...account, importJob: { ...importJob, status, errorMessage: status === 'failed' ? '<Invalid archive>' : undefined } })
    assert.equal(view.title, title)
    assert.match(view.content, body)
    assert.doesNotMatch(view.content, /<progress|continue when your file is ready|Reading your profile and connections/)
    if (status === 'failed') assert.match(view.content, /&lt;Invalid archive&gt;/)
  }
  assert.doesNotMatch(renderPeople({ ...account, importJob: { ...importJob, total: null } }).content, /of .*records read/)
  assert.match(renderPeople({ ...account, importJob: { ...importJob, status: 'failed' } }).content, /Import could not finish/)
  assert.match(renderPeople({ ...account, importJob: { ...importJob, status: 'indexed' } }).content, /Import ready/)
})

test('unimplemented editing, public discovery and removal are stated truthfully', () => {
  assert.match(renderOwnProfile(account).content, /Profile editing is not available yet/)
  assert.match(renderPeople(account).content, /Shared-member discovery and friends are not available yet/)
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
