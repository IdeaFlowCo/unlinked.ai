import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { privateId } from '../src/utils/private-import/job.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Save the actual HTTP document for optional visual review of synthetic fixtures.
async function profileEvidence(name, document) {
  if (process.env.UNLINKED_PROFILE_TEST_EVIDENCE) await writeFile(join(process.env.UNLINKED_PROFILE_TEST_EVIDENCE, name), document)
}

const header = 'First Name,Last Name,URL,Company,Position\n'

function harness(t, overrides = {}) {
  const owner = { ownerId: 'synthetic-card-owner', userId: 'synthetic-card-user' }
  const resources = new Map(), snapshot = { current: null }
  const backend = {
    adapter: { withImport: async (caller, id, work) => work({
      getJob: async () => resources.get(id)?.payload,
      putAsset: async () => {},
      publicationStatus: 'indexed',
      saveJob: async job => resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, deleted: false, payload: structuredClone(job) }),
      publish: async (job, assertions) => {
        job.assertionIds = assertions.map(x => x.id)
        for (const row of assertions) resources.set(row.id, { type: 'assertion', sourceId: row.id, sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false, payload: structuredClone(row) })
        resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, deleted: false, payload: structuredClone(job) })
      },
    }) },
    readResource: async (_type, id) => { const value = resources.get(id); return value ? structuredClone(value) : null },
    writeResource: async value => { const stored = { ...value }; delete stored.expectedRevision; resources.set(value.sourceId, structuredClone(stored)) },
    listImportIds: async () => [...resources.values()].filter(x => x.type === 'import' && !x.deleted && x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf).map(x => x.sourceId),
    listImportJobIds: async () => [...resources.values()].filter(x => x.type === 'import' && !x.deleted && x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf).map(x => x.sourceId),
    listAccountGrantIds: async () => [],
    ...overrides.backend,
  }
  return { owner, resources, snapshot, backend, async start() {
    let handler
    const server = createServer((req, res) => void handler(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
    const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
    handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
      login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
        finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'card-subject', displayName: 'Card Owner' }) },
      resolveOwner: async () => owner, signup: async () => owner,
      getBackend: async value => { assert.deepEqual(value, owner); return backend },
      complete: async () => ({ matches: [] }),
      ownProfileId: overrides.ownProfileId, signupLookup: overrides.signupLookup,
      lookupCompanyFacts: overrides.lookupCompanyFacts,
      issueAccountGrant: async () => ({ accessToken: 'synthetic' }), revokeAccountGrant: async () => {},
      readPublishedSnapshot: async () => { if (!snapshot.current) throw new Error('unavailable'); return snapshot.current },
      mcpEndpoint: `${baseUrl}/mcp` })
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=x`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(endpoint, { headers: { Cookie: cookie } })).text()
    return { endpoint, baseUrl, cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] }
  } }
}

test('the card page is owner-only, linked from the profile, and shows a decodable QR only for a verified public target', async t => {
  const fixture = harness(t)
  const signed = await fixture.start()

  // Owner-only: no session, no card.
  assert.equal((await fetch(`${signed.endpoint}/card`)).status, 401)

  // Signed in without any public presence: a card without a QR, and no notice of anyone else's data.
  let page = await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })
  assert.equal(page.status, 200)
  let html = await page.text()
  assert.match(html, /Card Owner/)
  assert.doesNotMatch(html, /aria-label="QR code opening/)
  assert.match(html, /QR code appears once your profile is published/)

  // The profile page offers the card.
  assert.match(await (await fetch(`${signed.endpoint}/profile`, { headers: { Cookie: signed.cookie } })).text(), /href="\/card"/)

  // Upload, then mark the import public and publish its projection id in the snapshot.
  const csv = header + 'Ada,Lovelace,https://www.linkedin.com/in/synthetic-ada,Analytical,Engineer\n'
  const form = new FormData(); form.set('csrf', signed.csrf); form.set('syntheticConsent', 'yes'); form.set('archive', new Blob([csv]), 'Connections.csv')
  assert.equal((await fetch(`${signed.endpoint}/upload`, { method: 'POST', redirect: 'manual', headers: { Cookie: signed.cookie, Origin: signed.baseUrl }, body: form })).status, 303)
  const job = [...fixture.resources.values()].find(x => x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf)
  job.payload.consent = { ...PUBLIC_UPLOAD_CONSENT }
  const publicId = `member-import-${job.sourceId}`

  // Public id not yet in the published snapshot: still no QR — never a dead or private target.
  html = await (await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })).text()
  assert.doesNotMatch(html, /aria-label="QR code opening/)

  fixture.snapshot.current = { state: 'published', complete: true, revision: 'card-test-v1', profiles: [{ id: publicId, name: 'Card Owner', positions: [], education: [], skills: [] }], connections: [] }
  page = await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })
  assert.equal(page.status, 200)
  html = await page.text()
  const cardUrl = `${signed.baseUrl}/people/${encodeURIComponent(publicId)}`
  assert.ok(html.includes(`<code>${cardUrl.replace(/&/g, '&amp;')}</code>`), 'shows the exact encoded URL')
  assert.match(html, /<svg[^>]*aria-label="QR code opening /)
  assert.doesNotMatch(html, /src="data:|url\(data:/)
  // No contact channels on the card page (phone stays opt-in and unshipped).
  assert.doesNotMatch(html, /mailto:|tel:/)
  assert.match(html, /no phone number, email address/)
  // CSP stays locked down; the QR is inline SVG, not an image fetch.
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)

  // The decoded QR content equals the public profile URL.
  const { qrMatrix } = await import('../src/utils/qr-code.mjs')
  const svgPath = html.match(/<path d="([^"]+)" fill="#16181d"/)[1]
  assert.equal(svgPath, (() => { // same deterministic rendering as qrSvg
    const matrix = qrMatrix(cardUrl)
    let path = ''
    for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) path += `M${x + 4} ${y + 4}h1v1h-1z`
    return path
  })())

  // A newer public-consent import that is not (or cannot be) in the published
  // snapshot never hides the older live profile: the card falls back to it.
  const newerId = 'f'.repeat(64)
  fixture.resources.set(newerId, { type: 'import', sourceId: newerId, sourceOwnerId: fixture.owner.ownerId, sourceRevision: 1, deleted: false,
    payload: { id: newerId, ownerId: fixture.owner.ownerId, filename: 'Newer.csv', archiveSha256: 'e'.repeat(64), status: 'partial', createdAt: Date.now() + 60000, backgroundVersion: 'profile-first-v1', counts: { accepted: 2, indexed: 1 }, consent: { ...PUBLIC_UPLOAD_CONSENT } } })
  html = await (await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })).text()
  assert.ok(html.includes(`<code>${cardUrl.replace(/&/g, '&amp;')}</code>`), 'older published profile still on the card')
  fixture.resources.delete(newerId)

  // A confirmed legacy profile takes priority as the stable card target.
  fixture.backend.readLegacyProfile = async () => ({ profileId: 'legacy-profile-uuid', profile: { name: 'Card Owner' } })
  fixture.snapshot.current = { ...fixture.snapshot.current, profiles: [...fixture.snapshot.current.profiles, { id: 'legacy-profile-uuid', name: 'Card Owner', positions: [], education: [], skills: [] }] }
  html = await (await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })).text()
  assert.match(html, /\/people\/legacy-profile-uuid/)

  // Sign-in can return to the card page.
  assert.equal((await fetch(`${signed.endpoint}/card?x=1`, { redirect: 'manual' })).status, 401)
  const signIn = await (await fetch(`${signed.endpoint}/card`)).text()
  assert.match(signIn, /href="\/login\?next=%2Fcard"/)
})

test('the search bar QR button opens a scan sheet: Scan for anyone, My card for the signed-in member', async t => {
  const fixture = harness(t)
  const signed = await fixture.start()

  // Signed out: scanning works (it only ever opens public pages); My card offers sign-in.
  let page = await fetch(`${signed.endpoint}/scan`)
  assert.equal(page.status, 200)
  let html = await page.text()
  const csp = page.headers.get('content-security-policy')
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/); assert.match(csp, /img-src 'self' blob:; media-src 'self' blob:/); assert.match(csp, /default-src 'none'/)
  assert.equal(page.headers.get('permissions-policy'), 'camera=(self), microphone=(self)')
  assert.match(html, /role="tablist"/)
  assert.match(html, /<a role="tab" id="tab-scan" href="\/scan" aria-controls="panel-scan" aria-selected="true">Scan<\/a>/)
  assert.match(html, /<a role="tab" id="tab-card" href="\/scan\?tab=card" aria-controls="panel-card" aria-selected="false" tabindex="-1">My card<\/a>/)
  for (const id of ['camera', 'start', 'stop', 'confirm', 'confirm-label', 'confirm-open', 'confirm-cancel', 'paste', 'card-url', 'status']) assert.match(html, new RegExp(`id="${id}"`), id)
  assert.match(html, /src="\/public-assets\/jsqr\.js"/); assert.match(html, /classifyMeetCode/)
  assert.match(html, /href="\/login\?next=%2Fcard">Sign in to show your card/)
  assert.doesNotMatch(html, /name="csrf"|action="\/logout"|aria-label="QR code opening/)
  assert.match((await (await fetch(`${signed.endpoint}/scan?tab=card`)).text()), /id="panel-scan" aria-labelledby="tab-scan" hidden>/)

  // Signed in: the My card tab carries the member's own QR and links to the full card and profile.
  const csv = header + 'Ada,Lovelace,https://www.linkedin.com/in/synthetic-ada,Analytical,Engineer\n'
  const form = new FormData(); form.set('csrf', signed.csrf); form.set('syntheticConsent', 'yes'); form.set('archive', new Blob([csv]), 'Connections.csv')
  assert.equal((await fetch(`${signed.endpoint}/upload`, { method: 'POST', redirect: 'manual', headers: { Cookie: signed.cookie, Origin: signed.baseUrl }, body: form })).status, 303)
  const job = [...fixture.resources.values()].find(x => x.payload?.id === x.sourceId && !x.payload.kind && !x.payload.receiptOf)
  job.payload.consent = { ...PUBLIC_UPLOAD_CONSENT }
  const publicId = `member-import-${job.sourceId}`
  fixture.snapshot.current = { state: 'published', complete: true, revision: 'scan-test-v1', profiles: [{ id: publicId, name: 'Card Owner', positions: [], education: [], skills: [] }], connections: [] }
  page = await fetch(`${signed.endpoint}/scan?tab=card`, { headers: { Cookie: signed.cookie } })
  assert.equal(page.status, 200)
  html = await page.text()
  assert.match(html, /aria-controls="panel-card" aria-selected="true">My card/)
  assert.match(html, /id="panel-card" aria-labelledby="tab-card">/)
  assert.match(html, /<svg[^>]*aria-label="QR code opening /)
  assert.match(html, /<h2 class="bc-name">Card Owner<\/h2>/)
  assert.match(html, /href="\/card">Open full card<\/a><a class="button sec sm" href="\/profile">View profile/)
  assert.match(html, /<details class="me">/)
  assert.doesNotMatch(html, /Sign in to show your card/)
  // Every page, including the static discovery pages, runs the Me-menu script under its nonce.
  for (const path of ['/network', '/agents', '/import-linkedin', '/meet']) {
    const response = await fetch(`${signed.endpoint}${path}`, { headers: { Cookie: signed.cookie } })
    const nonce = response.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1]
    const body = await response.text()
    assert.match(body, /<details class="me">/, path)
    assert.ok(body.includes(`<script nonce="${nonce}">(()=>{const me=document.querySelector('details.me')`), path)
    assert.ok(!body.includes('<!--me-headline-->'), path)
  }
  // The card page's own scan link now leads to the scan sheet.
  assert.match(await (await fetch(`${signed.endpoint}/card`, { headers: { Cookie: signed.cookie } })).text(), /href="\/scan">Scan someone’s card/)
})


test('owner profiles retain upload facts before publication and use older addresses only as fallback', async t => {
  let confirmed = null, fallbackUnavailable = false
  const fixture = harness(t, { ownProfileId: async () => 'confirmed-person', backend: { readLegacyProfile: async () => { if (fallbackUnavailable) throw Error('legacy_profile_source_unavailable'); return confirmed } },
    signupLookup: { read: async () => { if (fallbackUnavailable) throw Error('signup_source_unavailable'); return null } } })
  const signed = await fixture.start(), { owner, resources } = fixture
  const id = 'a'.repeat(64), sourceId = 'b'.repeat(64), rowId = 'profile-row'
  const assertionId = privateId(owner.ownerId, 'assertion', sourceId, rowId), chunkId = privateId(owner.ownerId, 'index-chunk', id, 0)
  const fields = { 'first name': 'Uploaded', 'last name': 'Person', headline: 'New headline', location: 'Boston', industry: 'New research',
    'public profile url': 'https://www.linkedin.com/in/new-upload', email: 'PRIVATE_EMAIL', phone: 'PRIVATE_PHONE', website: 'https://private-card.example.test' }
  resources.set(assertionId, { type: 'assertion', sourceId: assertionId, sourceOwnerId: owner.ownerId, payload: {
    id: assertionId, ownerId: owner.ownerId, importId: id, sourceId, rowId, category: 'profile', fields } })
  resources.set(chunkId, { type: 'import', sourceId: chunkId, sourceOwnerId: owner.ownerId, payload: {
    kind: 'private_observation_chunk', ownerId: owner.ownerId, importId: id, ordinal: 0, indexedCount: 1, assertionIds: [assertionId], profileAssertionIds: [assertionId] } })
  resources.set(id, { type: 'import', sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: 1, payload: {
    id, ownerId: owner.ownerId, filename: 'Archive.zip', archiveSha256: 'e'.repeat(64), createdAt: 100, backgroundVersion: 'profile-first-v1', status: 'indexing',
    progress: { profileReady: true }, stagedChunks: [chunkId], profileChunkCount: 1, counts: { accepted: 10, indexed: 1 }, consent: { ...PUBLIC_UPLOAD_CONSENT } } })
  const page = async () => {
    const response = await fetch(`${signed.endpoint}/profile`, { headers: { Cookie: signed.cookie } })
    assert.equal(response.status, 200)
    return response.text()
  }
  let html = await page()
  assert.match(html, /Boston/); assert.match(html, /New research/); assert.match(html, /href="https:\/\/www.linkedin.com\/in\/new-upload"/)
  assert.doesNotMatch(html, /PRIVATE_EMAIL|PRIVATE_PHONE|private-card.example.test/)
  fixture.snapshot.current = { state: 'published', complete: true, revision: 'older-public-profile', profiles: [{ id: 'confirmed-person', name: 'Older Person',
    headline: 'Old headline', location: 'Old city', industry: 'Old industry', linkedinUrl: 'https://www.linkedin.com/in/older-person', positions: [], education: [], skills: [] }], connections: [] }
  html = await page()
  assert.match(html, /Boston/); assert.match(html, /New research/); assert.match(html, /new-upload/)
  assert.doesNotMatch(html, /Old city|Old industry|older-person/)
  delete fields['public profile url']
  html = await page()
  assert.match(html, /href="https:\/\/www.linkedin.com\/in\/older-person"/); assert.match(html, /Boston/)
  confirmed = { profile: { name: 'Confirmed Person', linkedinUrl: 'https://www.linkedin.com/in/confirmed-person', location: 'Confirmed city' } }
  fixture.snapshot.current = null
  html = await page()
  assert.match(html, /href="https:\/\/www.linkedin.com\/in\/confirmed-person"/); assert.match(html, /Boston/)
  assert.doesNotMatch(html, /Confirmed city/)
  fallbackUnavailable = true
  fields['public profile url'] = 'https://www.linkedin.com/in/new-upload'
  html = await page()
  assert.match(html, /Boston/); assert.match(html, /New research/); assert.match(html, /href="https:\/\/www.linkedin.com\/in\/new-upload"/)
  assert.doesNotMatch(html, /legacy_profile_source_unavailable|signup_source_unavailable|confirmed-person|PRIVATE_EMAIL|PRIVATE_PHONE/)
  await profileEvidence('owner-upload-fallback-unavailable.html', html)
  resources.get(assertionId).sourceOwnerId = 'different-owner'
  const rejected = await fetch(`${signed.endpoint}/profile`, { headers: { Cookie: signed.cookie } })
  assert.equal(rejected.status, 400)
  assert.doesNotMatch(await rejected.text(), /Boston|New research|PRIVATE_EMAIL|PRIVATE_PHONE/)
})

test('professional profile and company links work through anonymous and signed-in HTTP pages without exposing contacts', async t => {
  const company = { name: 'Example Research', industry: 'Research', website: 'https://example.test',
    linkedinUrl: 'https://www.linkedin.com/company/example-research', description: 'A synthetic professional company.' }
  const fixture = harness(t, { lookupCompanyFacts: async name => name === company.name ? company : null })
  const signed = await fixture.start()
  fixture.snapshot.current = { state: 'published', complete: true, revision: 'professional-http-v1', connections: [], profiles: [
    { id: 'professional-person', name: 'Alex Example', headline: 'Research Engineer', location: 'Boston', industry: 'Research',
      company: company.name, linkedinUrl: 'https://www.linkedin.com/in/alex-example', website: 'https://portfolio.example.test',
      about: 'A synthetic profile for professional-link verification.', positions: [{ title: 'Research Engineer', company: company.name, startDate: '2020', endDate: '2025', description: 'Building research tools.' }],
      education: [{ institution: 'Example University', degree: 'BS', startDate: '2016', endDate: '2020' }], skills: ['Research'], email: 'PRIVATE_EMAIL', phone: 'PRIVATE_PHONE' },
    { id: 'missing-links', name: 'No Address Person', positions: [], education: [], skills: [] },
  ] }
  for (const [label, headers] of [['anonymous', {}], ['member', { Cookie: signed.cookie }]]) {
    const response = await fetch(`${signed.endpoint}/people/professional-person`, { headers })
    assert.equal(response.status, 200)
    const document = await response.text()
    assert.match(document, /href="https:\/\/www.linkedin.com\/in\/alex-example" target="_blank" rel="noopener noreferrer"/)
    assert.match(document, /href="https:\/\/portfolio.example.test\/"/)
    assert.match(document, /href="\/companies\/Example%20Research"/)
    for (const fact of ['Boston', 'Research', 'Building research tools.', 'Example University', '2020', '2025']) assert.ok(document.includes(fact))
    assert.doesNotMatch(document, /PRIVATE_EMAIL|PRIVATE_PHONE/)
    await profileEvidence(`professional-person-${label}.html`, document)
  }
  const api = await fetch(`${signed.endpoint}/api/people/professional-person`)
  assert.equal(api.status, 200)
  const data = await api.json()
  assert.equal(data.profile.linkedinUrl, 'https://www.linkedin.com/in/alex-example')
  assert.equal(data.profile.company, company.name)
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_EMAIL|PRIVATE_PHONE/)
  await profileEvidence('professional-person-api.json', JSON.stringify(data, null, 2))
  const response = await fetch(`${signed.endpoint}/companies/${encodeURIComponent(company.name)}`)
  assert.equal(response.status, 200)
  const document = await response.text()
  assert.match(document, /href="https:\/\/example.test\/"/)
  assert.match(document, /href="https:\/\/www.linkedin.com\/company\/example-research"/)
  assert.ok(document.indexOf('Website ↗') < document.indexOf('<h3>About'))
  assert.ok(document.indexOf('LinkedIn page ↗') < document.indexOf('<h3>About'))
  await profileEvidence('professional-company.html', document)
  const missing = await fetch(`${signed.endpoint}/people/missing-links`)
  assert.equal(missing.status, 200)
  const missingDocument = await missing.text()
  assert.doesNotMatch(missingDocument, /LinkedIn profile ↗|Website ↗|https:\/\/www.linkedin.com\/in\//)
  await profileEvidence('person-without-retained-links.html', missingDocument)
})
