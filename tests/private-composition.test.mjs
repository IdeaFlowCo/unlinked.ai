import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createPrivatePilotDependencies } from '../mcp-server/private-composition.mjs'
import { createMemoryEmailStore } from '../mcp-server/member-email.mjs'
import { createMemoryNotificationStore } from '../mcp-server/member-notifications.mjs'

const require = createRequire(new URL('../mcp-server/package.json', import.meta.url))
const { importSPKI, jwtVerify } = await import(require.resolve('jose'))
const configuration = { issuer: 'https://identity.invalid/api/auth', clientId: 'private-test-client',
  clientSecret: 'synthetic-client-secret', graphPassword: 'synthetic-graph-password', apiKey: 'synthetic-model-key' }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'unlinked-composition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = createServer()
  // Choose an available high port; no listener survives this discovery step.
  let port
  for (let candidate = 7000 + Math.floor(Math.random() * 3000); ; candidate = 7000 + (candidate - 6999) % 3000) {
    const listening = await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(candidate, '127.0.0.1', () => resolve(true)) })
    if (listening) { port = candidate; await new Promise(resolve => probe.close(resolve)); break }
  }
  const state = { closes: 0, mounts: [], active: true, readyFailures: 0, resource: { sourceOwnerId: 'owner-one', payload: { private: true } } }
  // Explicit process-side contract doubles. Real Noos graph/provisioning evidence
  // is separate; this test executes composition, signed bearer and HTTP routing.
  class OperationalStore {
    async listPendingImportJobs() { return [] }
    async listImportJobIds() { return [] }
    ready = false
    async initialize() { this.ready = true; state.storeInitialized = true }
    checkReady() { if (!this.ready) throw new Error('operational_unavailable') }
    async authorizeOwner(principal, namespace, ownerId) {
      this.checkReady()
      assert.equal(namespace, 'unlinked')
      if (!state.active || principal?.userId !== 'user-one' || ownerId !== 'owner-one') throw new Error('owner_denied')
    }
    async resolveIdentity(namespace, issuer, subject) {
      this.checkReady()
      return namespace === 'unlinked' && issuer === configuration.issuer && subject === 'chosen-subject' && state.active ?
        { ownerId: 'owner-one', userId: 'user-one' } : null
    }
  }
  class InvitedOwnerProvisioner {
    constructor(driver, database, capability) { state.capability = capability }
    async initialize() { state.initialized = true }
    async signup(identity) { state.signup = identity; return { ownerId: 'owner-one', userId: 'user-one' } }
    async claim(token, identity) {
      state.claim = { token, identity }
      if (token !== 'synthetic-invite' || identity.subject !== 'chosen-subject') throw new Error('invitation_denied')
      return { ownerId: 'owner-one', userId: 'user-one' }
    }
  }
  const modules = {
    neo4j: { auth: { basic: (user, password) => ({ user, password }) }, driver: (url, auth, limits) => {
      state.driver = { url, auth, limits }; return {
        async verifyConnectivity() {
          state.readinessChecks = (state.readinessChecks ?? 0) + 1
          if (state.readyFailures-- > 0) throw new Error('graph_starting')
        },
        close: async () => { state.closes++ },
      }
    } }, OperationalStore, InvitedOwnerProvisioner,
    StagingFileAssets: class { async get() { throw new Error('unused') } async put() { throw new Error('unused') } },
    createAccessTokenAuthenticator(options) {
      state.authOptions = options
      return async req => {
        try {
          const key = await importSPKI(options.publicKey, 'RS256')
          const { payload, protectedHeader } = await jwtVerify(req.headers.authorization?.slice(7), key,
            { issuer: options.issuer, audience: options.audience, algorithms: ['RS256'] })
          assert.equal(protectedHeader.typ, 'at+jwt'); assert.equal(payload.scope, 'unlinked:read unlinked:write')
          if (await options.isRevoked()) return null
          return options.resolveSubject(payload.iss, payload.sub)
        } catch { return null }
      }
    },
    createPrivateAssetRouter() { return async (req, res, next) => next() },
    createOperationalRouter(store, authenticate) { return async (req, res) => {
      const principal = await authenticate(req)
      if (!principal) { res.writeHead(401); res.end(); return }
      try { await store.authorizeOwner(principal, 'unlinked', state.resource.sourceOwnerId) }
      catch { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state.resource))
    } },
    express() {
      const routes = []
      return { use(path, handler) { state.mounts.push(path); routes.push(handler) }, listen(port, host) {
        return createServer((req, res) => {
          let index = 0
          const next = () => { const handler = routes[index++]; if (handler) void handler(req, res, next); else { res.writeHead(404); res.end() } }
          next()
        }).listen(port, host)
      } }
    },
  }
  const options = { root, baseUrl: 'https://private-test.invalid', host: '127.0.0.1', operationalPort: port,
    boltUrl: 'bolt://127.0.0.1:9289', dataMode: 'synthetic', config: configuration, modules,
    loginFactory: async options => { state.login = options; return { begin() {}, finish() {} } },
    completionFactory: options => { state.completion = options; return async () => 'synthetic-response' } }
  return { options, state, port }
}

