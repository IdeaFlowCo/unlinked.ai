import {createLegacyStorageReader} from '../src/utils/legacy-import/storage-reader.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { urlIdentityMerges } from '../src/utils/public-people/url-identity.mjs'
import { createMemberInvitations, createNeo4jInvitationStore } from './member-invitations.mjs'
import { createConnectionRequests, createNeo4jConnectionStore } from './member-connections.mjs'
import { createNotifications, createNeo4jNotificationStore } from './member-notifications.mjs'
import { createContactCards, createNeo4jContactCardStore } from './contact-card.mjs'
import { createNeo4jSessionStore } from './session-store.mjs'
import { createMemberEmail, createNeo4jEmailStore, createResendTransport, emailConfig } from './member-email.mjs'
import { createSelfClaims } from './self-claims.mjs'
import { isTestProfileId, testProfile, CLAIMED_PROFILE_FOR_OWNER, OWNER_FOR_CLAIMED_PROFILE, CLAIMED_MEMBER_PROFILES } from './test-profiles.mjs'
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SignJWT } from 'jose'
import { createIdeaflowLogin } from './private-browser.mjs'
import { CLIENT_ID_PATTERN } from './account-api.mjs'
import { createNoosOwnerBackend } from '../src/utils/private-import/noos-adapter.mjs'
import { createResponsesCompletion } from '../src/utils/private-import/ai-search.mjs'
import { createArchiveWorker } from '../src/utils/private-import/background-job.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    createMemberInvitationStore: createNeo4jInvitationStore, createMemberConnectionStore: createNeo4jConnectionStore, createNotificationStore: createNeo4jNotificationStore, createContactCardStore: createNeo4jContactCardStore, createSessionStore: createNeo4jSessionStore, createEmailStore: createNeo4jEmailStore }
}

