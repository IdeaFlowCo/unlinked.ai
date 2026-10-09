import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { privateId } from '../src/utils/private-import/job.mjs'

const audience = 'unlinked-account-tools-v1'

// Versioned grant-scope catalog. A grant record stores the exact tool list it
// was issued with; authentication accepts a record only when that list equals
// the catalog entry for its (version, scope). Valid historical records resolve
// to current tools within that same permission and data boundary. New permission
// categories still require explicit owner consent; viewing never rewrites a grant.
// Version 5 permits connection actions without widening owner-only reads.
const ACCOUNT_GRANT_V5 = Object.freeze({
  owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
  owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
  owner_network_and_write: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications',
    'unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request']),
  owner_network_and_public_and_write: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications',
    'unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request']),
})
// Version 6 adds one read-only, owner-scoped tool to every scope: resolve
// one of the owner's own contacts (connection id, LinkedIn address or
// published profile id) without paging. Same data boundary as the
// connections listing, so existing keys gain it without reconsent.
const ACCOUNT_GRANT_TOOL_VERSIONS_V6 = Object.freeze(Object.fromEntries(['owner_network', 'owner_network_and_public', 'owner_network_and_write', 'owner_network_and_public_and_write'].map(scope => {
  const tools = [...ACCOUNT_GRANT_V5[scope]]
  tools.splice(tools.indexOf('unlinked_list_notifications') + 1, 0, 'unlinked_lookup_contact')
  return [scope, Object.freeze(tools)]
})))
// The owner's private people notes and relations (catalog version 7). Reads
// first, then writes; order is part of the stored catalog and never changes.
export const PRIVATE_NOTES_READ_TOOLS = Object.freeze(['unlinked_get_person_private', 'unlinked_get_private_thing', 'unlinked_list_private_things', 'unlinked_search_private', 'unlinked_get_neighbourhood'])
export const PRIVATE_NOTES_WRITE_TOOLS = Object.freeze(['unlinked_save_private_thing', 'unlinked_add_private_note', 'unlinked_delete_private_note', 'unlinked_add_private_link', 'unlinked_update_private_link', 'unlinked_delete_private_link', 'unlinked_delete_private_thing'])
export const PRIVATE_NOTES_TOOLS = Object.freeze([...PRIVATE_NOTES_READ_TOOLS, ...PRIVATE_NOTES_WRITE_TOOLS])
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
  5: ACCOUNT_GRANT_V5,
  6: ACCOUNT_GRANT_TOOL_VERSIONS_V6,
  // Version 7 adds a separate permission, "Private people notes & relations"
  // (scope suffix `_and_private_notes`): the owner's own private notes and
  // relations in the Ideaflow people overlay, shared with OpenChat. It is
  // independent of connection actions. Every v6 scope keeps its exact list;
  // each gains a `_and_private_notes` twin with the private tools appended.
  // Jacob's decision (unlinked-lf4): on by default for API keys, so a valid
  // pre-v7 key (not an OAuth connection) resolves to its private-notes twin
  // without rotation; OAuth connections must consent to `private_notes`.
  7: Object.freeze(Object.fromEntries(['owner_network', 'owner_network_and_public', 'owner_network_and_write', 'owner_network_and_public_and_write'].flatMap(scope => {
    const base = Object.freeze([...ACCOUNT_GRANT_TOOL_VERSIONS_V6[scope]])
    return [[scope, base], [`${scope}_and_private_notes`, Object.freeze([...base, ...PRIVATE_NOTES_TOOLS])]]
  }))),
})
export const CURRENT_ACCOUNT_GRANT_VERSION = 7
export const accountGrantTools = (version, scope) => ACCOUNT_GRANT_TOOL_VERSIONS[version]?.[scope] ?? null
// Scope grammar: owner_network[_and_public][_and_write][_and_private_notes].
const SCOPE_PATTERN = /^owner_network(_and_public)?(_and_write)?(_and_private_notes)?$/
export function parseAccountScope(scope) {
  const match = typeof scope === 'string' ? SCOPE_PATTERN.exec(scope) : null
  return match ? { public: Boolean(match[1]), write: Boolean(match[2]), privateNotes: Boolean(match[3]) } : null
}
export const composeAccountScope = ({ public: covers = false, write = false, privateNotes = false } = {}) =>
  `owner_network${covers ? '_and_public' : ''}${write ? '_and_write' : ''}${privateNotes ? '_and_private_notes' : ''}`
