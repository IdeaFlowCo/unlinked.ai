import { LEGACY_ACCOUNT_SOURCE_SHA256, LEGACY_ACCOUNT_PRODUCTION_MANIFEST_SHA256 } from './legacy-account-manifest.mjs'
import { createRequestDiagnostics } from './request-diagnostics.mjs'
import { createDiagnosticsStore } from './request-diagnostics-store.mjs'
import { createOpenChatConnectionSync, createNeo4jOpenChatSyncStore } from './openchat-connections.mjs'
import { validTimestamp } from '../src/utils/network-order.mjs'
import { createMessagingResolver, createMessagingSession } from './messaging.mjs'

import { withLegacyProfileDetails } from '../src/utils/public-people/profile-links.mjs'
import { createLegacyProfileBoundary } from './profile-source-boundary.mjs'
import { createSignupProfileLookup, createNeo4jSignupProfileStore, loadProfileLookupAdapter, prepareProfileLookup } from './signup-profile-lookup.mjs'
import {createLegacyStorageReader} from '../src/utils/legacy-import/storage-reader.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { cachePublicPeopleReads, publishedRevisionReader } from '../src/utils/public-people/cached-store.mjs'
import { normalizeLinkedinSlug, urlIdentityMerges } from '../src/utils/public-people/url-identity.mjs'
import { createMemberInvitations, createNeo4jInvitationStore } from './member-invitations.mjs'
import { createConnectionRequests, createNeo4jConnectionStore } from './member-connections.mjs'
import { createNotifications, createNeo4jNotificationStore } from './member-notifications.mjs'
import { createContactCards, createNeo4jContactCardStore } from './contact-card.mjs'
import { createNeo4jCompanyFactsStore } from './company-facts-store.mjs'
import { COMPANY_DATASET, createCompanyFacts } from './company-metadata.mjs'
import { createNeo4jSessionStore } from './session-store.mjs'
import { createProfilePhotoStore, PHOTO_DIRECTORY } from './profile-photos.mjs'
import { createMemberEmail, createNeo4jEmailStore, createResendTransport, emailConfig } from './member-email.mjs'
import { createSelfClaims } from './self-claims.mjs'
import { isTestProfileId, testProfile, CLAIMED_PROFILE_FOR_OWNER, OWNER_FOR_CLAIMED_PROFILE, CLAIMED_MEMBER_PROFILES } from './test-profiles.mjs'
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SignJWT } from 'jose'
import { createIdeaflowLogin, autoSignInEnabled } from './private-browser.mjs'
import { createOverlayClient } from './private-context.mjs'
import { CLIENT_ID_PATTERN } from './account-api.mjs'
import { createNoosOwnerBackend } from '../src/utils/private-import/noos-adapter.mjs'
import { createResponsesCompletion } from '../src/utils/private-import/ai-search.mjs'
import { createArchiveWorker } from '../src/utils/private-import/background-job.mjs'

