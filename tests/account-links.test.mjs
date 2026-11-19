import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createNeo4jAccountLinks, verifiedLinkEmail } from '../mcp-server/account-links.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createNeo4jSessionStore } from '../mcp-server/session-store.mjs'
import { createContactCards, createMemoryContactCardStore } from '../mcp-server/contact-card.mjs'

const uri = process.env.UNLINKED_TEST_NEO4J_URI
const driverPath = process.env.UNLINKED_TEST_NEO4J_DRIVER
const prefix = '/settings/login-identities'
const issuer = 'https://identity.example.invalid'
const email = 'verified@example.invalid'

test('account-link evidence requires a strictly verified provider email claim', () => {
  assert.equal(verifiedLinkEmail({ providerEmailVerified: true, verifiedEmail: email }), email)
  for (const flag of [false, undefined, 'true', 1]) assert.equal(verifiedLinkEmail({ providerEmailVerified: flag, verifiedEmail: email }), null)
  for (const address of [undefined, '', 'invalid', 'a@b@c', 'a\u0000@b']) assert.equal(verifiedLinkEmail({ providerEmailVerified: true, verifiedEmail: address }), null)
})

test('real Neo4j and canonical browser: link, scope access, unlink, session fencing and super-admin', { skip: !uri || !driverPath }, async t => {
  const neo4j = createRequire(import.meta.url)(driverPath)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD))
  const tag = randomUUID(), accounts = Object.fromEntries(['primary', 'secondary', 'unknown', 'admin', 'other'].map(name => [name, {
    ownerId: randomUUID(), userId: randomUUID(), subject: tag + name, name,
    email: name === 'other' ? 'primary@example.invalid' : `${name}@example.invalid`,
  }]))
  const rows = Object.values(accounts), ids = rows.map(row => row.ownerId)
  const query = async (cypher, params = {}) => {
    const session = driver.session()
    try { return await session.run(cypher, params) } finally { await session.close() }
  }
  t.after(async () => {
    try {
      await query(`MATCH (n) WHERE n.fixture=$tag OR
        ((n:UnlinkedSession OR n:OperationalIdentity) AND (n.ownerId IN $ids OR n.sourceOwnerId IN $ids)) OR
        (n:UnlinkedAccountLinkEvent AND n.primaryOwnerId IN $ids)
        DETACH DELETE n`, { tag, ids })
    } finally { await driver.close() }
  })
  await query(`UNWIND $rows AS row
    CREATE (:OperationalOwner {namespace:'unlinked',sourceOwnerId:row.ownerId,userId:row.userId,identityIssuer:$issuer,identitySubject:row.subject,fixture:$tag})
    CREATE (:OperationalIdentity {namespace:'unlinked',issuer:$issuer,subject:row.subject,sourceOwnerId:row.ownerId,userId:row.userId,fixture:$tag})
    CREATE (:UnlinkedConnectionPrivacy {ownerId:row.ownerId,userId:row.userId,fixture:$tag,audience:row.name})`, { rows, issuer, tag })
  const resolveOwner = async identity => {
    const result = await query(`MATCH (n:OperationalIdentity {namespace:'unlinked',issuer:$issuer,subject:$subject})
      RETURN n.sourceOwnerId AS ownerId,n.userId AS userId`, { issuer: identity.issuer, subject: identity.subject })
    return result.records[0]?.toObject() ?? null
  }
  const makeLinks = manage => createNeo4jAccountLinks(driver, { issuer, manage, resolveOwner, adminSubjects: [accounts.admin.subject] })
  const links = makeLinks(true), sessionStore = createNeo4jSessionStore(driver)
  await links.initialize()
  await sessionStore.initialize()
  const login = {
    authorizationOrigin: issuer,
    begin: async ({ prompt } = {}) => {
      const state = randomUUID(), url = new URL(issuer + '/authorize')
      url.searchParams.set('state', state)
      if (prompt) url.searchParams.set('prompt', prompt)
      return { location: url.href, transaction: { state } }
    },
    finish: async url => {
      const [name, unverified] = url.searchParams.get('code').split(':')
      const account = accounts[name]
      return { issuer, subject: account.subject, displayName: 'Same Name', verifiedEmail: account.email, providerEmailVerified: !unverified }
    },
  }
  const contactCards = createContactCards({ store: createMemoryContactCardStore() })
  const cardToken = (await contactCards.save(accounts.other, { shareCard: true }, { name: 'Synthetic contact' })).token
  const cardMessage = '/c/' + cardToken + '/message'
  const messagingReads = [], messagingRequests = []
  const messagingCounts = () => [messagingReads.length, messagingRequests.length]
  const options = {
    login, resolveOwner, sessionStore, signup: async () => { assert.fail('linking must not provision accounts') },
    issueAccountGrant: async () => assert.fail('linked login must not create a key'),
    revokeAccountGrant: async () => {},
    mcpEndpoint: 'https://unlinked.example.invalid/mcp',
    ensureAccountGrant: async () => ({ grantId: 'sensitive-key', accessToken: 'original-login-key' }),
    getBackend: async owner => {
      const account = rows.find(row => row.ownerId === owner.ownerId && row.userId === owner.userId)
      assert.ok(account)
      return { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => ['sensitive-key'],
        readLegacyFiles: async () => ({ objects: [{ objectId: 'file-id', filename: `${account.name}-import.zip`, bytes: 12, accepted: 1 }] }) }
    },
    contactCards,
    resolveCardMessagingRecipient: async () => ({ id: 'synthetic-peer' }),
    createMessagingSession: async session => {
      messagingReads.push(session.owner.ownerId)
      return { token: 'synthetic-messaging-token', user: { userId: 'synthetic-user' } }
    },
    messagingOptions: { fetchImpl: async url => {
      messagingRequests.push(new URL(url).pathname)
      if (url.endsWith('/unread-total')) return Response.json({ unreadTotal: 17 })
      assert.match(url, /conversations$/)
      return Response.json({ id: 'synthetic-conversation', type: 'direct' })
    } },
    privateContext: { search: async owner => ({ state: 'ready', recordsFrom: owner.ownerId }) },
    connectionPrivacy: { get: async () => null, list: async () => [], removeOwner: async () => {}, set: async (owner, value) => query(`MATCH (n:UnlinkedConnectionPrivacy {ownerId:$ownerId,userId:$userId}) SET n.audience=$audience`, { ...owner, audience: value.audience }) },
  }
  let handler
  const server = createServer((req, res) => { handler(req, res).catch(() => res.writeHead(503).end()) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ ...options, baseUrl, accountLinks: links })
  const fetchRoute = (path, jar = '', values, origin = baseUrl) => fetch(endpoint + path, {
    redirect: 'manual', headers: { Cookie: jar, ...(values ? { Origin: origin } : {}) },
    ...(values ? { method: 'POST', body: new URLSearchParams(values) } : {}),
  })
  const cookie = (response, key) => response.headers.getSetCookie().find(entry => entry.startsWith(`__Host-ul-${key}=`))?.split(';')[0]
  const complete = (response, name, session = '', state) => {
    const provider = new URL(response.headers.get('location'))
    const path = '/auth/callback/ideaflow?' + new URLSearchParams({ code: name, state: state ?? provider.searchParams.get('state') })
    return fetchRoute(path, [cookie(response, 'login'), session].filter(Boolean).join('; '))
  }
  const signIn = async (name, status = 303) => {
    const response = await complete(await fetchRoute('/login?next=/settings'), name)
    assert.equal(response.status, status)
    return cookie(response, 'session')
  }
  const formValue = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1]
  const settings = async session => (await fetchRoute('/settings', session)).text()
  const start = async (session, fields) => {
    const response = await fetchRoute(prefix, session, { csrf: formValue(await settings(session), 'csrf'), ...fields })
    assert.equal(response.status, 303)
    assert.equal(new URL(response.headers.get('location')).searchParams.get('prompt'), 'login')
    return response
  }
  const advance = async (response, session, path, extra = {}) => {
    assert.equal(response.status, 200)
    const html = await response.text()
    return fetchRoute(prefix + path, [session, cookie(response, 'link-confirm')].join('; '),
      { csrf: formValue(html, 'csrf'), challenge: formValue(html, 'challenge'), ...extra })
  }
  const primary = await signIn('primary'), secondary = await signIn('secondary'), other = await signIn('other'), admin = await signIn('admin')
  // Even equal names and equal verified email claims map to different subjects.
  assert.match(await settings(other), /other-import\.zip/)
  assert.doesNotMatch(await settings(other), /primary-import\.zip/)
  assert.match(await settings(primary), /original-login-key/)
  // Prime ordinary-login badge and credential caches for both record owners.
  for (const session of [primary, secondary]) assert.equal((await (await fetchRoute('/api/nav-alerts', session)).json()).messages, 17)
  const csrf = formValue(await settings(primary), 'csrf')
  const direct = await fetchRoute(cardMessage, primary, { csrf })
  assert.equal(direct.headers.get('location'), '/messages/c/synthetic-conversation')
  assert.equal((await fetchRoute(prefix, primary, { action: 'self', csrf }, 'https://other.invalid')).status, 403)
  assert.equal((await fetchRoute(prefix, primary, { action: 'self', csrf: 'wrong' })).status, 409)
  assert.equal((await fetchRoute(prefix, primary, { action: 'admin', primary: ids[0], secondary: ids[1], csrf })).status, 409)
  const mixed = await start(primary, { action: 'self' })
  assert.equal((await complete(mixed, 'primary', other)).status, 409)
  const mismatched = await start(primary, { action: 'self' })
  assert.equal((await complete(mismatched, 'primary', primary, 'wrong-state')).status, 400)
  assert.equal((await complete(await start(primary, { action: 'self' }), 'other', primary)).status, 409)
  assert.equal((await complete(await start(primary, { action: 'self' }), 'primary:unverified', primary)).status, 409)
  const otherStep = async () => {
    const passed = await complete(await start(primary, { action: 'self' }), 'primary', primary)
    const other = await advance(passed, primary, '/other')
    assert.equal(other.status, 303)
    assert.equal(new URL(other.headers.get('location')).searchParams.get('prompt'), 'login')
    return other
  }
  assert.equal((await complete(await otherStep(), 'secondary:unverified', primary)).status, 409)
  assert.equal((await complete(await otherStep(), 'primary', primary)).status, 409)
  assert.equal((await complete(await otherStep(), 'admin', primary)).status, 409)
  const final = await complete(await otherStep(), 'secondary', primary)
  const confirmation = final.clone()
  const done = await advance(final, primary, '/confirm')
  assert.equal(done.status, 200)
  assert.match(await done.text(), /Accounts linked/)
  assert.equal((await advance(confirmation, primary, '/confirm')).status, 404)
  for (const stale of [primary, secondary]) assert.equal((await fetchRoute('/settings', stale)).status, 401)
  assert.equal(await signIn('secondary:unverified', 409), undefined)

  const viaSecondary = await signIn('secondary')
  const beforeAlias = messagingCounts()
  const linkedSettings = await settings(viaSecondary)
  assert.equal((await (await fetchRoute('/api/nav-alerts', viaSecondary)).json()).messages, undefined)
  assert.equal((await fetchRoute(cardMessage, viaSecondary, { csrf: formValue(linkedSettings, 'csrf') })).status, 403)
  assert.deepEqual(messagingCounts(), beforeAlias)

  const viaPrimary = await signIn('primary')
  const primaryScope = await fetchRoute(prefix + '/scope', viaPrimary, { owner: accounts.secondary.ownerId, csrf: formValue(await settings(viaPrimary), 'csrf') })
  assert.equal(primaryScope.status, 303)
  const primaryViewingSecondary = cookie(primaryScope, 'session'), beforePrimaryScope = messagingCounts()
  const primaryScopeSettings = await settings(primaryViewingSecondary)
  assert.match(primaryScopeSettings, /secondary-import\.zip/)
  assert.equal((await (await fetchRoute('/api/nav-alerts', primaryViewingSecondary)).json()).messages, undefined)
  assert.equal((await fetchRoute(cardMessage, primaryViewingSecondary, { csrf: formValue(primaryScopeSettings, 'csrf') })).status, 403)
  assert.deepEqual(messagingCounts(), beforePrimaryScope)
  assert.match(linkedSettings, /Primary/); assert.match(linkedSettings, /secondary@example.invalid/)
  assert.match(linkedSettings, /primary-import\.zip/); assert.doesNotMatch(linkedSettings, /secondary-import\.zip|original-login-key/)
  assert.equal((await fetchRoute('/settings/api-keys?key=sensitive-key', viaSecondary)).status, 403)
  const linkedCsrf = formValue(linkedSettings, 'csrf')
  assert.equal((await fetchRoute(prefix + '/scope', viaSecondary, { owner: accounts.other.ownerId, csrf: linkedCsrf })).status, 409)
  const selected = await fetchRoute(prefix + '/scope', viaSecondary, { owner: accounts.secondary.ownerId, csrf: linkedCsrf })
  assert.equal(selected.status, 303)
  const scoped = cookie(selected, 'session')
  assert.equal((await fetchRoute('/settings', viaSecondary)).status, 401)

  // Restart the browser handler and pause new link changes. Existing routing
  // and record access continue from Neo4j alone.
  handler = createPrivateBrowserHandler({ ...options, baseUrl, accountLinks: makeLinks(false) })
  const beforeScope = messagingCounts()
  const scopedSettings = await settings(scoped)
  assert.equal((await (await fetchRoute('/api/nav-alerts', scoped)).json()).messages, undefined)
  assert.deepEqual(messagingCounts(), beforeScope)
  assert.match(scopedSettings, /Viewing records from secondary@example.invalid|Viewing records from <[^>]+>secondary@example.invalid/)
  assert.match(scopedSettings, /secondary-import\.zip/); assert.doesNotMatch(scopedSettings, /primary-import\.zip|original-login-key/)
  assert.equal((await (await fetchRoute('/api/private-context/search?q=note', scoped)).json()).recordsFrom, accounts.secondary.ownerId)
  const scopedCsrf = formValue(scopedSettings, 'csrf')
  assert.equal((await fetchRoute('/settings/connection-privacy', scoped, { csrf: scopedCsrf, connectionsAudience: 'members', connectionsScope: 'shared' })).status, 303)
  assert.equal((await fetchRoute('/delete-account', scoped, { csrf: scopedCsrf })).status, 403)

  handler = createPrivateBrowserHandler({ ...options, baseUrl, accountLinks: links })
  const primaryAgain = await signIn('primary')
  assert.equal((await fetchRoute('/delete-account', primaryAgain, { csrf: formValue(await settings(primaryAgain), 'csrf') })).status, 409)
  const unlink = await start(scoped, { action: 'unlink', secondary: accounts.secondary.ownerId })
  assert.equal((await complete(unlink, 'secondary', scoped)).status, 409)
  const unlinkConfirmed = await complete(await start(scoped, { action: 'unlink', secondary: accounts.secondary.ownerId }), 'primary', scoped)
  const removed = await advance(unlinkConfirmed, scoped, '/confirm')
  assert.equal(removed.status, 200); assert.match(await removed.text(), /Login unlinked/)
  assert.equal((await fetchRoute('/settings', scoped)).status, 401)
  assert.equal((await fetchRoute('/settings', primaryAgain)).status, 401)
  const separate = await signIn('secondary')
  assert.match(await settings(separate), /secondary-import\.zip/)
  assert.doesNotMatch(await settings(separate), /primary-import\.zip/)
  const privacy = await query('MATCH (n:UnlinkedConnectionPrivacy {ownerId:$id}) RETURN n.audience AS audience', { id: accounts.secondary.ownerId })
  assert.equal(privacy.records[0].get('audience'), 'members')

  const privileged = await start(admin, { action: 'admin', primary: accounts.primary.ownerId, secondary: accounts.secondary.ownerId })
  const afterProof = await complete(privileged, 'admin', admin)
  const body = await afterProof.clone().text()
  assert.match(body, /primary@example.invalid/); assert.match(body, /secondary@example.invalid/)
  const adminDone = await advance(afterProof, admin, '/confirm')
  assert.equal(adminDone.status, 303); assert.equal((await fetchRoute('/settings', admin)).status, 200)
  assert.match(await settings(await signIn('secondary')), /primary-import\.zip/)
  const audit = await query(`MATCH (n:UnlinkedAccountLinkEvent {primaryOwnerId:$primaryId}) RETURN properties(n) AS event ORDER BY n.at`, { primaryId: accounts.primary.ownerId })
  const events = audit.records.map(row => row.get('event'))
  assert.deepEqual(events.map(event => event.action), ['self', 'unlink', 'admin'])
  assert.equal(events[0].linkId, events[1].linkId)
  assert.equal(events[2].actorOwnerId, accounts.admin.ownerId)
  assert.ok(events.every(event => !JSON.stringify(event).includes('@example.invalid')))
})
