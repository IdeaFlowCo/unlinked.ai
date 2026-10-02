import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'

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