export function earliestConnectionDates(invitations, requests) {
  const key = value => JSON.stringify([value.other.ownerId, value.other.userId])
  const dates = new Map()
  for (const value of [...invitations, ...requests]) {
    const at = validTimestamp(value.connectedAt)
    if (at) dates.set(key(value), Math.min(at, dates.get(key(value)) ?? at))
  }
  return invitations.map(value => dates.has(key(value)) ? { ...value, connectedAt: dates.get(key(value)) } : value)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// The overlay client and the owner's Ideaflow identity for it. Only an identity
// from this runtime's own Ideaflow issuer names an overlay owner; the reverse
// lookup is the durable OperationalOwner/OperationalIdentity binding made at
// sign-in, so sessions restored after a restart need no new sign-in.
export function privateOverlay({ secret, url, networkMode, issuer, identityForOwner, cacheMs = 300000 }) {
  // A missing or short secret leaves private context off, never the site.
  if (typeof secret !== 'string' || secret.length < 32) return {}
  const baseUrl = url || (networkMode === 'shared-noos' ? 'http://noos_api:4000/api/overlay' : null)
  if (!baseUrl) return {}
  const overlay = createOverlayClient({ baseUrl, secret })
  const cache = new Map()
  const overlayIdentity = async owner => {
    const key = `${owner.ownerId}\n${owner.userId}`, hit = cache.get(key)
    if (hit && hit.until > Date.now()) return hit.value
    const found = await identityForOwner(owner)
    const value = found && found.issuer === issuer && typeof found.subject === 'string' && found.subject ? Object.freeze({ issuer: found.issuer, subject: found.subject }) : null
    if (cache.size > 5000) cache.clear()
    cache.set(key, { value, until: Date.now() + cacheMs })
    return value
  }
  return { overlay, overlayIdentity }
}

function loadNoos(root) {
  const directory = join(root, 'runtime', 'noos'), require = createRequire(join(directory, 'package.json'))
  return { neo4j: require('neo4j-driver'), express: require('express'),
    ...require(join(directory, 'dist/operational/store.js')),
    ...require(join(directory, 'dist/operational/public-people.js')),
    ...require(join(directory, 'dist/operational/invitations.js')),
    ...require(join(directory, 'dist/operational/legacy-links.js')),
    ...require(join(directory, 'dist/operational/legacy-storage.js')),
    ...require(join(directory, 'dist/operational/router.js')),
    ...require(join(directory, 'dist/operational/assets.js')),
    ...require(join(directory, 'dist/operational/access-token.js')),
    createMemberInvitationStore: createNeo4jInvitationStore, createMemberConnectionStore: createNeo4jConnectionStore, createNotificationStore: createNeo4jNotificationStore, createContactCardStore: createNeo4jContactCardStore, createCompanyFactsStore: createNeo4jCompanyFactsStore, createSessionStore: createNeo4jSessionStore, createEmailStore: createNeo4jEmailStore }
}

// Explicit private-process composition; never imported by Next.js. No operator
// capability, provider token, graph credential or operations bearer reaches a
// browser/agent. The caller supplies an isolated root and reviewed private env.
export async function createPrivatePilotDependencies({ root, baseUrl, host, operationalPort, boltUrl, dataMode, networkMode = 'loopback',
  sharedGraphMigrationId = process.env.PILOT_SHARED_GRAPH_MIGRATION_ID, sharedGraphManifestSha256 = process.env.PILOT_SHARED_GRAPH_MANIFEST_SHA256,
  config = { issuer: process.env.IDEAFLOW_ISSUER, clientId: process.env.IDEAFLOW_CLIENT_ID,
    clientSecret: process.env.IDEAFLOW_CLIENT_SECRET, graphPassword: process.env.NOOS_PRIVATE_PASSWORD,
    apiKey: process.env.OPENAI_API_KEY }, modules, loginFactory = createIdeaflowLogin,
  completionFactory = createResponsesCompletion, graphReadyDeadlineMs = 90000, graphReadyRetryMs = 1000,
  // Email delivery (docs/email.md): UNLINKED_EMAIL_ENABLED, RESEND_API_KEY, UNLINKED_EMAIL_SECRET,
  // UNLINKED_EMAIL_FROM, UNLINKED_INVITE_EMAILS_PER_DAY.
  emailEnv = process.env, emailTransportFactory = createResendTransport, emailLog = line => process.stderr.write(`${line}\n`),
  // Optional signup profile lookup (docs/signup-profile-lookup.md): UNLINKED_PROFILE_LOOKUP_*.
  profileLookupEnv = process.env, profileLookupLoader = loadProfileLookupAdapter,
  // Automatic sign-in kill switch: UNLINKED_AUTO_SIGNIN=off.
  autoSignInEnv = process.env, diagnosticsEnv = process.env,
  // Private context from the Ideaflow people overlay: NOOS_OVERLAY_APP_UNLINKED_SECRET, NOOS_OVERLAY_URL.
  overlayEnv = process.env,
  // Shared public index freshness window: a build this young is served as-is,
  // so page views do not each rebuild the index. Revocations and publications
  // reach anonymous and member pages within the window plus one build.
  // UNLINKED_PUBLIC_INDEX_FRESH_MS=0 restores next-request rebuilds.
  publicIndexEnv = process.env }) {
  const base = new URL(baseUrl), bolt = new URL(boltUrl)
  const privateBolt = networkMode === 'loopback' ? bolt.hostname === '127.0.0.1' : ((networkMode === 'isolated-container' && bolt.hostname === 'graph') || (networkMode === 'shared-noos' && bolt.hostname === 'noos_neo4j')) && bolt.port === '7687'
  if (!isAbsolute(root) || host !== '127.0.0.1' || base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      bolt.protocol !== 'bolt:' || !privateBolt || !bolt.port || bolt.pathname || bolt.search || bolt.hash || bolt.username || bolt.password ||
      !Number.isSafeInteger(operationalPort) || operationalPort < 7000 || operationalPort > 9999 || !['synthetic', 'private_live'].includes(dataMode) ||
      !Number.isSafeInteger(graphReadyDeadlineMs) || graphReadyDeadlineMs < 1 || graphReadyDeadlineMs > 90000 ||
      !Number.isSafeInteger(graphReadyRetryMs) || graphReadyRetryMs < 1 || graphReadyRetryMs > graphReadyDeadlineMs ||
      ['issuer', 'clientId', 'clientSecret', 'graphPassword', 'apiKey'].some(key => typeof config[key] !== 'string' || !config[key])) throw new Error('private_composition_configuration_required')
  if (dataMode === 'private_live' && (root !== '/srv/unlinked-private-guest-pilot-20261001' || !['https://private.unlinked.ai', 'https://www.unlinked.ai'].includes(base.origin) ||
      config.issuer !== 'https://id.ideaflow.app/api/auth' || bolt.port !== (networkMode === 'loopback' ? '9289' : '7687') || operationalPort !== 9022)) throw new Error('private_composition_target_required')
  if (networkMode === 'shared-noos' && (typeof sharedGraphMigrationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sharedGraphMigrationId) || typeof sharedGraphManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sharedGraphManifestSha256))) throw new Error('shared_graph_verified_migration_required')
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('private_composition_root_required')
  const dependencies = modules ?? loadNoos(root)
  const driver = dependencies.neo4j.driver(boltUrl, dependencies.neo4j.auth.basic('neo4j', config.graphPassword),
    { connectionTimeout: 3000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  let server, worker, memberEmail, diagnosticsStore, connectionSync, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await diagnosticsStore?.close()
    await connectionSync?.stop()
    await worker?.stop()
    await memberEmail?.stop()
    if (server?.listening) {
      server.closeIdleConnections?.(); server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
    await driver.close()
  }
  try {
    const deadline = Date.now() + graphReadyDeadlineMs
    for (;;) {
      try { await driver.verifyConnectivity(); break }
      catch {
        if (Date.now() + graphReadyRetryMs > deadline) throw new Error('private_graph_not_ready')
        await wait(graphReadyRetryMs)
      }
    }
    if (networkMode === 'shared-noos') {
      const session = driver.session({ database: 'neo4j', defaultAccessMode: 'WRITE' })
      try {
        // Fence rollback before the first application write, including schema initialization.
        // A duplicate receipt must not activate either checkpoint.
        const result = await session.run('MATCH (candidate:UnlinkedGraphMigration {id:$id,manifestHash:$manifestHash}) WITH collect(candidate) AS receipts WHERE size(receipts)=1 WITH receipts[0] AS m SET m._lock=true REMOVE m._lock WITH m WHERE m.status="verified" SET m.activatedAt=coalesce(m.activatedAt,timestamp()) RETURN m.id AS id,m.manifestHash AS manifestHash,m.status AS status', { id: sharedGraphMigrationId, manifestHash: sharedGraphManifestSha256 })
        if (result.records.length !== 1 || result.records[0].get('id') !== sharedGraphMigrationId || result.records[0].get('manifestHash') !== sharedGraphManifestSha256 || result.records[0].get('status') !== 'verified') throw new Error('shared_graph_verified_migration_required')
      } finally { await session.close() }
    }
    const store = new dependencies.OperationalStore(driver, 'neo4j')
    const provisioner = new dependencies.InvitedOwnerProvisioner(driver, 'neo4j', {
      role: 'callback', actorId: 'unlinked-private-browser', issuer: config.issuer, clientId: config.clientId,
    })
    await provisioner.initialize()
    await store.initialize()
    const publicPeopleStore = typeof dependencies.UnlinkedPublicPeopleStore === 'function' ? new dependencies.UnlinkedPublicPeopleStore(driver, 'neo4j') : null
    await publicPeopleStore?.initialize()
    // Reuses an unchanged published revision instead of re-reading its chunks.
    const publicPeople = cachePublicPeopleReads(publicPeopleStore, publishedRevisionReader(driver, 'neo4j'))
    const signupLookupStore = publicPeople ? createNeo4jSignupProfileStore(driver) : null
    await signupLookupStore?.initialize()
    // The adapter loads once; any failed check leaves lookups off while
    // already confirmed sources stay readable.
    const lookup = signupLookupStore ? await prepareProfileLookup({ env: profileLookupEnv, load: profileLookupLoader, log: emailLog }) : null
    const signupLookup = signupLookupStore ? createSignupProfileLookup({ store: signupLookupStore, ...lookup }) : undefined
    const legacyBoundary = publicPeople ? createLegacyProfileBoundary(driver) : null
    const legacyLinks = typeof dependencies.UnlinkedLegacyLinks === 'function' ? new dependencies.UnlinkedLegacyLinks(legacyBoundary?.driver ?? driver, 'neo4j', { role: 'callback', actorId: 'unlinked-private-browser', issuer: config.issuer, clientId: config.clientId }) : null
    await legacyLinks?.initialize()
    // Member-delivered invites, when the runtime supplies their graph store.
    const invitationStore = typeof dependencies.createMemberInvitationStore === 'function' ? dependencies.createMemberInvitationStore(driver, 'neo4j') : null
    await invitationStore?.initialize()
    // The per-account notification feed and member-to-member connection
    // requests, when the runtime supplies their graph stores.
    const notificationStore = typeof dependencies.createNotificationStore === 'function' ? dependencies.createNotificationStore(driver, 'neo4j') : null
    await notificationStore?.initialize()
    const notifications = notificationStore ? createNotifications({ store: notificationStore }) : undefined
    // Each member's contact card (phone, WhatsApp, email), shared only by its link.
    const contactCardStore = typeof dependencies.createContactCardStore === 'function' ? dependencies.createContactCardStore(driver, 'neo4j') : null
    await contactCardStore?.initialize()
    const contactCards = contactCardStore ? createContactCards({ store: contactCardStore }) : undefined
    // Operator-published company facts (docs/company-facts.md), merged over the
    // static list with a 60 s cache; a failed read serves the static list.
    const companyFactsStore = typeof dependencies.createCompanyFactsStore === 'function' ? dependencies.createCompanyFactsStore(driver, 'neo4j') : null
    await companyFactsStore?.initialize()
    const lookupCompanyFacts = companyFactsStore ? createCompanyFacts({ readDataset: () => companyFactsStore.read(COMPANY_DATASET), onError: () => process.stderr.write('unlinked_company_facts_read_failed: serving the static list\n') }) : undefined
    // Member email, when the runtime supplies its private store.
    // Without RESEND_API_KEY (or with UNLINKED_EMAIL_ENABLED=false) nothing is
    // sent and no address is recorded; unsubscribe links keep working. Without
    // a usable UNLINKED_EMAIL_SECRET the feature is absent (no routes, no sending).
    const emailStore = typeof dependencies.createEmailStore === 'function' ? dependencies.createEmailStore(driver, 'neo4j') : null
    await emailStore?.initialize()
    const emailSettings = emailStore ? emailConfig(emailEnv) : null
    // One non-secret line when an operator configured a key but email cannot run.
    if (emailSettings?.problem) emailLog(`unlinked_email_disabled: ${emailSettings.problem === 'email_secret_missing_or_short' ? 'UNLINKED_EMAIL_SECRET is missing or shorter than 32 bytes' : 'UNLINKED_EMAIL_FROM is invalid'}`)
    if (emailStore && emailSettings.secret) {
      const settings = emailSettings
      let lastReport = 0
      memberEmail = createMemberEmail({ config: settings, transport: settings.enabled ? emailTransportFactory({ apiKey: settings.apiKey }) : null, store: emailStore, notificationStore,
        secret: settings.secret, origin: base.origin,
        hasLinkedInUpload: async owner => {
          const backend = await getBackend(owner)
          // A durable upload receipt stops reminders while parsing continues;
          // original files recovered from an old account count too.
          for (const id of await backend.listImportJobIds()) {
            const receipt = await backend.readResource('import', id)
            if (receipt && !receipt.deleted && receipt.sourceOwnerId === owner.ownerId && receipt.payload?.origin?.kind !== 'added-person') return true
          }
          return (await backend.readLegacyFiles?.())?.objects?.length > 0
        },
        // Failures carry only a code; at most one audit row per ten minutes.
        onError: event => { if (Date.now() - lastReport < 600000) return; lastReport = Date.now(); return audit({ ...event, at: new Date().toISOString() }) } })
    }
    const sessionStore = typeof dependencies.createSessionStore === 'function' ? dependencies.createSessionStore(driver, 'neo4j') : null
    await sessionStore?.initialize()
    const connectionStore = typeof dependencies.createMemberConnectionStore === 'function' ? dependencies.createMemberConnectionStore(driver, 'neo4j') : null
    await connectionStore?.initialize()
    const memberConnections = connectionStore ? createConnectionRequests({ store: connectionStore, notifications: notifications ?? null, onAccepted: () => connectionSync?.wake() }) : undefined
    const memberInvitations = invitationStore ? createMemberInvitations({ store: invitationStore, onHeavyUse: event => audit({ ...event, at: new Date().toISOString() }),
      // The inviter hears that their invite was accepted (and so that the invitee joined).
      onAccepted: notifications ? async value => notifications.notify({ recipient: value.inviter, kind: 'invite_accepted', actor: value.invitee, actorName: value.inviteeName,
        ...await publicProfileIdFor(value.invitee).then(id => id ? { actorProfileId: id } : {}, () => ({})), subjectId: value.invitationId, dedupeKey: `invite-accepted:${value.invitationId}` }) : undefined }) : undefined
    // Public identity source precedence is owned by docs/signup-profile-lookup.md.
    const publicProfileIdFor = async owner => {
      const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
      try {
        const claimed = await session.executeRead(tx => tx.run(CLAIMED_PROFILE_FOR_OWNER, owner))
        if (claimed.records.length === 1) return claimed.records[0].get('id')
        const imported = await session.executeRead(tx => tx.run(`MATCH (r:OperationalResource {namespace: 'unlinked', type: 'import', publicationOwner: $ownerId, userId: $userId})
          WHERE r.document CONTAINS '"version":"public-professional-archive-openai-v2"'
          MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: $ownerId, userId: $userId}) WHERE coalesce(b.active, true) = true
          RETURN r.sourceId AS id, r.document AS document ORDER BY id`, owner))
        const live = imported.records.map(record => ({ id: record.get('id'), document: JSON.parse(record.get('document')) }))
          .filter(value => !value.document.deleted && value.document.payload?.consent?.publicProfessionalSearch === true)
          .sort((a, b) => (b.document.payload?.createdAt ?? 0) - (a.document.payload?.createdAt ?? 0))
        const signup = await signupLookup?.read(owner)
        return signup ? signup.profile.id : live.length ? 'member-import-' + live[0].id : null
      } finally { await session.close() }
    }
    // Resolve account authority from live source ownership, never from public
    // profile fields. Shadows, revoked claims and inactive owners have none.
    const accountForProfile = async profileId => {
      if (typeof profileId !== 'string' || !profileId || profileId.length > 160) return null
      const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
      try {
        if (/^member-signup-[a-f0-9]{64}$/.test(profileId)) {
          const sources = await signupLookup?.list() ?? []
          return sources.find(source => source.profile.id === profileId)?.owner ?? null
        }
        const imported = profileId.match(/^member-import-([a-f0-9]{64})$/)
        const result = imported
          ? await session.executeRead(tx => tx.run(`MATCH (r:OperationalResource {namespace: 'unlinked', type: 'import', sourceId: $id}) WHERE r.publicationOwner IS NOT NULL
              MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: r.publicationOwner}) WHERE b.userId = r.userId AND coalesce(b.active, true) = true
              RETURN DISTINCT b.sourceOwnerId AS ownerId, b.userId AS userId LIMIT 2`, { id: imported[1] }))
          : await session.executeRead(tx => tx.run(OWNER_FOR_CLAIMED_PROFILE, { id: profileId }))
        return result.records.length === 1 ? { ownerId: result.records[0].get('ownerId'), userId: result.records[0].get('userId') } : null
      } finally { await session.close() }
    }
    const publicProfileResolver = () => {
      const known = new Map()
      return async owner => {
        const key = `${owner.ownerId}\u0000${owner.userId}`
        if (!known.has(key)) known.set(key, await publicProfileIdFor(owner))
        return known.get(key)
      }
    }
    const legacyStorage=typeof dependencies.UnlinkedLegacyStorageStore==='function'?new dependencies.UnlinkedLegacyStorageStore(driver,'neo4j','callback'):null
    await legacyStorage?.initialize()
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
      const backend = createNoosOwnerBackend({ baseUrl: `http://127.0.0.1:${operationalPort}/v1`, ownerId: owner.ownerId, accessToken })
      const readLegacyProfile=async()=>{
          const link = await legacyLinks?.readBound(owner.ownerId, owner.userId)
          // A test-profile claim is never a legacy anchor: no public profile,
          // network, export or agent reader sees it (readTestProfileClaim does).
          if (!link || !publicPeople || isTestProfileId(link.profileId)) return null
          const snapshot = await publicPeople.read('recovered-legacy-public-v1')
          if (!snapshot || snapshot.revision !== 'legacy-public-v1:' + link.sourceSha256) throw Error('legacy_profile_source_unavailable')
          const profile = snapshot.profiles.find(value => value.id === link.profileId)
          if (!profile) throw Error('legacy_profile_source_unavailable')
          return { ...link, profile, connections: snapshot.connections.filter(edge => edge.fromId === link.profileId), profiles: snapshot.profiles, revision: snapshot.revision }
      }
      const recovery=legacyStorage?createLegacyStorageReader({owner,readOwner:legacyStorage.readOwner.bind(legacyStorage),assets:files,readLegacyProfile}):null
      // People this account is connected to through accepted invites.
      const readInviteConnections = memberInvitations ? async () => {
        const resolve = publicProfileResolver(), rows = []
        const invited = earliestConnectionDates(await memberInvitations.connections(owner), memberConnections ? await memberConnections.connections(owner) : [])
        for (const value of invited) rows.push({ ...value, publicProfileId: await resolve(value.other) })
        return rows
      } : undefined
      // People this account is connected to through accepted connection
      // requests; someone already connected through an invite is listed once.
      const readMemberConnections = memberConnections ? async () => {
        const resolve = publicProfileResolver(), rows = []
        const invited = new Set(memberInvitations ? (await memberInvitations.connections(owner)).map(value => `${value.other.ownerId}\u0000${value.other.userId}`) : [])
        for (const value of await memberConnections.connections(owner)) {
          if (invited.has(`${value.other.ownerId}\u0000${value.other.userId}`)) continue
          rows.push({ ...value, publicProfileId: await resolve(value.other) })
        }
        return rows
      } : undefined
      // The account's claim on a test profile, for its own /profile page only.
      const readTestProfileClaim = async () => {
        const link = await legacyLinks?.readBound(owner.ownerId, owner.userId)
        const test = link ? testProfile(link.profileId) : null
        return test ? { profileId: test.id, name: test.name, headline: test.headline, receiptId: link.receiptId } : null
      }
      return { ...backend,readLegacyProfile,readTestProfileClaim,...(readInviteConnections ? { readInviteConnections } : {}),...(readMemberConnections ? { readMemberConnections } : {}),
        ...(recovery?{readLegacyFiles:recovery.list,readLegacyOriginal:recovery.readOriginal,readLegacyObservations:recovery.observations}:{}),
        listImportIds: () => store.listImportIds({ userId: owner.userId, namespaces: ['unlinked'] }, owner.ownerId),
        listImportJobIds: () => store.listImportJobIds({ userId: owner.userId, namespaces: ['unlinked'] }, owner.ownerId),
        listAccountGrantIds: () => store.listAccountGrantIds({ userId: owner.userId, namespaces: ['unlinked'] }, owner.ownerId),
      }
    }
    let requestDiagnostics
    if (diagnosticsEnv.UNLINKED_REQUEST_DIAGNOSTICS === 'on') {
      const auditDirectory = join(root, 'audit')
      await mkdir(auditDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const auditStat = await lstat(auditDirectory)
      if (!auditStat.isDirectory() || auditStat.isSymbolicLink() || (auditStat.mode & 0o777) !== 0o700 || auditStat.uid !== process.getuid()) throw new Error('diagnostics_audit_directory_not_private')
      diagnosticsStore = await createDiagnosticsStore({ directory: join(auditDirectory, 'requests') })
      requestDiagnostics = createRequestDiagnostics({ emit: diagnosticsStore.emit })
    }
    const audit = async event => {
      const directory = join(root, 'audit')
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const state = await lstat(directory)
      if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) || state.uid !== process.getuid?.()) throw new Error('private_audit_directory_required')
      const descriptor = await open(join(directory, 'browser-events.jsonl'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        const stat = await descriptor.stat()
        if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('private_audit_file_required')
        const line = JSON.stringify(event) + '\n'
        if (stat.size + Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('private_audit_capacity')
        await descriptor.write(line); await descriptor.sync()
      } finally { await descriptor.close() }
    }
    if (typeof store.listPendingImportJobs !== 'function' || typeof store.listImportJobIds !== 'function') throw new Error('private_background_store_required')
    worker = createArchiveWorker({ listPendingImports: () => store.listPendingImportJobs(Date.now()), getBackend,
      onError: event => audit({ ...event, at: new Date().toISOString() }) })
    worker.start()
    // The notification mailer runs on its own timer; startup never waits for it.
    memberEmail?.start()
    // Private LinkedIn slug -> legacy profile index, from the recovered source
    // manifests. Shared by find-me and import identity. Memoizes the promise so
    // concurrent first lookups share one parse; a failed load retries later.
    let slugs = null
    const slugIndex = () => {
      if (!slugs) slugs = (async () => {
        const directory = join(root, 'audit')
        const names = (await readdir(directory)).filter(name => /^legacy-public-source-manifest-[a-f0-9]{64}\.json$/.test(name)).sort()
        const index = new Map()
        for (const name of names) {
          const manifest = JSON.parse(await readFile(join(directory, name), 'utf8'))
          for (const row of manifest.profiles ?? []) {
            // Keys are canonical (decoded, lowercased) like linkedinSlug(): unlinked-ade.
            const slug = row.linkedinSlug && row.legacyId ? normalizeLinkedinSlug(String(row.linkedinSlug)) : null
            if (slug) index.set(slug, row.legacyId)
          }
        }
        return index
      })().catch(error => { slugs = null; throw error })
      return slugs
    }
    // Each published import's minted people and their LinkedIn addresses, read
    // once per dataset revision (published imports never change in place).
    const importRows = new Map()
    const readImportRows = async session => {
      const datasets = (await session.executeRead(tx => tx.run("MATCH (p:UnlinkedPublicDataset) WHERE p.id STARTS WITH 'public-import-' RETURN p.id AS id, p.revision AS revision ORDER BY id LIMIT 1001"))).records
      const rows = []
      for (const dataset of datasets) {
        const key = `${dataset.get('id')}@${dataset.get('revision')}`
        if (!importRows.has(key)) {
          const chunks = await session.executeRead(tx => tx.run('MATCH (c:UnlinkedPublicChunk {dataset: $id, revision: $revision}) RETURN c.json AS json', { id: dataset.get('id'), revision: dataset.get('revision') }))
          const minted = chunks.records.flatMap(record => { const value = JSON.parse(record.get('json')); return value.kind === 'profiles' ? value.rows : [] }).filter(row => typeof row.id === 'string' && row.id.startsWith('public-'))
          const documents = await session.executeRead(tx => tx.run("UNWIND $ids AS id MATCH (a:OperationalResource {namespace: 'unlinked', type: 'assertion', sourceId: id}) RETURN id, a.document AS document", { ids: minted.map(row => row.id.slice('public-'.length)) }))
          const subjects = new Map(documents.records.map(record => { let value = null; try { value = JSON.parse(record.get('document')) } catch { value = null } return [record.get('id'), value?.payload?.subject ?? null] }))
          importRows.set(key, minted.map(row => ({ publicId: row.id, subject: subjects.get(row.id.slice('public-'.length)) ?? null })))
        }
        rows.push(...importRows.get(key))
      }
      return rows
    }
    let legacyDetails = null
    const publicIndexFreshMs = publicIndexEnv.UNLINKED_PUBLIC_INDEX_FRESH_MS === undefined ? 20000 : Number(publicIndexEnv.UNLINKED_PUBLIC_INDEX_FRESH_MS)
    if (!Number.isSafeInteger(publicIndexFreshMs) || publicIndexFreshMs < 0 || publicIndexFreshMs > 300000) throw new Error('private_composition_configuration_required')
    // Past the fresh window, the kept index answers while one refresh runs
    // behind it (UNLINKED_PUBLIC_INDEX_STALE_MS, default 90 s; fresh 0 keeps
    // next-request rebuilds unless stale is set explicitly).
    const publicIndexStaleMs = publicIndexEnv.UNLINKED_PUBLIC_INDEX_STALE_MS === undefined ? (publicIndexFreshMs === 0 ? 0 : 90000) : Number(publicIndexEnv.UNLINKED_PUBLIC_INDEX_STALE_MS)
    if (!Number.isSafeInteger(publicIndexStaleMs) || publicIndexStaleMs < 0 || publicIndexStaleMs > 600000 || (publicIndexStaleMs > 0 && publicIndexStaleMs < publicIndexFreshMs)) throw new Error('private_composition_configuration_required')
    const readPublishedSnapshot = publicPeople ? createMemberPublicIndex({ publicPeople, getBackend, readSignupProfiles: signupLookup?.list,
      includeDetails: true, freshMs: publicIndexFreshMs, staleMs: publicIndexStaleMs,
      readLegacy: async () => {
        const snapshot = await publicPeople.read('recovered-legacy-public-v1')
        const digest = snapshot?.revision?.match(/^legacy-public-v1:([a-f0-9]{64})$/)?.[1]
        if (!digest) return snapshot
        try {
          if (legacyDetails?.sourceSha256 !== digest) legacyDetails = JSON.parse(await readFile(join(root, 'audit', `legacy-public-source-manifest-${digest}.json`), 'utf8'))
          return withLegacyProfileDetails(snapshot, legacyDetails)
        } catch { return snapshot }
      },
      // An accepted invite is a connection both people agreed to: it joins the
      // public graph when both accounts have a public profile.
      // An accepted connection request is the same kind of agreed connection.
      readInviteEdges: memberInvitations || memberConnections ? async () => {
        // Each account is resolved once per build, one at a time, and each pair counts once.
        const resolve = publicProfileResolver(), edges = new Map()
        const pairs = [...(memberInvitations ? (await memberInvitations.accepted()).map(value => [value.inviter, value.invitee]) : []),
          ...(memberConnections ? (await memberConnections.accepted()).map(value => [value.sender, value.recipient]) : [])]
        for (const [from, to] of pairs) {
          const fromId = await resolve(from), toId = await resolve(to)
          if (fromId && toId && fromId !== toId && !edges.has(JSON.stringify([toId, fromId]))) edges.set(JSON.stringify([fromId, toId]), { fromId, toId })
        }
        return [...edges.values()]
      } : undefined,
      // Operator merges and renames (mcp-server/profile-decisions-operator.mjs); revoked ones are ignored.
      readDecisions: async () => {
        const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
        try {
          const result = await session.executeRead(tx => tx.run(`MATCH (d:UnlinkedProfileDecision) WHERE coalesce(d.revoked, false) = false
            RETURN d.id AS id, d.kind AS kind, d.profileId AS profileId, d.survivorId AS survivorId, d.name AS name ORDER BY d.decidedAt, d.id LIMIT 5001`))
          const explicit = result.records.map(record => Object.fromEntries(['id', 'kind', 'profileId', 'survivorId', 'name'].filter(key => record.get(key) !== null).map(key => [key, record.get(key)])))
          // Imported copies of legacy people, matched by LinkedIn address only.
          let automatic = []
          try { automatic = urlIdentityMerges({ rows: await readImportRows(session), slugIndex: await slugIndex(), explicit }) } catch { automatic = [] }
          return [...explicit, ...automatic]
        } finally { await session.close() }
      },
      // Historical membership is display evidence, never an owner/login binding.
      readLegacyMembers: async () => {
        const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
        try {
          const result = await session.executeRead(tx => tx.run(`MATCH (m:UnlinkedLegacyManifest {id:'recovered-legacy-accounts-v1', manifestSha256:$manifest})
            MATCH (a:UnlinkedLegacyAccount {manifestSha256:$manifest, sourceSha256:$source, revoked:false})
            WHERE coalesce(a.selfAsserted,false)=false AND coalesce(a.testProfile,false)=false
            RETURN a.profileId AS id ORDER BY id LIMIT 82`, { manifest: LEGACY_ACCOUNT_PRODUCTION_MANIFEST_SHA256, source: LEGACY_ACCOUNT_SOURCE_SHA256 }))
          return result.records.map(record => record.get('id'))
        } finally { await session.close() }
      },
      // A legacy profile is a member's once its account claim is confirmed and the owner is active.
      readMembers: async () => {
        const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
        try {
          const result = await session.executeRead(tx => tx.run(CLAIMED_MEMBER_PROFILES))
          return result.records.map(record => record.get('id'))
        } finally { await session.close() }
      },
      discover: async () => {
        const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
        try {
          const result = await session.executeRead(tx => tx.run(`MATCH (r:OperationalResource {namespace: 'unlinked', type: 'import'})
            WHERE r.publicationOwner IS NOT NULL AND r.document CONTAINS '"version":"public-professional-archive-openai-v2"'
            MATCH (b:OperationalOwner {namespace: 'unlinked', sourceOwnerId: r.publicationOwner})
            WHERE b.userId = r.userId AND coalesce(b.active, true) = true
            RETURN r.sourceId AS id, b.sourceOwnerId AS ownerId, b.userId AS userId, r.document AS document ORDER BY id LIMIT 1001`))
          if (result.records.length > 1000) throw Error('public_member_import_limit')
          return result.records.flatMap(record => {
            const document = JSON.parse(record.get('document')), consent = document.payload?.consent
            return !document.deleted && consent?.version === 'public-professional-archive-openai-v2' && consent.publicProfessionalSearch === true
              ? [{ id:record.get('id'),owner:{ownerId:record.get('ownerId'),userId:record.get('userId')},revision:document.sourceRevision }] : []
          })
        } finally { await session.close() }
      },
    }) : undefined
    const identityForOwner = async owner => {
        const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
        try {
          const result = await session.executeRead(tx => tx.run(`MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId})
            WHERE coalesce(b.active,true)=true
            MATCH (i:OperationalIdentity {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId})
            WHERE i.issuer=b.identityIssuer AND i.subject=b.identitySubject
            RETURN i.issuer AS issuer,i.subject AS subject LIMIT 2`, owner))
          return result.records.length === 1 ? { issuer:result.records[0].get('issuer'), subject:result.records[0].get('subject') } : null
        } finally { await session.close() }
    }
    if (connectionStore) {
      connectionSync = createOpenChatConnectionSync({ store: createNeo4jOpenChatSyncStore(driver), identityForOwner, secret: process.env.UNLINKED_MESSAGING_SECRET })
      connectionSync.start()
    }
    return { login, getBackend, close, audit, requestDiagnostics, backgroundImports: true,
      // Automatic cross-app sign-in (docs/ideaflow-sign-in.md): on unless
      // runtime.env sets UNLINKED_AUTO_SIGNIN=off.
      autoSignIn: autoSignInEnabled(autoSignInEnv),
      readPublishedSnapshot,
      messagingSecret: process.env.UNLINKED_MESSAGING_SECRET || undefined,
      resolveMessagingRecipient: createMessagingResolver({ readPublishedSnapshot, accountForProfile, identityForOwner }),
      createMessagingSession: createMessagingSession({ secret: process.env.UNLINKED_MESSAGING_SECRET, identityForOwner }),
      // Read-only Ideaflow people overlay (docs/private-context.md): the owner's
      // own notes and relations, fetched from Noos with an app assertion for the
      // owner's verified Ideaflow identity. Off unless runtime.env sets
      // NOOS_OVERLAY_APP_UNLINKED_SECRET (the value Noos holds for app
      // "unlinked"); the shared-noos network reaches noos_api directly.
      ...privateOverlay({ secret: overlayEnv.NOOS_OVERLAY_APP_UNLINKED_SECRET, url: overlayEnv.NOOS_OVERLAY_URL, networkMode, issuer: config.issuer, identityForOwner }),
      // Operator-published photos (publish-profile-photos.mjs), read-only here.
      // No member hide-photo choice exists yet; when it does, pass it as
      // `hidden` so it outranks the operator set (docs/profile-photos.md).
      profilePhotos: createProfilePhotoStore({ directory: join(assetRoot, PHOTO_DIRECTORY) }),
      memberInvitations,
      memberConnections,
      notifications,
      contactCards,
      lookupCompanyFacts,
      sessionStore,
      memberEmail,
      accountForProfile,
      ownProfileId: publicProfileIdFor,
      // Someone just claimed `profileId`: tell members whose own exports listed
      // that profile. Best effort and bounded; never blocks the claim.
      notifyProfileClaimed: notifications && publicPeople ? async (profileId, claimer) => {
        if (isTestProfileId(profileId)) return 0
        const snapshot = await readPublishedSnapshot?.()
        if (!snapshot || !Array.isArray(snapshot.connections)) return 0
        const name = snapshot.profiles?.find(value => value.id === profileId)?.name
        const listers = [...new Set(snapshot.connections.filter(edge => edge.toId === profileId && edge.fromId !== profileId).map(edge => edge.fromId))].slice(0, 200)
        let sent = 0
        for (const fromId of listers) {
          // One recipient's failure never stops the rest.
          try {
            const recipient = await accountForProfile(fromId)
            if (!recipient || (recipient.ownerId === claimer?.ownerId && recipient.userId === claimer?.userId)) continue
            if (await notifications.notify({ recipient, kind: 'profile_claimed', actor: claimer, actorName: name, actorProfileId: profileId, subjectId: profileId, dedupeKey: `profile-claimed:${profileId}:${recipient.ownerId}:${recipient.userId}` })) sent++
          } catch { /* best effort */ }
        }
        return sent
      } : undefined,
      legacyAccount: legacyLinks ? { candidate: legacyLinks.candidate.bind(legacyLinks), confirm: (proof, profileId, confirmation) => legacyBoundary ? legacyBoundary.confirm(proof, profileId, () => legacyLinks.confirm(proof, profileId, confirmation)) : legacyLinks.confirm(proof, profileId, confirmation) } : undefined,
      // Owner-scoped parts of account deletion that live outside the resource
      // API: the legacy claim row and the owner's own staged asset directory.
      revokeLegacyLink: legacyLinks ? async owner => {
        if (!owner?.ownerId || !owner.userId) throw new Error('private_owner_recovery_required')
        const session = driver.session({ database: 'neo4j' })
        try {
          // A test-profile claim is removed with the account, so the test
          // profile and the address can be claimed again.
          await session.executeWrite(tx => tx.run(`MATCH (a:UnlinkedLegacyAccount {ownerId:$owner,userId:$user}) WHERE a.testProfile = true AND a.selfAsserted = true DETACH DELETE a`,
          { owner: owner.ownerId, user: owner.userId }))
          await session.executeWrite(tx => tx.run(`MATCH (a:UnlinkedLegacyAccount {ownerId:$owner,userId:$user,revoked:false})
            SET a._lock=true REMOVE a._lock SET a.revoked=true, a.revokedAt=coalesce(a.revokedAt,$now), a.revokedReason=coalesce(a.revokedReason,'owner_account_deletion')`,
          { owner: owner.ownerId, user: owner.userId, now: Date.now() }))
        } finally { await session.close() }
      } : undefined,
      // Self-serve claims, including the test-profile lane (mcp-server/self-claims.mjs).
      signupLookup,
      selfClaims: legacyLinks && publicPeople ? legacyBoundary.wrapSelfClaims(createSelfClaims({ driver: legacyBoundary.driver, publicPeople, slugIndex })) : undefined,
      removeOwnerAssets: async ownerId => {
        // Exact one-segment owner directory under the composition's asset root;
        // recovered legacy originals live under separate legacy storage keys.
        if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error('private_owner_recovery_required')
        const target = join(assetRoot, ownerId)
        let state
        try { state = await lstat(target) } catch (error) { if (error.code === 'ENOENT') return; throw error }
        if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('private_asset_root_required')
        await rm(target, { recursive: true, force: true })
      },
      ideaflowConnectorSecret: process.env.IDEAFLOW_CONNECTOR_SECRET,
      resolveOwner: identity => identity?.issuer === config.issuer ? store.resolveIdentity('unlinked', identity.issuer, identity.subject) : null,
      claimInvitation: provisioner.claim.bind(provisioner),
      signup: provisioner.signup.bind(provisioner),
      // Separate domain/audience from operational credentials. Stable across
      // process restarts; private root credential replacement revokes all grants.
      accountGrantKey: createHmac('sha256', config.graphPassword).update(`unlinked-account-tools-v1:${base.origin}`).digest(),
      // Optional server-to-server grant provisioning allow list. Format:
      // UNLINKED_AGENT_PROVISION_CLIENTS="clientId:secret,clientId2:secret2".
      // Absent/empty disables the endpoint. Only the secret's SHA-256 leaves
      // this scope; raw secrets never reach handlers, logs or audit rows.
      provisionAgentClients: (process.env.UNLINKED_AGENT_PROVISION_CLIENTS ?? '').split(',').map(entry => entry.trim()).filter(Boolean).map((entry, index) => {
        const split = entry.indexOf(':')
        const clientId = entry.slice(0, split), secret = entry.slice(split + 1)
        if (split < 1 || !CLIENT_ID_PATTERN.test(clientId) || secret.length < 32 || secret.length > 512) throw new Error(`agent_provision_client_configuration_invalid_entry_${index}`)
        return { clientId, secretSha256: createHash('sha256').update(secret).digest() }
      }),
      complete: completionFactory({ apiKey: config.apiKey }),
    }
  } catch (error) { await close().catch(() => {}); throw error }
}
