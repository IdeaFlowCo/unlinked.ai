import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createBulkExports } from '../mcp-server/bulk-exports.mjs'

// Exercise the served Settings document and the export destinations, rather
// than inspecting the renderer's source. All identity and data are fictional.
test('Settings offers a restricted alternate viewer beside working owner exports without provisioning access', async t => {
  const owner = { ownerId: 'viewer-test-owner', userId: 'viewer-test-user' }
  const backend = {
    adapter: {}, readResource: async () => null,
    listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [],
    readLegacyProfile: async () => ({
      profileId: 'self', sourceSha256: 'a'.repeat(64), receiptId: 'receipt', revision: 'v1',
      profile: { id: 'self', name: 'Robin Fictional' },
      profiles: [{ id: 'colleague', name: 'Sam Fictional', headline: 'Engineer' }],
      connections: [{ fromId: 'self', toId: 'colleague' }],
    }),
    writeResource: async () => assert.fail('viewing Settings must not write owner data'),
  }
  const getBackend = async bound => { assert.deepEqual(bound, owner); return backend }
  const isVerified = async () => false
  let handler, minted = 0
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({
    baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'private_live', getBackend, isVerified,
    bulkExports: createBulkExports({ getBackend, isVerified }),
    login: {
      begin: async () => ({ location: 'https://identity.invalid/login', transaction: { state: 'test-state' } }),
      finish: async () => ({ issuer: 'https://identity.invalid', subject: 'test-subject', verifiedEmail: 'robin@example.invalid', displayName: 'Robin Fictional' }),
    },
    resolveOwner: async () => owner, signup: async () => owner,
    ensureAccountGrant: async (bound, options) => {
      assert.deepEqual(bound, owner)
      assert.equal(options.mint, false, 'Settings must only read existing access')
      return null
    },
    issueAccountGrant: async () => { minted++; assert.fail('navigation must not mint a credential') },
    revokeAccountGrant: async () => assert.fail('navigation must not revoke access'),
  })
  const request = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const anonymousSettings = await request('/settings')
  assert.equal(anonymousSettings.status, 401)
  const signedOut = await anonymousSettings.text()
  assert.match(signedOut, /Sign in/)
  assert.doesNotMatch(signedOut, /Open Mew Neo4j/)
  for (const path of ['/export', '/downloads/file?scope=mine&format=csv']) {
    const denied = await request(path)
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.get('content-disposition'), null, 'signed-out requests must not download data')
    assert.doesNotMatch(await denied.text(), /Sam Fictional|Robin Fictional/)
  }

  const start = await request('/login')
  const callback = await request('/auth/callback/ideaflow?code=test&state=test-state', {
    headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] },
  })
  assert.equal(callback.status, 303)
  const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session='))?.split(';')[0]
  assert.ok(session, 'successful sign-in returns a browser session')
  const headers = { Cookie: session }
  const profile = await request('/profile', { headers })
  assert.equal(profile.status, 200)
  assert.match(await profile.text(), /<a role="menuitem" href="\/settings">.*?Settings &amp; agent setup<\/a>/)
  const response = await request('/settings', { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-cache')
  const document = await response.text()
  assert.match(document, /<title>Settings · Unlinked<\/title>/)
  assert.match(document, /<meta property="og:title" content="Unlinked">/)
  assert.match(document, /<meta name="twitter:title" content="Unlinked">/)
  const metadata = (document.match(/<meta\b[^>]*>|<title>.*?<\/title>/g) ?? []).join('')
  assert.doesNotMatch(metadata, /robin@example|Robin Fictional/)
  assert.match(document, /<a role="menuitem" href="\/settings">.*?Settings &amp; agent setup<\/a>/)
  assert.match(document, /href="#your-data">Download your data/)
  const yourData = document.match(/<h2 id="your-data">Your data<\/h2>(.*?)<h2 id="delete-account">/s)?.[1]
  assert.ok(yourData, 'viewer is discoverable in the existing Your data section')
  assert.match(yourData, /<h3>Alternate viewer<\/h3>/)
  assert.match(yourData, /Preview/)
  assert.match(yourData, /read-only view/)
  assert.match(yourData, /preview is being prepared and access is restricted/)
  assert.match(yourData, /does not yet include all your Unlinked data/)
  for (const [url, label] of [
    ['https://mew-neo4j.ideaflow.app/', 'Open Mew Neo4j ↗'],
    ['https://social.ideaflow.app/', 'Social'],
    ['https://globalbr.ai/', 'Noos'],
    ['https://wikihub.md/', 'WikiHub · markdown wikis'],
  ]) {
    assert.ok(yourData.includes(`href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`), label)
  }
  assert.match(yourData, /Each app shows the content available to your account there/)
  assert.match(yourData, /<h3>Export from Unlinked<\/h3>/)
  assert.match(yourData, /href="\/downloads\?scope=mine"/)
  assert.match(yourData, /<form method="get" action="\/export">/)
  assert.match(yourData, /href="\/data-liberation"/)

  // Follow both existing export destinations with the same authenticated owner.
  const download = await request('/downloads?scope=mine', { headers })
  assert.equal(download.status, 200)
  assert.match(await download.text(), /<title>Download my network · Unlinked<\/title>/)
  const csv = await request('/downloads/file?scope=mine&format=csv&detail=headline', { headers })
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type'), /text\/csv/)
  const csvText = await csv.text()
  assert.match(csvText, /Sam Fictional/)
  const exported = await request('/export', { headers })
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition'), /attachment;/)
  const data = await exported.json()
  assert.equal(data.format, 'unlinked-account-export')
  assert.equal(data.account.ownerId, owner.ownerId)
  assert.equal(data.legacy.profile.name, 'Robin Fictional')
  assert.equal(minted, 0)

  if (process.env.UNLINKED_TEST_EVIDENCE_DIR) {
    const dir = process.env.UNLINKED_TEST_EVIDENCE_DIR
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings-your-data.html'), document)
    await writeFile(join(dir, 'network-export.csv'), csvText)
    await writeFile(join(dir, 'account-export.json'), JSON.stringify(data, null, 2))
  }
})