// Explicit private-process composition; never imported by Next.js. No operator
// capability, provider token, graph credential or operations bearer reaches a
// browser/agent. The caller supplies an isolated root and reviewed private env.
export async function createPrivatePilotDependencies({ root, baseUrl, host, operationalPort, boltUrl, dataMode, networkMode = 'loopback',
  config = { issuer: process.env.IDEAFLOW_ISSUER, clientId: process.env.IDEAFLOW_CLIENT_ID,
    clientSecret: process.env.IDEAFLOW_CLIENT_SECRET, graphPassword: process.env.NOOS_PRIVATE_PASSWORD,
    apiKey: process.env.OPENAI_API_KEY }, modules, loginFactory = createIdeaflowLogin,
  completionFactory = createResponsesCompletion, graphReadyDeadlineMs = 90000, graphReadyRetryMs = 1000,
  // Email delivery (docs/email.md): UNLINKED_EMAIL_ENABLED, RESEND_API_KEY, UNLINKED_EMAIL_FROM.
  emailEnv = process.env, emailTransportFactory = createResendTransport }) {
  const base = new URL(baseUrl), bolt = new URL(boltUrl)
  const privateBolt = networkMode === 'loopback' ? bolt.hostname === '127.0.0.1' : networkMode === 'isolated-container' && bolt.hostname === 'graph' && bolt.port === '7687'
  if (!isAbsolute(root) || host !== '127.0.0.1' || base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      bolt.protocol !== 'bolt:' || !privateBolt || !bolt.port || bolt.pathname || bolt.search || bolt.hash || bolt.username || bolt.password ||
      !Number.isSafeInteger(operationalPort) || operationalPort < 7000 || operationalPort > 9999 || !['synthetic', 'private_live'].includes(dataMode) ||
      !Number.isSafeInteger(graphReadyDeadlineMs) || graphReadyDeadlineMs < 1 || graphReadyDeadlineMs > 90000 ||
      !Number.isSafeInteger(graphReadyRetryMs) || graphReadyRetryMs < 1 || graphReadyRetryMs > graphReadyDeadlineMs ||
      ['issuer', 'clientId', 'clientSecret', 'graphPassword', 'apiKey'].some(key => typeof config[key] !== 'string' || !config[key])) throw new Error('private_composition_configuration_required')
  if (dataMode === 'private_live' && (root !== '/srv/unlinked-private-guest-pilot-20261001' || !['https://private.unlinked.ai', 'https://www.unlinked.ai'].includes(base.origin) ||
      config.issuer !== 'https://id.ideaflow.app/api/auth' || bolt.port !== (networkMode === 'isolated-container' ? '7687' : '9289') || operationalPort !== 9022)) throw new Error('private_composition_target_required')
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('private_composition_root_required')
  const dependencies = modules ?? loadNoos(root)
  const driver = dependencies.neo4j.driver(boltUrl, dependencies.neo4j.auth.basic('neo4j', config.graphPassword),
    { connectionTimeout: 3000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  let server, worker, memberEmail, closed = false
  const close = async () => {
    if (closed) return
    closed = true
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
    const store = new dependencies.OperationalStore(driver, 'neo4j')
    const provisioner = new dependencies.InvitedOwnerProvisioner(driver, 'neo4j', {
      role: 'callback', actorId: 'unlinked-private-browser', issuer: config.issuer, clientId: config.clientId,
    })
    await provisioner.initialize()
    await store.initialize()
    const publicPeople = typeof dependencies.UnlinkedPublicPeopleStore === 'function' ? new dependencies.UnlinkedPublicPeopleStore(driver, 'neo4j') : null
    await publicPeople?.initialize()
    const legacyLinks = typeof dependencies.UnlinkedLegacyLinks === 'function' ? new dependencies.UnlinkedLegacyLinks(driver, 'neo4j', { role: 'callback', actorId: 'unlinked-private-browser', issuer: config.issuer, clientId: config.clientId }) : null
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
    // Invite and notification emails, when the runtime supplies their store.
    // Without RESEND_API_KEY (or with UNLINKED_EMAIL_ENABLED=false) nothing is
    // sent and no address is recorded; unsubscribe links keep working.
    const emailStore = typeof dependencies.createEmailStore === 'function' ? dependencies.createEmailStore(driver, 'neo4j') : null
    await emailStore?.initialize()
    if (emailStore) {
      const settings = emailConfig(emailEnv)
      let lastReport = 0
      memberEmail = createMemberEmail({ config: settings, transport: settings.enabled ? emailTransportFactory({ apiKey: settings.apiKey }) : null, store: emailStore, notificationStore,
        secret: createHmac('sha256', config.graphPassword).update(`unlinked-email-v1:${base.origin}`).digest(), origin: base.origin,
        // Failures carry only a code; at most one audit row per ten minutes.
        onError: event => { if (Date.now() - lastReport < 600000) return; lastReport = Date.now(); return audit({ ...event, at: new Date().toISOString() }) } })
    }
    const sessionStore = typeof dependencies.createSessionStore === 'function' ? dependencies.createSessionStore(driver, 'neo4j') : null
    await sessionStore?.initialize()
    const connectionStore = typeof dependencies.createMemberConnectionStore === 'function' ? dependencies.createMemberConnectionStore(driver, 'neo4j') : null
    await connectionStore?.initialize()
    const memberConnections = connectionStore ? createConnectionRequests({ store: connectionStore, notifications: notifications ?? null }) : undefined
    const memberInvitations = invitationStore ? createMemberInvitations({ store: invitationStore, onHeavyUse: event => audit({ ...event, at: new Date().toISOString() }),
      // The inviter hears that their invite was accepted (and so that the invitee joined).
      onAccepted: notifications ? async value => notifications.notify({ recipient: value.inviter, kind: 'invite_accepted', actor: value.invitee, actorName: value.inviteeName,
        ...await publicProfileIdFor(value.invitee).then(id => id ? { actorProfileId: id } : {}, () => ({})), subjectId: value.invitationId, dedupeKey: `invite-accepted:${value.invitationId}` }) : undefined }) : undefined
    // The public profile that stands for an account: its confirmed legacy
    // profile, else the newest public-consent import it published.
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
        return live.length ? 'member-import-' + live[0].id : null
      } finally { await session.close() }
    }
    // The account behind a public profile: the confirmed owner of a legacy
    // profile, or the publisher of a member import. Null for shadows, revoked
    // claims and inactive owners.
    const accountForProfile = async profileId => {
      if (typeof profileId !== 'string' || !profileId || profileId.length > 160) return null
      const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
      try {
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
        for (const value of await memberInvitations.connections(owner)) rows.push({ ...value, publicProfileId: await resolve(value.other) })
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
          for (const row of manifest.profiles ?? []) if (row.linkedinSlug && row.legacyId) index.set(String(row.linkedinSlug).toLowerCase(), row.legacyId)
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
    const readPublishedSnapshot = publicPeople ? createMemberPublicIndex({ publicPeople, getBackend,
      readLegacy: () => publicPeople.read('recovered-legacy-public-v1'),
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
    return { login, getBackend, close, audit, backgroundImports: true,
      readPublishedSnapshot,
      memberInvitations,
      memberConnections,
      notifications,
      contactCards,
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
      legacyAccount: legacyLinks ? { candidate: legacyLinks.candidate.bind(legacyLinks), confirm: legacyLinks.confirm.bind(legacyLinks) } : undefined,
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
      selfClaims: legacyLinks && publicPeople ? createSelfClaims({ driver, publicPeople, slugIndex }) : undefined,
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
