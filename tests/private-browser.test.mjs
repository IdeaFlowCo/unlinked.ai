import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign, sign as signBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let browser
try { browser = await import('../mcp-server/private-browser.mjs') } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }

test('OIDC code flow verifies signed ID token, issuer/audience/nonce/state/PKCE and uses silent SSO unless the account chooser is asked for', { skip: !browser }, async () => {
  const issuer = 'https://synthetic-ideaflow.invalid', callbackUrl = 'https://private.invalid/auth/callback/ideaflow'
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-rsa', alg: 'RS256', use: 'sig' }
  let nonce, override = {}, signingKey = keys.privateKey, exchanges = 0
  const sign = claims => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url'), payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${header}.${payload}.${createSign('RSA-SHA256').update(`${header}.${payload}`).sign(signingKey).toString('base64url')}`
  }
  const login = await browser.createIdeaflowLogin({ issuer, callbackUrl, clientId: 'private-client', clientSecret: 'synthetic-client-secret', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname
    if (path.includes('well-known')) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
    if (path === '/jwks') return Response.json({ keys: [jwk] })
    assert.equal(path, '/token'); exchanges++
    assert.deepEqual(Buffer.from(new Headers(options.headers).get('authorization').slice(6), 'base64').toString().split(':').map(decodeURIComponent), ['private-client', 'synthetic-client-secret'])
    assert.ok(new URLSearchParams(options.body).get('code_verifier'))
    const now = Math.floor(Date.now() / 1000)
    return Response.json({ access_token: 'synthetic-identity-only', token_type: 'Bearer', expires_in: 300, id_token: sign({ iss: issuer, aud: 'private-client', sub: 'immutable-synthetic-subject', iat: now, exp: now + 300, nonce, email: 'authenticated@example.invalid', email_verified: false, ...override }) })
  } })
  assert.equal(login.authorizationOrigin, issuer)
  for (const bad of [{}, { nonce: 'wrong' }, { iss: 'https://other.invalid' }, { aud: 'other-client' }]) {
    const start = await login.begin(), location = new URL(start.location)
    // Silent SSO: a normal sign-in never asks the provider for a page.
    assert.equal(location.searchParams.has('prompt'), false); assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    nonce = start.transaction.nonce; override = bad
    const callback = new URL(`${callbackUrl}?code=synthetic-code&state=${start.transaction.state}`)
    if (!Object.keys(bad).length) {
      const identity = await login.finish(callback, start.transaction)
      assert.equal(identity.issuer, issuer); assert.equal(identity.subject, 'immutable-synthetic-subject'); assert.equal(identity.verifiedEmail, 'authenticated@example.invalid')
      assert.equal(identity.clientId, 'private-client'); assert.ok(Number.isSafeInteger(identity.verifiedAt))
      assert.match(identity.provenanceReceiptId, /^[A-Za-z0-9_-]{43}$/)
    }
    else await assert.rejects(login.finish(callback, start.transaction))
  }
  // The account chooser and the automatic sign-in's silent `none` are the only
  // other requests; nothing else reaches the provider.
  assert.equal(new URL((await login.begin({ prompt: 'select_account' })).location).searchParams.get('prompt'), 'select_account')
  const silent = new URL((await login.begin({ prompt: 'none' })).location)
  assert.equal(silent.searchParams.get('prompt'), 'none'); assert.equal(silent.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(silent.searchParams.get('state')); assert.ok(silent.searchParams.get('nonce'))
  for (const prompt of ['login', 'consent', 'none select_account', 'select_account login', '']) await assert.rejects(login.begin({ prompt }), /unsupported_ideaflow_prompt/)
  const missingFlag = await login.begin(); nonce = missingFlag.transaction.nonce; override = { email_verified: undefined }
  const authenticated = await login.finish(new URL(`${callbackUrl}?code=code&state=${missingFlag.transaction.state}`), missingFlag.transaction)
  assert.equal(authenticated.verifiedEmail, 'authenticated@example.invalid')
  assert.equal(authenticated.subject, 'immutable-synthetic-subject')
  const start = await login.begin(); nonce = start.transaction.nonce; override = {}; signingKey = wrongKeys.privateKey
  await assert.rejects(login.finish(new URL(`${callbackUrl}?code=code&state=${start.transaction.state}`), start.transaction))
  const before = exchanges
  await assert.rejects(login.finish(new URL(`${callbackUrl}?code=code&state=wrong`), start.transaction))
  assert.equal(exchanges, before)
})

