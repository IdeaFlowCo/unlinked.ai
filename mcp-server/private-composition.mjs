import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { SignJWT } from 'jose'
import { createIdeaflowLogin } from './private-browser.mjs'
import { createNoosOwnerBackend } from '../src/utils/private-import/noos-adapter.mjs'
import { createResponsesCompletion } from '../src/utils/private-import/ai-search.mjs'

function loadNoos(root) {
  const directory = join(root, 'runtime', 'noos'), require = createRequire(join(directory, 'package.json'))
  return { neo4j: require('neo4j-driver'), express: require('express'),
    ...require(join(directory, 'dist/operational/store.js')),
    ...require(join(directory, 'dist/operational/invitations.js')),
    ...require(join(directory, 'dist/operational/router.js')),
    ...require(join(directory, 'dist/operational/assets.js')),
    ...require(join(directory, 'dist/operational/access-token.js')) }
}

// Explicit private-process composition; never imported by Next.js. No operator
// capability, provider token, graph credential or operations bearer reaches a
// browser/agent. The caller supplies an isolated root and reviewed private env.
export async function createPrivatePilotDependencies({ root, baseUrl, host, operationalPort, boltUrl, dataMode,
  config = { issuer: process.env.IDEAFLOW_ISSUER, clientId: process.env.IDEAFLOW_CLIENT_ID,
    clientSecret: process.env.IDEAFLOW_CLIENT_SECRET, graphPassword: process.env.NOOS_PRIVATE_PASSWORD,
    apiKey: process.env.OPENAI_API_KEY }, modules, loginFactory = createIdeaflowLogin,
  completionFactory = createResponsesCompletion }) {
  const base = new URL(baseUrl), bolt = new URL(boltUrl)
  if (!isAbsolute(root) || host !== '127.0.0.1' || base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      bolt.protocol !== 'bolt:' || bolt.hostname !== '127.0.0.1' || !bolt.port || bolt.pathname || bolt.search || bolt.hash || bolt.username || bolt.password ||
      !Number.isSafeInteger(operationalPort) || operationalPort < 7000 || operationalPort > 9999 || !['synthetic', 'private_live'].includes(dataMode) ||
      ['issuer', 'clientId', 'clientSecret', 'graphPassword', 'apiKey'].some(key => typeof config[key] !== 'string' || !config[key])) throw new Error('private_composition_configuration_required')
  if (dataMode === 'private_live' && (root !== '/srv/unlinked-private-guest-pilot-20261001' || base.origin !== 'https://private.unlinked.ai' ||
      config.issuer !== 'https://id.ideaflow.app/api/auth' || bolt.port !== '9289' || operationalPort !== 9022)) throw new Error('private_composition_target_required')
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('private_composition_root_required')
  const dependencies = modules ?? loadNoos(root)
  const driver = dependencies.neo4j.driver(boltUrl, dependencies.neo4j.auth.basic('neo4j', config.graphPassword),
    { connectionTimeout: 3000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  let server, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (server?.listening) {
      server.closeIdleConnections?.(); server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
    await driver.close()
  }
  try {
    const store = new dependencies.OperationalStore(driver, 'neo4j')
    const provisioner = new dependencies.InvitedOwnerProvisioner(driver, 'neo4j', {
      role: 'callback', actorId: 'unlinked-private-browser', issuer: config.issuer, clientId: config.clientId,
    })
    await provisioner.initialize()
    const login = await loginFactory({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret,
      callbackUrl: new URL('/auth/callback/ideaflow', base).href })
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), internalSubjects = new Set()
    const operationsIssuer = new URL('/internal/noos-operations', base).href
    const authenticate = dependencies.createAccessTokenAuthenticator({ issuer: operationsIssuer, audience: 'unlinked-private-operations',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      resolveSubject: async (issuer, subject) => issuer === operationsIssuer && internalSubjects.has(subject) ? { userId: subject, namespaces: ['unlinked'] } : null,
      isRevoked: async () => closed })
    const assetRoot = join(root, 'assets'), files = new dependencies.StagingFileAssets(assetRoot)
    const assets = { get: files.get.bind(files), async put(ownerKey, sha256, bytes) {
      await files.put(ownerKey, sha256, bytes)
      // Publish only after both the immutable file link and new owner directory
      // are durable. Recovery still pairs this tree with the quiesced graph.
      for (const directory of [join(assetRoot, ownerKey), assetRoot]) {
        const descriptor = await open(directory, 'r')
        try { await descriptor.sync() } finally { await descriptor.close() }
      }
    } }
    const app = dependencies.express()
    app.use('/v1', dependencies.createPrivateAssetRouter(store, assets, authenticate))
    app.use('/v1', dependencies.createOperationalRouter(store, authenticate))
    server = app.listen(operationalPort, host)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxHeadersCount = 32
    const getBackend = async owner => {
      if (closed || !owner?.ownerId || !owner.userId) throw new Error('private_owner_recovery_required')
      await store.authorizeOwner({ userId: owner.userId, namespaces: ['unlinked'] }, 'unlinked', owner.ownerId)
      internalSubjects.add(owner.userId)
      const accessToken = await new SignJWT({ scope: 'unlinked:read unlinked:write', token_use: 'access' })
        .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).setIssuer(operationsIssuer).setAudience('unlinked-private-operations')
        .setSubject(owner.userId).setJti(randomUUID()).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey)
      return createNoosOwnerBackend({ baseUrl: `http://127.0.0.1:${operationalPort}/v1`, ownerId: owner.ownerId, accessToken })
    }
    return { login, getBackend, close,
      resolveOwner: identity => identity?.issuer === config.issuer ? store.resolveIdentity('unlinked', identity.issuer, identity.subject) : null,
      claimInvitation: provisioner.claim.bind(provisioner),
      complete: completionFactory({ apiKey: config.apiKey }),
    }
  } catch (error) { await close().catch(() => {}); throw error }
}