test('private composition connects exact callback, immutable owner resolution and internal signed HTTP operations', async t => {
  const { options, state, port } = await fixture(t)
  const dependencies = await createPrivatePilotDependencies(options)
  t.after(dependencies.close)
  assert.equal(state.initialized, true)
  assert.equal(state.storeInitialized, true)
  assert.deepEqual(state.capability, { role: 'callback', actorId: 'unlinked-private-browser', issuer: configuration.issuer, clientId: configuration.clientId })
  assert.equal(state.login.callbackUrl, 'https://private-test.invalid/auth/callback/ideaflow')
  assert.deepEqual(state.mounts, ['/v1', '/v1'])
  assert.equal(await dependencies.resolveOwner({ issuer: 'https://another-issuer.invalid', subject: 'chosen-subject' }), null)
  assert.equal(await dependencies.resolveOwner({ issuer: configuration.issuer, subject: 'unknown', email: 'known@example.invalid' }), null)
  const owner = await dependencies.resolveOwner({ issuer: configuration.issuer, subject: 'chosen-subject' })
  const backend = await dependencies.getBackend(owner)
  assert.deepEqual(await backend.readResource('import', 'a'.repeat(64)), state.resource)
  await assert.rejects(dependencies.getBackend({ ...owner, ownerId: 'another-owner' }), /owner_denied/)
  await assert.rejects(dependencies.getBackend({ ...owner, userId: 'another-user' }), /owner_denied/)
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/unlinked/import/${'a'.repeat(64)}`)).status, 401)
  const identity = { issuer: configuration.issuer, subject: 'chosen-subject', clientId: configuration.clientId }
  assert.deepEqual(await dependencies.claimInvitation('synthetic-invite', identity), owner)
  assert.deepEqual(state.claim, { token: 'synthetic-invite', identity })
  assert.equal(await dependencies.complete(), 'synthetic-response')
  state.active = false
  assert.equal(await backend.readResource('import', 'a'.repeat(64)), null)
  await assert.rejects(dependencies.getBackend(owner), /owner_denied/)
  await dependencies.close(); await dependencies.close()
  assert.equal(state.closes, 1)
  await assert.rejects(dependencies.getBackend(owner), /private_owner_recovery_required/)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/`))
})

test('composition fails closed on public graph, unapproved live target and initialization failure', async t => {
  const { options, state } = await fixture(t)
  await assert.rejects(createPrivatePilotDependencies({ ...options, boltUrl: 'bolt://graph.invalid:9289' }), /private_composition_configuration_required/)
  await assert.rejects(createPrivatePilotDependencies({ ...options, dataMode: 'private_live' }), /private_composition_target_required/)
  await assert.rejects(createPrivatePilotDependencies({ ...options, loginFactory: async () => { throw new Error('issuer_discovery_failed') } }), /issuer_discovery_failed/)
  assert.equal(state.closes, 1)
})

test('composition waits for graph readiness before provisioning', async t => {
  const { options, state } = await fixture(t)
  state.readyFailures = 2
  const dependencies = await createPrivatePilotDependencies({ ...options, graphReadyDeadlineMs: 1000, graphReadyRetryMs: 1 })
  t.after(dependencies.close)
  assert.equal(state.readinessChecks, 3)
  assert.equal(state.initialized, true)
  assert.equal(state.storeInitialized, true)
})

