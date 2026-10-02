import {createLegacyStorageReader} from '../src/utils/legacy-import/storage-reader.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SignJWT } from 'jose'
import { createIdeaflowLogin } from './private-browser.mjs'
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
    ...require(join(directory, 'dist/operational/access-token.js')) }
}

// Explicit private-process composition; never imported by Next.js. No operator
// capability, provider token, graph credential or operations bearer reaches a
// browser/agent. The caller supplies an isolated root and reviewed private env.
export async function createPrivatePilotDependencies({ root, baseUrl, host, operationalPort, boltUrl, dataMode, networkMode = 'loopback',
  config = { issuer: process.env.IDEAFLOW_ISSUER, clientId: process.env.IDEAFLOW_CLIENT_ID,
    clientSecret: process.env.IDEAFLOW_CLIENT_SECRET, graphPassword: process.env.NOOS_PRIVATE_PASSWORD,
    apiKey: process.env.OPENAI_API_KEY }, modules, loginFactory = createIdeaflowLogin,
  completionFactory = createResponsesCompletion, graphReadyDeadlineMs = 90000, graphReadyRetryMs = 1000 }) {
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
  let server, worker, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await worker?.stop()
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
          if (!link || !publicPeople) return null
          const snapshot = await publicPeople.read('recovered-legacy-public-v1')
          if (!snapshot || snapshot.revision !== 'legacy-public-v1:' + link.sourceSha256) throw Error('legacy_profile_source_unavailable')
          const profile = snapshot.profiles.find(value => value.id === link.profileId)
          if (!profile) throw Error('legacy_profile_source_unavailable')
          return { ...link, profile, connections: snapshot.connections.filter(edge => edge.fromId === link.profileId), profiles: snapshot.profiles, revision: snapshot.revision }
      }
      const recovery=legacyStorage?createLegacyStorageReader({owner,readOwner:legacyStorage.readOwner.bind(legacyStorage),assets:files,readLegacyProfile}):null
      return { ...backend,readLegacyProfile,
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
    const readPublishedSnapshot = publicPeople ? createMemberPublicIndex({ publicPeople, getBackend,
      readLegacy: () => publicPeople.read('recovered-legacy-public-v1'),
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
      legacyAccount: legacyLinks ? { candidate: legacyLinks.candidate.bind(legacyLinks), confirm: legacyLinks.confirm.bind(legacyLinks) } : undefined,
      // Owner-scoped parts of account deletion that live outside the resource
      // API: the legacy claim row and the owner's own staged asset directory.
      revokeLegacyLink: legacyLinks ? async owner => {
        if (!owner?.ownerId || !owner.userId) throw new Error('private_owner_recovery_required')
        const session = driver.session({ database: 'neo4j' })
        try {
          await session.executeWrite(tx => tx.run(`MATCH (a:UnlinkedLegacyAccount {ownerId:$owner,userId:$user,revoked:false})
            SET a._lock=true REMOVE a._lock SET a.revoked=true, a.revokedAt=coalesce(a.revokedAt,$now), a.revokedReason=coalesce(a.revokedReason,'owner_account_deletion')`,
          { owner: owner.ownerId, user: owner.userId, now: Date.now() }))
        } finally { await session.close() }
      } : undefined,
      // Self-serve claims for legacy profiles outside the seeded manifest: a
      // lookup hint (LinkedIn address, or the signed-in display name) selects an
      // unclaimed legacy profile, and an explicit confirmation writes a
      // self-asserted UnlinkedLegacyAccount row. The uniqueness constraints on
      // profileId/ownerId/userId/emailHash make first-claim-wins and
      // one-claim-per-account database-enforced; readBound/candidate/confirm
      // treat the row like a seeded one. Operator rollback:
      // legacy-account-operator.mjs revoke <profileId> <receiptId>.
      selfClaims: legacyLinks && publicPeople ? (() => {
        let slugs = null
        const slugIndex = () => {
          // Memoizes the promise so concurrent first lookups share one parse;
          // a failed load is not cached and a later lookup retries.
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
        const normalizedName = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : ''
        return {
          lookupSlug: async slug => { try { return (await slugIndex()).get(String(slug).toLowerCase()) ?? null } catch { return null } },
          // Names resolve only against the recovered legacy dataset, never the
          // merged shared snapshot — a member-imported contact with the same
          // name must not shadow or displace a claimable legacy profile.
          lookupName: async name => {
            const wanted = normalizedName(name)
            if (!wanted) return null
            const snapshot = await publicPeople.read('recovered-legacy-public-v1')
            if (!snapshot) return null
            const matches = snapshot.profiles.filter(profile => normalizedName(profile.name) === wanted)
            return matches.length === 1 ? matches[0].id : null
          },
          claimable: async profileId => {
            const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' })
            try { return !(await session.executeRead(tx => tx.run('MATCH (a:UnlinkedLegacyAccount {profileId:$profileId}) RETURN a LIMIT 1', { profileId }))).records.length }
            finally { await session.close() }
          },
          claim: async ({ owner, issuer, subject, emailHash, profileId, evidence }) => {
            if (!owner?.ownerId || !owner.userId || typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject || !/^[a-f0-9]{64}$/.test(emailHash ?? '') || typeof profileId !== 'string' || !profileId || !['self-asserted-linkedin-url-v1', 'self-asserted-display-name-v1'].includes(evidence)) throw new Error('self_claim_input_invalid')
            const snapshot = await publicPeople.read('recovered-legacy-public-v1')
            if (!snapshot || !snapshot.revision.startsWith('legacy-public-v1:')) throw new Error('legacy_profile_source_unavailable')
            if (!snapshot.profiles.some(profile => profile.id === profileId)) throw new Error('self_claim_profile_unknown')
            const legacyUserId = randomUUID()
            const receiptId = createHash('sha256').update(JSON.stringify({ kind: 'self-asserted-claim-v1', profileId, legacyUserId, ownerId: owner.ownerId, userId: owner.userId, issuer, subject, evidence })).digest('hex')
            const session = driver.session({ database: 'neo4j' })
            try {
              const result = await session.executeWrite(tx => tx.run(`
                OPTIONAL MATCH (p:UnlinkedLegacyAccount {profileId:$profileId})
                OPTIONAL MATCH (o:UnlinkedLegacyAccount {ownerId:$ownerId})
                OPTIONAL MATCH (u:UnlinkedLegacyAccount {userId:$userId})
                OPTIONAL MATCH (e:UnlinkedLegacyAccount {emailHash:$emailHash})
                WITH p, o, u, e WHERE p IS NULL AND o IS NULL AND u IS NULL AND e IS NULL
                CREATE (a:UnlinkedLegacyAccount {legacyUserId:$legacyUserId, profileId:$profileId, emailHash:$emailHash,
                  sourceSha256:$sourceSha256, selfAsserted:true, claimEvidence:$evidence, revoked:false,
                  ownerId:$ownerId, userId:$userId, issuer:$issuer, subject:$subject,
                  receiptId:$receiptId, confirmedAt:$now, confirmedBy:'unlinked-private-browser'})
                RETURN a.receiptId AS receiptId`,
              { profileId, ownerId: owner.ownerId, userId: owner.userId, emailHash, legacyUserId, sourceSha256: snapshot.revision.slice('legacy-public-v1:'.length), evidence, receiptId, now: Date.now() }))
              if (!result.records.length) throw new Error('self_claim_conflict')
              return { profileId, receiptId: result.records[0].get('receiptId') }
            } catch (error) {
              // A race that slips past the guard reads lands on the uniqueness
              // constraints; losing one is the same conflict, not an outage.
              if (String(error.code ?? '').includes('ConstraintValidationFailed')) throw new Error('self_claim_conflict')
              throw error
            } finally { await session.close() }
          },
        }
      })() : undefined,
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
      complete: completionFactory({ apiKey: config.apiKey }),
    }
  } catch (error) { await close().catch(() => {}); throw error }
}
