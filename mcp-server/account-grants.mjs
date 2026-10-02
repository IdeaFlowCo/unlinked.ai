import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { privateId } from '../src/utils/private-import/job.mjs'

const audience = 'unlinked-account-tools-v1'

// Versioned grant-scope catalog. A grant record stores the exact tool list it
// was issued with; authentication accepts a record only when that list equals
// the catalog entry for its (version, scope). Adding tools later means adding
// a new version here — existing records keep their stored version and tools,
// so no issued grant ever changes shape or gains capability retroactively.
export const ACCOUNT_GRANT_TOOL_VERSIONS = Object.freeze({
  1: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone']),
  }),
  2: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search']),
  }),
  // Version 3 adds two read-only tools: the owner's pending connection
  // requests and their notification feed.
  3: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
  }),
  // Version 4 keeps the version 3 read-only lists and adds one opt-in scope
  // whose grant can also send, accept, ignore and withdraw connection
  // requests. It is never a default: only an explicit choice in Settings or
  // on the OAuth consent page issues it.
  4: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
    owner_network_and_public_and_write: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications',
      'unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request']),
  }),
})
export const CURRENT_ACCOUNT_GRANT_VERSION = 4
export const accountGrantTools = (version, scope) => ACCOUNT_GRANT_TOOL_VERSIONS[version]?.[scope] ?? null
// The opt-in scope that adds connection-request write tools.
export const ACCOUNT_WRITE_SCOPE = 'owner_network_and_public_and_write'
export const ACCOUNT_WRITE_TOOLS = Object.freeze(['unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request'])
// Scopes that read the published People index.
export const scopeCoversPublic = scope => scope === 'owner_network_and_public' || scope === ACCOUNT_WRITE_SCOPE
// Tools the current catalog gives the same scope that this grant lacks. An
// empty list means the grant is up to date, even when its catalog version is
// older: a new version that only adds an opt-in scope outdates no one.
export function missingAccountGrantTools(grant) {
  const current = accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, grant?.scope)
  if (!current || !Array.isArray(grant?.tools)) return []
  return current.filter(name => !grant.tools.includes(name))
}

// Deterministic jti for the one automatically prepared grant per owner, so
// provisioning is an idempotent compare-and-set and its tombstone is readable:
// a revoked automatic setup stays revoked instead of silently coming back.
const AUTO_JTI = 'account-grant-auto-v1'

// Display and binding metadata stored on an OAuth connection grant. `app` is
// derived by the authorization server from the verified redirect URI (never the
// self-asserted client name); `clientKey` is the SHA-256 of the OAuth client_id.
function validConnection(value) {
  const text = (x, max) => typeof x === 'string' && x.length >= 1 && x.length <= max && !/[\x00-\x1f\x7f]/.test(x)
  if (!value || value.kind !== 'oauth' || !text(value.app, 80) || !(value.clientName === null || text(value.clientName, 100)) ||
      !text(value.redirectHost, 260) || typeof value.clientKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.clientKey) ||
      !(value.resource === null || text(value.resource, 260))) throw new Error('account_grant_connection_invalid')
  return { kind: 'oauth', app: value.app, clientName: value.clientName, redirectHost: value.redirectHost, clientKey: value.clientKey, resource: value.resource }
}

