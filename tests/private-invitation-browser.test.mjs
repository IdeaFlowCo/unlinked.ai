import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIdeaflowLogin, createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

test('invitation intent executes signed chosen-account OIDC before guarded claim and owner session', async t => {
  const issuer = 'https://invited-ideaflow.invalid', clientId = 'private-invited-client'
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'invited-rsa', alg: 'RS256', use: 'sig' }
  const owner = { ownerId: 'fresh-private-owner', userId: 'fresh-private-principal' }
  const invitationToken = 'a'.repeat(43), claims = [], bindings = new Map()
  const resources = new Map(), assets = new Map(), issued = []
  const adapter = { withImport: async (caller, id, work) => {
    assert.equal(caller, owner.ownerId)
    return work({ getJob: async () => resources.get(id)?.payload,
      putAsset: async (hash, bytes) => assets.set(hash, Buffer.from(bytes)), publicationStatus: 'indexed',
      saveJob: async job => resources.set(id, { sourceOwnerId: caller, payload: structuredClone(job) }),
      publish: async (job, rows) => {
        job.assertionIds = rows.map(row => row.id)
        resources.set(id, { sourceOwnerId: caller, payload: structuredClone(job) })
        for (const row of rows) resources.set(row.id, { sourceOwnerId: caller, payload: row })
      },
    })
  } }
  let invitationHtml
  let nonce, handler, override = {}, claimFailure, returnedOwner = owner, tokenExchanges = 0
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const sign = value => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${header}.${payload}.${createSign('RSA-SHA256').update(`${header}.${payload}`).sign(keys.privateKey).toString('base64url')}`
  }
  const realLogin = await createIdeaflowLogin({ issuer, clientId, clientSecret: 'synthetic-secret', callbackUrl: `${baseUrl}/auth/callback/ideaflow`, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname
    if (path.includes('well-known')) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
    if (path === '/jwks') return Response.json({ keys: [jwk] })
    assert.equal(path, '/token'); tokenExchanges++
    assert.ok(new URLSearchParams(options.body).get('code_verifier'))
    const now = Math.floor(Date.now() / 1000)
    return Response.json({ access_token: 'synthetic-provider-token', token_type: 'Bearer', expires_in: 300,
      id_token: sign({ iss: issuer, sub: 'chosen-opaque-subject', aud: clientId, iat: now, exp: now + 300, nonce, email: 'same-email@example.invalid', email_verified: true, ...override }) })
  } })
  handler = createPrivateBrowserHandler({ baseUrl,
    login: { authorizationOrigin: realLogin.authorizationOrigin, begin: async options => { const result = await realLogin.begin(options); nonce = result.transaction.nonce; return result }, finish: realLogin.finish },
    claimInvitation: async (token, identity) => {
      claims.push({ token, identity })
      if (claimFailure) throw new Error(claimFailure)
      assert.equal(token, invitationToken)
      assert.equal(identity.newProfileIntent, true)
      assert.equal(identity.clientId, clientId); assert.equal(identity.issuer, issuer)
      if (identity.subject !== 'chosen-opaque-subject') throw new Error('invitation_identity_conflict')
      assert.equal(Object.hasOwn(identity, 'verifiedEmail'), false)
      assert.match(identity.provenanceReceiptId, /^[A-Za-z0-9_-]{43}$/)
      bindings.set(`${identity.issuer}:${identity.subject}`, owner)
      return returnedOwner
    },
    resolveOwner: async identity => bindings.get(`${identity.issuer}:${identity.subject}`),
    getBackend: async verified => {
      assert.deepEqual(verified, owner)
      return { adapter, readResource: async (_type, id) => resources.get(id) }
    },
    complete: async ({ candidateIds }) => ({ matches: [{ id: candidateIds[0], reason: 'Synthetic engineer match' }] }),
    issueGrant: async (verified, scope) => { assert.deepEqual(verified, owner); issued.push(scope); return 'synthetic-invited-grant' },
    mcpEndpoint: `${baseUrl}/mcp`,
  })
  const cookie = (response, name = '__Host-ul-login') => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`)).split(';')[0]
  const begin = async (extra = {}) => {
    const landing = await fetch(`${endpoint}/invite/${invitationToken}`)
    assert.equal(landing.status, 200)
    assert.equal(landing.headers.get('referrer-policy'), 'strict-origin')
    const directives = new Map(landing.headers.get('content-security-policy').split(';').map(value => value.trim().split(/\s+/)).map(([key, ...values]) => [key, values]))
    assert.deepEqual(directives.get('form-action'), ["'self'", issuer])
    assert.deepEqual(directives.get('default-src'), ["'none'"])
    const text = await landing.text()
    invitationHtml = text
    assert.match(text, /Continue with Ideaflow/)
    assert.equal(text.includes(invitationToken), false)
    const csrf = text.match(/name="csrf" value="([^"]+)"/)[1]
    const response = await fetch(`${endpoint}/invite`, { method: 'POST', redirect: 'manual', headers: { Origin: baseUrl, Cookie: landing.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ csrf, ...extra }) })
    return response
  }
  const callback = response => fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic-code&state=${new URL(response.headers.get('location')).searchParams.get('state')}`, { headers: { Cookie: cookie(response) }, redirect: 'manual' })
  const confirmationIntent = async response => {
    const policy = new Map(response.headers.get('content-security-policy').split(';').map(value => value.trim().split(/\s+/)).map(([key, ...values]) => [key, values]))
    assert.deepEqual(policy.get('form-action'), ["'self'", issuer])
    assert.deepEqual(policy.get('default-src'), ["'none'"])
    const text = await response.text()
    assert.match(text, /Confirm your Ideaflow account/)
    assert.match(text, /same-email@example.invalid/)
    const csrf = text.match(/name="csrf" value="([^"]+)"/)[1]
    return { csrf, cookie: cookie(response, '__Host-ul-confirm') }
  }
  const postConfirm = (intent, action = 'confirm', extra = {}) =>
    fetch(`${endpoint}/invite/confirm`, { method: 'POST', redirect: 'manual', headers: { Origin: baseUrl, Cookie: intent.cookie }, body: new URLSearchParams({ csrf: intent.csrf, action, ...extra }) })
  const confirm = async (response, action = 'confirm', extra = {}) => postConfirm(await confirmationIntent(response), action, extra)
  const started = await begin()
  assert.equal(started.status, 303)
  const authorization = new URL(started.headers.get('location'))
  // Binding an invitation shows the provider's chooser, never a forced password.
  assert.equal(authorization.searchParams.get('prompt'), 'select_account')
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  const verified = await callback(started)
  assert.equal(verified.status, 200); assert.equal(claims.length, 0)
  const verifiedIntent = await confirmationIntent(verified)
  const completed = await postConfirm(verifiedIntent)
  assert.equal(completed.status, 303); assert.equal(claims.length, 1)
  const sessionCookie = completed.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const upload = await fetch(endpoint, { headers: { Cookie: sessionCookie } })
  const uploadDirectives = new Map(upload.headers.get('content-security-policy').split(';').map(value => value.trim().split(/\s+/)).map(([key, ...values]) => [key, values]))
  assert.deepEqual(uploadDirectives.get('form-action'), ["'self'"])
  const uploadHtml = await upload.text()
  assert.match(uploadHtml, /LinkedIn export ZIP or CSV/)
  const csrfUpload = uploadHtml.match(/name="csrf" value="([^"]+)"/)[1]
  const uploadForm = new FormData()
  uploadForm.set('csrf', csrfUpload); uploadForm.set('syntheticConsent', 'yes')
  const csv = 'First Name,Last Name,URL,Company,Position\nInvited,Example,https://www.linkedin.com/in/synthetic-invited,Synthetic,Engineer\n'
  uploadForm.set('archive', new Blob([csv]), 'Connections.csv')
  const headers = { Cookie: sessionCookie, Origin: baseUrl }
  const imported = await fetch(`${endpoint}/upload`, { method: 'POST', headers, body: uploadForm, redirect: 'manual' })
  assert.equal(imported.status, 303)
  const receiptPath = imported.headers.get('location'), importId = receiptPath.split('/').pop()
  const stored = resources.get(importId)
  assert.equal(stored.sourceOwnerId, owner.ownerId)
  assert.equal(stored.payload.counts.accepted, 1); assert.equal(stored.payload.counts.indexed, 1)
  assert.equal(stored.payload.consent.version, 'private-archive-openai-v1')
  assert.ok([...assets.values()].some(bytes => bytes.equals(Buffer.from(csv))))
  const receipt = await fetch(`${endpoint}${receiptPath}`, { headers }), receiptHtml = await receipt.text()
  assert.equal(receipt.status, 200)
  const search = await fetch(`${endpoint}/search`, { method: 'POST', headers, body: new URLSearchParams({ csrf: csrfUpload, importId, query: 'engineer' }) })
  const searchHtml = await search.text()
  assert.equal(search.status, 200); assert.match(searchHtml, /Invited Example/)
  const setup = await fetch(`${endpoint}/setup`, { method: 'POST', headers, body: new URLSearchParams({ csrf: csrfUpload, importId }) })
  assert.equal(setup.status, 200)
  const configuration = await setup.json()
  assert.deepEqual(issued, [{ importIds: [importId], tools: ['unlinked_search_import'] }])
  assert.equal(configuration.mcpServers['unlinked-private'].url, `${baseUrl}/mcp`)
  if (process.env.PRIVATE_BROWSER_EVIDENCE_DIR) {
    for (const [name, output] of [['invitation', invitationHtml], ['upload', uploadHtml], ['receipt', receiptHtml], ['search', searchHtml]]) {
      await writeFile(join(process.env.PRIVATE_BROWSER_EVIDENCE_DIR, `invited-${name}.html`), output)
    }
    await writeFile(join(process.env.PRIVATE_BROWSER_EVIDENCE_DIR, 'invited-journey.json'), JSON.stringify({
      boundary: 'Real HTTP controller and signed synthetic OIDC; in-memory claim/storage, deterministic completion and synthetic setup grant. No live login, Noos or model proof; one-row BASIC journey is not scale acceptance.',
      owner, accountChoice: authorization.searchParams.get('prompt'), pkce: authorization.searchParams.get('code_challenge_method'),
      callbackStatus: verified.status, confirmStatus: completed.status, uploadStatus: imported.status, receiptStatus: receipt.status,
      counts: stored.payload.counts, searchStatus: search.status, setupStatus: setup.status, scope: issued[0], configuration,
    }, null, 2))
  }
  assert.equal((await callback(started)).status, 400); assert.equal(claims.length, 1)
  assert.equal((await postConfirm(verifiedIntent)).status, 400); assert.equal(claims.length, 1)
  const recovered = await callback(await begin())
  assert.equal(recovered.status, 200)
  assert.equal((await confirm(recovered)).status, 303); assert.equal(claims.length, 2)
  for (const bad of [{ nonce: 'wrong' }, { aud: 'other-client' }, { iss: 'https://other.invalid' }]) {
    const response = await begin(); override = bad
    assert.equal((await callback(response)).status, 400)
    assert.equal(claims.length, 2)
    override = {}
  }
  assert.equal((await begin({ ownerId: 'attacker-selected-owner' })).status, 400)
  assert.equal(claims.length, 2)
  const wrongState = await begin(), beforeState = tokenExchanges
  assert.equal((await fetch(`${endpoint}/auth/callback/ideaflow?code=code&state=wrong`, { headers: { Cookie: cookie(wrongState) }, redirect: 'manual' })).status, 400)
  assert.equal(tokenExchanges, beforeState); assert.equal(claims.length, 2)
  const landing = await fetch(`${endpoint}/invite/${invitationToken}`)
  const inviteCookie = landing.headers.get('set-cookie').split(';')[0]
  const csrf = (await landing.text()).match(/name="csrf" value="([^"]+)"/)[1]
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Origin: 'https://other.invalid', Cookie: inviteCookie }, body: new URLSearchParams({ csrf }) })).status, 403)
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Origin: 'null', Cookie: inviteCookie }, body: new URLSearchParams({ csrf }) })).status, 403)
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Cookie: inviteCookie }, body: new URLSearchParams({ csrf }) })).status, 403)
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Origin: baseUrl, Cookie: inviteCookie }, body: new URLSearchParams({ csrf: 'wrong' }) })).status, 400)
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Origin: baseUrl, Cookie: inviteCookie }, body: new URLSearchParams({ csrf }) })).status, 400)
  assert.equal(claims.length, 2)
  // Expiring the server-side intent prevents even the provider exchange.
  const expiredLanding = await fetch(`${endpoint}/invite/${invitationToken}`)
  const expiredCsrf = (await expiredLanding.text()).match(/name="csrf" value="([^"]+)"/)[1]
  const realNow = Date.now, advanced = realNow() + 6 * 60000
  t.mock.method(Date, 'now', () => advanced)
  assert.equal((await fetch(`${endpoint}/invite`, { method: 'POST', headers: { Origin: baseUrl, Cookie: expiredLanding.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ csrf: expiredCsrf }) })).status, 400)
  t.mock.restoreAll()
  assert.equal(claims.length, 2)
  const noSession = response => assert.equal(response.headers.getSetCookie().some(value => value.startsWith('__Host-ul-session=')), false)
  for (const reason of ['invitation_unavailable', 'invitation_expired']) {
    claimFailure = reason
    const denied = await confirm(await callback(await begin()))
    assert.equal(denied.status, 400); noSession(denied)
  }
  claimFailure = undefined
  const beforeWrongSubject = claims.length
  const otherSubject = await begin(); override = { sub: 'other-subject-same-email' }
  const otherResult = await callback(otherSubject)
  assert.equal(otherResult.status, 200); noSession(otherResult)
  assert.equal(bindings.has(`${issuer}:other-subject-same-email`), false)
  const restarted = await confirm(otherResult, 'restart')
  assert.equal(restarted.status, 303); assert.equal(claims.length, beforeWrongSubject)
  assert.equal(new URL(restarted.headers.get('location')).searchParams.get('prompt'), 'select_account')
  override = {}
  const intendedAfterRestart = await callback(restarted)
  assert.equal(intendedAfterRestart.status, 200)
  assert.equal((await confirm(intendedAfterRestart, 'confirm', { subject: 'attacker-selected-subject' })).status, 400)
  assert.equal(claims.length, beforeWrongSubject)
  assert.equal((await confirm(await callback(await begin()))).status, 303)
  assert.equal(claims.length, beforeWrongSubject + 1)
  override = {}
  claimFailure = undefined; returnedOwner = { ownerId: 'wrong-owner', userId: owner.userId }
  const mismatch = await confirm(await callback(await begin()))
  assert.equal(mismatch.status, 409)
  noSession(mismatch)
  // Ordinary sign-in cannot claim a profile from email or an uninvited unknown subject.
  const ordinary = await fetch(`${endpoint}/login`, { redirect: 'manual' }), beforeUnknown = claims.length
  override = { sub: 'unknown-uninvited-subject' }
  const unknown = await callback(ordinary)
  assert.equal(unknown.status, 409); noSession(unknown)
  assert.equal(claims.length, beforeUnknown)
  assert.ok(tokenExchanges >= 7)
})