test('signup mode does not expose invitation confirmation or account switching routes', { skip: !browser }, async t => {
  let claims = 0, signups = 0
  const owner = { ownerId: 'signup-owner', userId: 'signup-user' }
  let handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  handler = browser.createPrivateBrowserHandler({ baseUrl,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/account-choice', transaction: { state: 'synthetic-state' } }), finish: async () => ({ issuer: 'https://synthetic.invalid', subject: 'signup-sub' }) },
    resolveOwner: async identity => identity.subject === 'signup-sub' && signups ? owner : null,
    signup: async () => { signups++; return owner },
    claimInvitation: async () => { claims++; return owner },
    getBackend: async () => ({ adapter: {}, readResource: async () => null, listImportIds: async () => [] }),
    issueAccountGrant: async () => 'grant',
    revokeAccountGrant: async () => {},
  })
  const invite = await fetch(`${endpoint}/invite/${'a'.repeat(43)}`)
  assert.equal(invite.status, 401)
  assert.equal((await invite.text()).includes('Use another account'), false)
  assert.equal(claims, 0)
  const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const callback = await fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic&state=synthetic-state`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } })
  assert.equal(callback.status, 303)
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  for (const method of ['GET', 'POST']) {
    const findMe = await fetch(`${endpoint}/find-me`, { method, redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl } })
    assert.equal(findMe.status, 303)
    assert.equal(findMe.headers.get('location'), '/profile')
  }
  const profile = await fetch(`${endpoint}/profile`, { headers: { Cookie: cookie } })
  assert.equal(profile.status, 200)
  assert.ok((await profile.text()).includes('Your profile'))
  assert.equal((await fetch(`${endpoint}/while-you-wait`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 404)
  assert.equal(signups, 1)
})

test('private browser sign-in, action-disclosed upload, durable replay receipt, search and scoped setup execute over HTTP', { skip: !browser }, async t => {
  const { digest } = await import('../src/utils/private-import/archive.mjs')
  const resources = new Map(), assets = new Map(), issued = []
  const owner = { ownerId: 'synthetic-legacy-owner', userId: 'synthetic-noos-owner' }
  const adapter = { withImport: async (caller, id, work) => {
    assert.equal(caller, owner.ownerId)
    return work({ getJob: async () => resources.get(id)?.payload, putAsset: async (id, bytes) => { assets.set(id, Buffer.from(bytes)) },
      publicationStatus: 'indexed',
      saveJob: async job => { resources.set(id, { sourceOwnerId: caller, sourceRevision: job.revision, payload: structuredClone(job) }) },
      publish: async (job, assertions) => {
        job.assertionIds = assertions.map(row => row.id)
        resources.set(id, { sourceOwnerId: caller, sourceRevision: job.revision, payload: structuredClone(job) })
        for (const row of assertions) resources.set(row.id, { sourceOwnerId: caller, payload: row })
      } })
  } }
  let currentHandler, finishes = 0, providerCalls = 0
  const server = createServer((req, res) => currentHandler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  currentHandler = browser.createPrivateBrowserHandler({ baseUrl,
    login: { begin: async () => ({ location: 'https://synthetic.invalid/account-choice', transaction: { state: 'synthetic-state' } }), finish: async () => { finishes++; return { issuer: 'https://synthetic.invalid', subject: 'synthetic-sub' } } },
    resolveOwner: async identity => identity.subject === 'synthetic-sub' ? owner : null,
    getBackend: async verified => { assert.deepEqual(verified, owner); return { adapter, readResource: async (_type, id) => resources.get(id) } },
    complete: async ({ candidateIds }) => { providerCalls++; return { matches: [{ id: candidateIds[0], reason: 'Observed engineer' }] } },
    issueGrant: async (verified, scope) => { issued.push({ verified, scope }); return 'synthetic-scoped-grant' }, mcpEndpoint: `${baseUrl}/mcp`,
  })
  const loginResponse = await fetch(`${endpoint}/login`, { redirect: 'manual' })
  const loginCookie = loginResponse.headers.get('set-cookie').split(';')[0]
  assert.match(loginResponse.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/)
  const callback = await fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic&state=synthetic-state`, { headers: { Cookie: loginCookie }, redirect: 'manual' })
  assert.equal(callback.status, 303)
  const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const uploadPage = await (await fetch(endpoint, { headers: { Cookie: sessionCookie } })).text()
  const csrf = uploadPage.match(/name="csrf" value="([^"]+)"/)[1]
  const csv = 'First Name,Last Name,URL,Company,Position\nAda,Example,https://www.linkedin.com/in/synthetic-ada,Synthetic,Engineer\n'
  const form = (csrfValue = csrf) => { const value = new FormData(); value.set('csrf', csrfValue); value.set('syntheticConsent', 'yes'); value.set('archive', new Blob([csv]), 'Connections.csv'); return value }
  const headers = { Cookie: sessionCookie, Origin: baseUrl }
  const refused = await fetch(`${endpoint}/upload`, { method: 'POST', headers, body: form('wrong-csrf') })
  assert.equal(refused.status, 400); assert.equal(resources.size, 0)
  const uploaded = await fetch(`${endpoint}/upload`, { method: 'POST', headers, body: form(), redirect: 'manual' })
  assert.equal(uploaded.status, 303)
  const receiptPath = uploaded.headers.get('location'), importId = receiptPath.split('/').pop()
  assert.equal(assets.has(digest(Buffer.from(csv))), true)
  assert.equal((await fetch(`${endpoint}/upload`, { method: 'POST', headers, body: form(), redirect: 'manual' })).headers.get('location'), receiptPath)
  const receiptResponse = await fetch(`${endpoint}${receiptPath}`, { headers: { Cookie: sessionCookie } })
  assert.equal(receiptResponse.status, 200)
  const receiptHtml = await receiptResponse.text()
  const search = await fetch(`${endpoint}/search`, { method: 'POST', headers, body: new URLSearchParams({ csrf, importId, query: 'engineer' }) })
  const searchHtml = await search.text()
  assert.match(searchHtml, /Observed engineer/)
  assert.equal((await fetch(`${endpoint}/setup`, { method: 'POST', headers: { ...headers, Origin: 'https://wrong.invalid' }, body: new URLSearchParams({ csrf, importId }) })).status, 403)
  const setup = await fetch(`${endpoint}/setup`, { method: 'POST', headers, body: new URLSearchParams({ csrf, importId }) })
  assert.equal(setup.status, 200)
  assert.deepEqual(issued[0].scope, { importIds: [importId], tools: ['unlinked_search_import'] })
  const configuration = await setup.json()
  assert.equal(configuration.mcpServers['unlinked-private'].url, `${baseUrl}/mcp`)
  if (process.env.PRIVATE_BROWSER_EVIDENCE_DIR) {
    for (const [name, html] of [['upload', uploadPage], ['receipt', receiptHtml], ['search', searchHtml]]) {
      await writeFile(join(process.env.PRIVATE_BROWSER_EVIDENCE_DIR, `browser-${name}.html`), html)
    }
    await writeFile(join(process.env.PRIVATE_BROWSER_EVIDENCE_DIR, 'browser-journey.json'), JSON.stringify({
      boundary: 'Actual staging HTTP handler output; synthetic login, in-memory storage and deterministic completion. No live provider login, Noos storage or model proof.',
      refusedUploadStatus: refused.status, uploadStatus: uploaded.status, replayLocation: receiptPath,
      receiptStatus: receiptResponse.status, searchStatus: search.status, grantScope: issued[0].scope,
      configuration,
    }, null, 2))
  }
  const storedConsent = resources.get(importId).payload.consent
  assert.equal(storedConsent.version, 'private-archive-openai-v1')
  delete resources.get(importId).payload.consent
  const beforeCalls = providerCalls
  assert.equal((await fetch(`${endpoint}/search`, { method: 'POST', headers, body: new URLSearchParams({ csrf, importId, query: 'engineer' }) })).status, 400)
  assert.equal((await fetch(`${endpoint}/setup`, { method: 'POST', headers, body: new URLSearchParams({ csrf, importId }) })).status, 400)
  assert.equal(providerCalls, beforeCalls); assert.equal(issued.length, 1)
  await fetch(`${endpoint}/upload`, { method: 'POST', headers, body: form(), redirect: 'manual' })
  assert.equal(resources.get(importId).payload.consent, undefined)
  resources.get(importId).deleted = true
  assert.equal((await fetch(`${endpoint}/setup`, { method: 'POST', headers, body: new URLSearchParams({ csrf, importId }) })).status, 400)
  assert.equal(issued.length, 1)
  assert.equal((await fetch(`${endpoint}/auth/callback/ideaflow?code=synthetic&state=synthetic-state`, { headers: { Cookie: loginCookie } })).status, 400)
  assert.equal(finishes, 1)
})