export function createAccountGrantService({ issuer, signingKey, getBackend, publicSearchEnabled = false }) {
  if (new URL(issuer).protocol !== 'https:' || !(signingKey instanceof Uint8Array) || signingKey.length < 32 || typeof getBackend !== 'function') throw new Error('account_grant_configuration_required')
  // The write scope needs the People index (requests are sent to published
  // profiles), so it exists only where public search does. It is grantable but
  // never the default: every caller that wants it names it explicitly.
  const grantableScopes = publicSearchEnabled ? ['owner_network', 'owner_network_and_public', ACCOUNT_WRITE_SCOPE] : ['owner_network']
  // HS256 signing is deterministic, so the bearer credential for an existing
  // grant is re-derived from its durable record; viewing setup mints nothing.
  const signGrant = (id, owner, jti, issuedAt) => new SignJWT({ grantId: id, ownerId: owner.ownerId, token_use: 'account_tools' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
    .setSubject(owner.userId).setJti(jti).setIssuedAt(issuedAt).sign(signingKey)
  // `options.scope` narrows the catalog scope (OAuth consent); `options.connection`
  // marks a grant issued to an OAuth-connected app (see mcp-server/oauth-server.mjs).
  // Connection grants are listed and revoked individually in Settings and are
  // never reused as the copyable Settings credential.
  const issueGrant = async (owner, jti = randomBytes(32).toString('hex'), options = {}) => {
    const defaultScope = publicSearchEnabled ? 'owner_network_and_public' : 'owner_network'
    const scope = options.scope ?? defaultScope
    if (!grantableScopes.includes(scope)) throw new Error('account_grant_scope_invalid')
    const connection = options.connection === undefined ? undefined : validConnection(options.connection)
    const tools = [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)]
    const backend = await getBackend(owner), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: CURRENT_ACCOUNT_GRANT_VERSION, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now, ...(connection ? { connection } : {}) },
    })
    const accessToken = await signGrant(id, owner, jti, now)
    return { accessToken, grantId: id, version: CURRENT_ACCOUNT_GRANT_VERSION, scope, tools }
  }
  // Prepare the account's setup without a click. Reuses any live grant
  // (whatever tool list its catalog version gives it — including pre-expansion
  // v1 grants) so repeated visits never mint duplicates and never clobber a
  // manually created grant. `readOnly` excludes opt-in write grants from reuse
  // for server-to-server provisioning. Mints the deterministic read-only
  // automatic grant when no eligible manual grant exists; its tombstone
  // prevents automatic reissuance. OAuth grants are never reused.
  const ensureGrant = async (owner, { readOnly = false } = {}) => {
    const backend = await getBackend(owner)
    const autoId = privateId(owner.ownerId, 'account-grant-v1', AUTO_JTI)
    const derive = record => record && !record.deleted && record.sourceOwnerId === owner.ownerId && record.payload?.kind === 'account_tool_grant' &&
      record.payload.ownerId === owner.ownerId && record.payload.userId === owner.userId && record.payload.issuer === issuer && record.payload.audience === audience &&
      typeof record.payload.jti === 'string' && Number.isSafeInteger(record.payload.issuedAt) && !record.payload.connection &&
      (!readOnly || ['owner_network', 'owner_network_and_public'].includes(record.payload.scope)) ? record : null
    const ids = await backend.listAccountGrantIds()
    const records = []
    for (let start = 0; start < ids.length; start += 8) records.push(...(await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id)))).map(derive).filter(Boolean))
    const latest = records.sort((a, b) => (b.payload.issuedAt - a.payload.issuedAt) || a.sourceId.localeCompare(b.sourceId))[0]
    // The reused grant's own catalog entry, so Settings can tell an outdated setup.
    const shape = record => ({ version: record.payload.version ?? 1, scope: record.payload.scope, tools: Array.isArray(record.payload.tools) ? [...record.payload.tools] : [] })
    if (latest) return { accessToken: await signGrant(latest.sourceId, owner, latest.payload.jti, latest.payload.issuedAt), grantId: latest.sourceId, created: false, ...shape(latest) }
    const existing = await backend.readResource('import', autoId)
    if (existing?.deleted) return null // the owner revoked their agent access; it stays revoked
    try { return { ...(await issueGrant(owner, AUTO_JTI)), created: true } }
    catch (error) {
      // A concurrent visit may have provisioned — or revoked — first; the
      // durable record wins either way.
      const record = await backend.readResource('import', autoId)
      if (record?.deleted) return null
      const live = derive(record)
      if (!live) throw error
      return { accessToken: await signGrant(autoId, owner, live.payload.jti, live.payload.issuedAt), grantId: autoId, created: false, ...shape(live) }
    }
  }
  // Distinguishes "no usable bearer identity" (not_linked) from "the identity
  // verified but its grant record no longer authorizes tools" (grant_revoked).
  const authenticateGrantDetailed = async request => {
    let payload
    try {
      const header = request.headers.authorization
      if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 8192) return { error: 'not_linked' }
      const verified = await jwtVerify(header.slice(7), signingKey, { issuer, audience, algorithms: ['HS256'], requiredClaims: ['sub', 'jti', 'iat'] })
      payload = verified.payload
      if (verified.protectedHeader.typ !== 'at+jwt' || payload.aud !== audience || payload.token_use !== 'account_tools' || !Number.isSafeInteger(payload.iat) ||
          typeof payload.ownerId !== 'string' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || payload.grantId !== privateId(payload.ownerId, 'account-grant-v1', payload.jti)) return { error: 'not_linked' }
    } catch { return { error: 'not_linked' } }
    // Infrastructure failures while reading the durable record are retryable
    // and must not tell a holder of a still-valid token that it was revoked.
    let record
    try {
      const backend = await getBackend({ ownerId: payload.ownerId, userId: payload.sub })
      record = await backend.readResource('import', payload.grantId)
    } catch { return { error: 'upstream_unavailable' } }
    const grant = record?.payload
    const tools = grant?.kind === 'account_tool_grant' ? accountGrantTools(grant.version, grant.scope) : null
    if (!record || record.deleted || record.sourceOwnerId !== payload.ownerId || grant?.kind !== 'account_tool_grant' || !tools ||
        grant.ownerId !== payload.ownerId || grant.userId !== payload.sub || grant.jti !== payload.jti || grant.issuer !== issuer || grant.audience !== audience ||
        grant.issuedAt !== payload.iat || !Array.isArray(grant.tools) || JSON.stringify(grant.tools) !== JSON.stringify(tools)) return { error: 'grant_revoked' }
    return { grant: { ownerId: grant.ownerId, userId: grant.userId, grantId: payload.grantId, tools: [...grant.tools], scope: grant.scope, version: grant.version } }
  }
  const authenticateGrant = async request => (await authenticateGrantDetailed(request)).grant ?? null
  const revoke = async (owner, grantId) => {
    if (typeof grantId !== 'string' || !/^[a-f0-9]{64}$/.test(grantId)) throw new Error('account_grant_not_found')
    const backend = await getBackend(owner), record = await backend.readResource('import', grantId)
    if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || record.payload?.kind !== 'account_tool_grant' || record.payload.userId !== owner.userId) throw new Error('account_grant_not_found')
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision, deleted: true, payload: null })
    // Disconnecting an OAuth-connected app is not an "agent access off"
    // decision for the copyable Settings credential.
    if (record.payload.connection) return
    // Revoking the last live grant is a durable "agent access off" decision,
    // even when that grant predates automatic provisioning. Record it as the
    // automatic grant's tombstone so ensureGrant never quietly re-enables
    // access on the next page view. Best-effort: a racing provision keeps a
    // live grant, which is the correct outcome for that race.
    const autoId = privateId(owner.ownerId, 'account-grant-v1', AUTO_JTI)
    // OAuth connection grants do not count: they are separate app connections.
    const remaining = await Promise.all((await backend.listAccountGrantIds()).map(id => backend.readResource('import', id)))
    const manualLeft = remaining.some(value => value && !value.deleted && value.payload?.kind === 'account_tool_grant' && !value.payload.connection)
    if (grantId !== autoId && !manualLeft && !(await backend.readResource('import', autoId))) {
      await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: autoId, sourceOwnerId: owner.ownerId,
        sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: true, payload: null }).catch(() => {})
    }
  }
  // Live grants with display metadata for Settings, newest first. Connection
  // grants carry the verified app label and connection time; never a token.
  const listGrants = async owner => {
    const backend = await getBackend(owner)
    const ids = await backend.listAccountGrantIds(), out = []
    for (let start = 0; start < ids.length; start += 8) {
      const records = await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id)))
      for (const record of records) {
        if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || record.payload?.kind !== 'account_tool_grant' || record.payload.userId !== owner.userId) continue
        const connection = record.payload.connection
        out.push({ id: record.sourceId, issuedAt: record.payload.issuedAt, scope: record.payload.scope, version: record.payload.version ?? 1, tools: Array.isArray(record.payload.tools) ? [...record.payload.tools] : [], ...(connection ? { connection: { app: connection.app, clientName: connection.clientName, redirectHost: connection.redirectHost } } : {}) })
      }
    }
    return out.sort((a, b) => (b.issuedAt - a.issuedAt) || a.id.localeCompare(b.id))
  }
  // RFC 7009 revocation by token possession, limited to the OAuth connection
  // issued to the same client. Unknown, invalid or foreign tokens are a no-op.
  const revokeConnectionToken = async (token, clientKey) => {
    const verified = await authenticateGrantDetailed({ headers: { authorization: `Bearer ${token}` } })
    if (!verified.grant) return false
    const owner = { ownerId: verified.grant.ownerId, userId: verified.grant.userId }
    const record = await (await getBackend(owner)).readResource('import', verified.grant.grantId)
    if (!record?.payload?.connection || record.payload.connection.clientKey !== clientKey) return false
    await revoke(owner, verified.grant.grantId)
    return true
  }
  return { issueGrant, ensureGrant, authenticateGrant, authenticateGrantDetailed, revoke, listGrants, revokeConnectionToken }
}