// The opt-in scope that adds connection-request write tools.
export const ACCOUNT_WRITE_SCOPE = 'owner_network_and_public_and_write'
export const ACCOUNT_OWNER_WRITE_SCOPE = 'owner_network_and_write'
export const scopeAllowsConnectionActions = scope => parseAccountScope(scope)?.write === true
export const scopeAllowsPrivateNotes = scope => parseAccountScope(scope)?.privateNotes === true
export const ACCOUNT_WRITE_TOOLS = Object.freeze(['unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request'])
// Scopes that read the published People index.
export const scopeCoversPublic = scope => parseAccountScope(scope)?.public === true
// First validate the historical stored catalog; only then resolve effective
// current tools. Never normalize a malformed record into an authorized grant.
// A pre-v7 API key gains the default-on private-notes permission; a pre-v7
// OAuth connection does not (its app never asked for it: reconnect to consent).
export function effectiveAccountGrant(grant) {
  const stored = accountGrantTools(grant?.version, grant?.scope)
  if (!stored || !Array.isArray(grant?.tools) || JSON.stringify(stored) !== JSON.stringify(grant.tools)) return null
  const scope = grant.version < 7 && !grant.connection ? composeAccountScope({ ...parseAccountScope(grant.scope), privateNotes: true }) : grant.scope
  return { version: CURRENT_ACCOUNT_GRANT_VERSION, scope, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] }
}