test('private browser denies noncanonical or unsafe authorization origins before serving a form', { skip: !browser }, () => {
  assert.throws(() => browser.createPrivateBrowserHandler({ baseUrl: 'https://private.invalid',
    login: { begin: async () => {}, finish: async () => {} },
    claimInvitation: async () => null,
    resolveOwner: async () => null, getBackend: async () => null,
  }))
  for (const authorizationOrigin of ['http://issuer.invalid', 'https://issuer.invalid/path', 'https://issuer.invalid/?query=1', "https://issuer.invalid; form-action *", 'https://issuer.invalid\n']) {
    assert.throws(() => browser.createPrivateBrowserHandler({ baseUrl: 'https://private.invalid',
      login: { authorizationOrigin, begin: async () => {}, finish: async () => {} },
      resolveOwner: async () => null, getBackend: async () => null,
    }))
  }
})


test('live-provider EdDSA discovery verifies JWKS signatures and denies other algorithms and invalid claims', { skip: !browser }, async () => {
  const issuer='https://synthetic-eddsa-ideaflow.invalid', callbackUrl='https://private.invalid/auth/callback/ideaflow'
  const keys=generateKeyPairSync('ed25519'), wrongKeys=generateKeyPairSync('ed25519'), rsa=generateKeyPairSync('rsa',{modulusLength:2048})
  const jwk={...keys.publicKey.export({format:'jwk'}),kid:'provider-ed25519',alg:'EdDSA',use:'sig'}
  const rsaJwk={...rsa.publicKey.export({format:'jwk'}),kid:'unadvertised-rsa',alg:'RS256',use:'sig'}
  let nonce,override={},badSignature=false,algorithm='EdDSA',exchanges=0
  const login=await browser.createIdeaflowLogin({issuer,callbackUrl,clientId:'live-compatible-client',clientSecret:'synthetic-secret',fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname
    if(path.includes('well-known'))return Response.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['EdDSA'],authorization_response_iss_parameter_supported:true})
    if(path==='/jwks')return Response.json({keys:[jwk,rsaJwk]})
    assert.equal(path,'/token');exchanges++;assert.ok(new URLSearchParams(options.body).get('code_verifier'))
    const now=Math.floor(Date.now()/1000)
    const header=Buffer.from(JSON.stringify({alg:algorithm,kid:algorithm==='EdDSA'?jwk.kid:rsaJwk.kid})).toString('base64url')
    const payload=Buffer.from(JSON.stringify({iss:issuer,aud:'live-compatible-client',sub:'operator-test-subject',iat:now,exp:now+300,nonce,email:'operator@example.invalid',email_verified:false,...override})).toString('base64url')
    const signature=algorithm==='EdDSA'?signBytes(null,Buffer.from(`${header}.${payload}`),badSignature?wrongKeys.privateKey:keys.privateKey):createSign('RSA-SHA256').update(`${header}.${payload}`).sign(rsa.privateKey)
    return Response.json({access_token:'synthetic-only',token_type:'Bearer',expires_in:300,id_token:`${header}.${payload}.${signature.toString('base64url')}`})
  }})
  const exchange=async()=>{const start=await login.begin();nonce=start.transaction.nonce;return login.finish(new URL(`${callbackUrl}?code=synthetic&state=${start.transaction.state}&iss=${encodeURIComponent(issuer)}`),start.transaction)}
  const identity=await exchange();assert.equal(identity.issuer,issuer);assert.equal(identity.subject,'operator-test-subject');assert.equal(identity.verifiedEmail,'operator@example.invalid')
  for(const bad of [{nonce:'wrong'},{iss:'https://wrong.invalid'},{aud:'wrong-client'}]){override=bad;await assert.rejects(exchange())}
  override={};badSignature=true;await assert.rejects(exchange());badSignature=false
  algorithm='RS256';await assert.rejects(exchange());algorithm='EdDSA'
  const start=await login.begin(),before=exchanges
  await assert.rejects(login.finish(new URL(`${callbackUrl}?code=synthetic&state=wrong&iss=${encodeURIComponent(issuer)}`),start.transaction));assert.equal(exchanges,before)
})