test('composition fails closed when graph readiness deadline expires', async t => {
  const { options, state } = await fixture(t)
  state.readyFailures = 100
  await assert.rejects(createPrivatePilotDependencies({ ...options, graphReadyDeadlineMs: 3, graphReadyRetryMs: 1 }), /private_graph_not_ready/)
  assert.equal(state.initialized, undefined)
  assert.equal(state.closes, 1)
})


test('explicit container mode keeps operations loopback and allows only private graph DNS', async t => {
  const { options, state, port } = await fixture(t)
  const isolated = { ...options, networkMode: 'isolated-container', boltUrl: 'bolt://graph:7687' }
  for (const change of [{ boltUrl: 'bolt://graph:9289' }, { boltUrl: 'bolt://other:7687' }, { boltUrl: 'bolt://127.0.0.1:7687' }, { host: '0.0.0.0' }, { networkMode: 'unknown' }]) {
    await assert.rejects(createPrivatePilotDependencies({ ...isolated, ...change }), /private_composition_configuration_required/)
  }
  const dependencies = await createPrivatePilotDependencies(isolated)
  t.after(dependencies.close)
  assert.equal(state.driver.url, 'bolt://graph:7687')
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/unlinked/import/${'a'.repeat(64)}`)).status, 401)
  const owner = await dependencies.resolveOwner({ issuer: configuration.issuer, subject: 'chosen-subject' })
  const backend = await dependencies.getBackend(owner)
  assert.deepEqual(await backend.readResource('import', 'a'.repeat(64)), state.resource)
  await assert.rejects(dependencies.getBackend({ ...owner, ownerId: 'wrong-owner' }), /owner_denied/)
})


test('canonical origin uses its exact OIDC callback and keeps owner operations private', async t => {
  const { options, state, port } = await fixture(t)
  const dependencies = await createPrivatePilotDependencies({ ...options, baseUrl: 'https://www.unlinked.ai' })
  t.after(dependencies.close)
  assert.equal(state.login.callbackUrl, 'https://www.unlinked.ai/auth/callback/ideaflow')
  const owner = await dependencies.resolveOwner({ issuer: configuration.issuer, subject: 'chosen-subject' })
  assert.deepEqual(await (await dependencies.getBackend(owner)).readResource('import', 'a'.repeat(64)), state.resource)
  await assert.rejects(dependencies.getBackend({ ...owner, ownerId: 'another-owner' }), /owner_denied/)
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/unlinked/import/${'a'.repeat(64)}`)).status, 401)
})

test('email delivery is wired only with its store; no key or the off flag sends nothing, and the mailer stops with the runtime', async t => {
  const { options } = await fixture(t)
  const plain = await createPrivatePilotDependencies(options)
  assert.equal(plain.memberEmail, undefined)
  await plain.close()
  for (const [emailEnv, sending] of [[{}, false], [{ RESEND_API_KEY: 'synthetic-resend-key', UNLINKED_EMAIL_ENABLED: '0' }, false], [{ RESEND_API_KEY: 'synthetic-resend-key' }, true]]) {
    const { options: next } = await fixture(t)
    const transports = []
    const dependencies = await createPrivatePilotDependencies({ ...next, emailEnv,
      modules: { ...next.modules, createEmailStore: () => createMemoryEmailStore(), createNotificationStore: () => ({ ...createMemoryNotificationStore(), initialize: async () => {} }) },
      emailTransportFactory: settings => { transports.push(settings.apiKey); return { send: async () => ({ id: null }) } } })
    assert.equal(dependencies.memberEmail.sending, sending)
    assert.deepEqual(transports, sending ? ['synthetic-resend-key'] : [])
    // A second start is refused while the composition's own timer runs.
    assert.equal(dependencies.memberEmail.start(), false)
    await dependencies.close()
    assert.equal(dependencies.memberEmail.start(), sending, 'close stopped the timer')
    await dependencies.memberEmail.stop()
  }
})