// Deterministic jti for the one automatically prepared grant per owner, so
// provisioning is an idempotent compare-and-set and its tombstone is readable:
// a revoked automatic setup stays revoked instead of silently coming back.
const AUTO_JTI = 'account-grant-auto-v1'
const READ_ONLY_JTI = 'account-grant-read-only-v1'
const keyName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('account_grant_name_invalid')
  return value.trim()
}

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
  // The private-notes permission combines with every read/write scope.
  const grantableScopes = (publicSearchEnabled ? ['owner_network', 'owner_network_and_public', ACCOUNT_WRITE_SCOPE, ACCOUNT_OWNER_WRITE_SCOPE] : ['owner_network'])
    .flatMap(scope => [scope, `${scope}_and_private_notes`])
  // HS256 signing is deterministic, so the bearer credential for an existing
  // grant is re-derived from its durable record; viewing setup mints nothing.
  const signGrant = (id, owner, jti, issuedAt, generation) => new SignJWT({ ...(generation ? { generation } : {}), grantId: id, ownerId: owner.ownerId, token_use: 'account_tools' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
    .setSubject(owner.userId).setJti(jti).setIssuedAt(issuedAt).sign(signingKey)
  // `options.scope` selects the catalog scope (OAuth consent or Settings opt-in); `options.connection`
  // marks a grant issued to an OAuth-connected app (see mcp-server/oauth-server.mjs).
  // Connection grants are listed and revoked individually in Settings and are
  // never reused as the copyable Settings credential.
  const issueGrant = async (owner, jti = randomBytes(32).toString('hex'), options = {}) => {
    // API keys default to read access plus private notes (on by default, unlinked-lf4).
    const defaultScope = composeAccountScope({ public: publicSearchEnabled, privateNotes: true })
    // options.privateNotes switches the private-notes permission on the chosen scope.
    let scope = options.scope ?? defaultScope
    if (options.privateNotes !== undefined) {
      if (typeof options.privateNotes !== 'boolean' || !parseAccountScope(scope)) throw new Error('account_grant_scope_invalid')
      scope = composeAccountScope({ ...parseAccountScope(scope), privateNotes: options.privateNotes })
    }
    if (!grantableScopes.includes(scope)) throw new Error('account_grant_scope_invalid')
    const name = options.name === undefined ? undefined : keyName(options.name)
    const connection = options.connection === undefined ? undefined : validConnection(options.connection)
    const tools = [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)]
    const backend = await getBackend(owner), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: CURRENT_ACCOUNT_GRANT_VERSION, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now, ...(name ? { name } : {}), ...(connection ? { connection } : {}) },
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
    const derive = (record, onlyReads = readOnly) => record && !record.deleted && record.sourceOwnerId === owner.ownerId && record.payload?.kind === 'account_tool_grant' &&
      record.payload.ownerId === owner.ownerId && record.payload.userId === owner.userId && record.payload.issuer === issuer && record.payload.audience === audience &&
      typeof record.payload.jti === 'string' && Number.isSafeInteger(record.payload.issuedAt) && !record.payload.connection && effectiveAccountGrant(record.payload) &&
      (!onlyReads || !scopeAllowsConnectionActions(record.payload.scope)) ? record : null
    const ids = await backend.listAccountGrantIds()
    const records = []
    for (let start = 0; start < ids.length; start += 8) records.push(...(await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id)))).map(record => derive(record)).filter(Boolean))
    const latest = records.sort((a, b) => (b.payload.issuedAt - a.payload.issuedAt) || a.sourceId.localeCompare(b.sourceId))[0]
    const shape = record => effectiveAccountGrant(record.payload)
    if (latest) return { accessToken: await signGrant(latest.sourceId, owner, latest.payload.jti, latest.payload.issuedAt, latest.payload.generation), grantId: latest.sourceId, created: false, ...shape(latest) }
    const existing = await backend.readResource('import', autoId)
    if (existing?.deleted) return null // the owner revoked their agent access; it stays revoked
    const fallback = readOnly && derive(existing, false) && scopeAllowsConnectionActions(existing.payload.scope)
    const jti = fallback ? READ_ONLY_JTI : AUTO_JTI
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    const options = fallback ? { name: 'Read-only provisioning key', scope: composeAccountScope({ ...parseAccountScope(effectiveAccountGrant(existing.payload).scope), write: false }) } : {}
    if (fallback) {
      const stored = await backend.readResource('import', id)
      if (stored) {
        const live = derive(stored)
        if (!live) return null
        return { accessToken: await signGrant(id, owner, live.payload.jti, live.payload.issuedAt, live.payload.generation), grantId: id, created: false, ...shape(live) }
      }
    }
    try { return { ...(await issueGrant(owner, jti, options)), created: true } }
    catch (error) {
      // A concurrent visit may have provisioned — or revoked — first; the
      // durable record wins either way.
      const record = await backend.readResource('import', id)
      if (record?.deleted) return null
      const live = derive(record)
      if (!live) {
        if (fallback && derive(record, false)) return null
        throw error
      }
      return { accessToken: await signGrant(id, owner, live.payload.jti, live.payload.issuedAt, live.payload.generation), grantId: id, created: false, ...shape(live) }
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
        grant.issuedAt !== payload.iat || grant.generation !== payload.generation || !Array.isArray(grant.tools) || JSON.stringify(grant.tools) !== JSON.stringify(tools)) return { error: 'grant_revoked' }
    // agent: who writes as this grant, for provenance on private notes
    // (`agent:<key name>` or `agent:<connected app>`).
    const agent = grant.connection ? (grant.connection.app === 'An app on this computer' && grant.connection.clientName ? grant.connection.clientName : grant.connection.app)
      : grant.name ?? (grant.jti === AUTO_JTI ? 'Default key' : 'API key')
    return { grant: { ownerId: grant.ownerId, userId: grant.userId, grantId: payload.grantId, agent, ...effectiveAccountGrant(grant) } }
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
        const effective = effectiveAccountGrant(record.payload)
        if (!effective) continue
        const connection = record.payload.connection
        out.push({ id: record.sourceId, name: record.payload.name ?? (record.payload.jti === AUTO_JTI ? 'Default key' : 'Existing key'), issuedAt: record.payload.issuedAt, ...effective, ...(connection ? { connection: { app: connection.app, clientName: connection.clientName, redirectHost: connection.redirectHost } } : {}) })
      }
    }
    return out.sort((a, b) => (b.issuedAt - a.issuedAt) || a.id.localeCompare(b.id))
  }
  // Browser-owner management only. Tokens are re-derived, never stored or logged.
  const manualRecord = async (owner, id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('account_grant_not_found')
    const backend = await getBackend(owner), record = await backend.readResource('import', id), grant = record?.payload
    const tools = accountGrantTools(grant?.version, grant?.scope)
    if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || grant?.ownerId !== owner.ownerId || grant?.userId !== owner.userId ||
        grant.kind !== 'account_tool_grant' || grant.connection || grant.issuer !== issuer || grant.audience !== audience || !tools ||
        JSON.stringify(grant.tools) !== JSON.stringify(tools) || id !== privateId(owner.ownerId, 'account-grant-v1', grant.jti)) throw new Error('account_grant_not_found')
    return { backend, record }
  }
  const readKey = async (owner, id) => {
    const { record } = await manualRecord(owner, id), g = record.payload
    return { grantId: id, accessToken: await signGrant(id, owner, g.jti, g.issuedAt, g.generation), ...effectiveAccountGrant(g) }
  }
  const renameKey = async (owner, id, name) => {
    const normalized = keyName(name), { backend, record } = await manualRecord(owner, id)
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision, payload: { ...record.payload, name: normalized } })
  }
  // Switch a key's separate permissions in one CAS write. Unnamed switches
  // keep their current (effective) value, so turning connection actions on
  // or off never drops a key's default-on private notes, and vice versa.
  const setPermissions = async (owner, id, { connections, privateNotes } = {}) => {
    if (![connections, privateNotes].every(value => value === undefined || typeof value === 'boolean') || (connections && !publicSearchEnabled)) throw new Error('account_grant_scope_invalid')
    const { backend, record } = await manualRecord(owner, id)
    const current = parseAccountScope(effectiveAccountGrant(record.payload).scope)
    const scope = composeAccountScope({ ...current, ...(connections === undefined ? {} : { write: connections }), ...(privateNotes === undefined ? {} : { privateNotes }) })
    if (!grantableScopes.includes(scope)) throw new Error('account_grant_scope_invalid')
    // Identity, issue time and secret generation stay identical. CAS makes
    // permission edits race safely with rename, replacement and revocation.
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision,
      payload: { ...record.payload, version: CURRENT_ACCOUNT_GRANT_VERSION, scope, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)] } })
    return readKey(owner, id)
  }
  const setConnectionActions = (owner, id, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('account_grant_scope_invalid')
    return setPermissions(owner, id, { connections: enabled })
  }
  const replaceKey = async (owner, id) => {
    const { backend, record } = await manualRecord(owner, id)
    // One CAS replaces only this key. Failed writes leave its old token valid;
    // concurrent replacement/revocation cannot resurrect a deleted grant.
    // Keep the original scope/catalog; replacing never silently adds permissions.
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision,
      payload: { ...record.payload, generation: randomBytes(32).toString('hex') } })
    return readKey(owner, id)
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
  return { readKey, renameKey, setConnectionActions, setPermissions, replaceKey, issueGrant, ensureGrant, authenticateGrant, authenticateGrantDetailed, revoke, listGrants, revokeConnectionToken }
}
