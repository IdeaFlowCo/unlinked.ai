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
})
export const CURRENT_ACCOUNT_GRANT_VERSION = 2
export const accountGrantTools = (version, scope) => ACCOUNT_GRANT_TOOL_VERSIONS[version]?.[scope] ?? null

// Deterministic jti for the one automatically prepared grant per owner, so
// provisioning is an idempotent compare-and-set and its tombstone is readable:
// a revoked automatic setup stays revoked instead of silently coming back.
const AUTO_JTI = 'account-grant-auto-v1'

export function createAccountGrantService({ issuer, signingKey, getBackend, publicSearchEnabled = false }) {
  if (new URL(issuer).protocol !== 'https:' || !(signingKey instanceof Uint8Array) || signingKey.length < 32 || typeof getBackend !== 'function') throw new Error('account_grant_configuration_required')
  // HS256 signing is deterministic, so the bearer credential for an existing
  // grant is re-derived from its durable record; viewing setup mints nothing.
  const signGrant = (id, owner, jti, issuedAt) => new SignJWT({ grantId: id, ownerId: owner.ownerId, token_use: 'account_tools' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
    .setSubject(owner.userId).setJti(jti).setIssuedAt(issuedAt).sign(signingKey)
  const issueGrant = async (owner, jti = randomBytes(32).toString('hex')) => {
    const scope = publicSearchEnabled ? 'owner_network_and_public' : 'owner_network'
    const tools = [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)]
    const backend = await getBackend(owner), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: CURRENT_ACCOUNT_GRANT_VERSION, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now },
    })
    const accessToken = await signGrant(id, owner, jti, now)
    return { accessToken, grantId: id }
  }
  // Prepare the account's setup without a click. Reuses any live grant
  // (whatever tool list its catalog version gives it — including pre-expansion
  // v1 grants) so repeated visits never mint duplicates and never clobber a
  // manually created grant. Mints the one deterministic automatic grant only
  // when the owner has no grants at all and has never revoked the automatic
  // one; returns null once it is revoked.
  const ensureGrant = async owner => {
    const backend = await getBackend(owner)
    const autoId = privateId(owner.ownerId, 'account-grant-v1', AUTO_JTI)
    const derive = record => record && !record.deleted && record.sourceOwnerId === owner.ownerId && record.payload?.kind === 'account_tool_grant' &&
      record.payload.ownerId === owner.ownerId && record.payload.userId === owner.userId && record.payload.issuer === issuer && record.payload.audience === audience &&
      typeof record.payload.jti === 'string' && Number.isSafeInteger(record.payload.issuedAt) ? record : null
    const ids = await backend.listAccountGrantIds()
    const records = []
    for (let start = 0; start < ids.length; start += 8) records.push(...(await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id)))).map(derive).filter(Boolean))
    const latest = records.sort((a, b) => (b.payload.issuedAt - a.payload.issuedAt) || a.sourceId.localeCompare(b.sourceId))[0]
    if (latest) return { accessToken: await signGrant(latest.sourceId, owner, latest.payload.jti, latest.payload.issuedAt), grantId: latest.sourceId, created: false }
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
      return { accessToken: await signGrant(autoId, owner, live.payload.jti, live.payload.issuedAt), grantId: autoId, created: false }
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
    // Revoking the last live grant is a durable "agent access off" decision,
    // even when that grant predates automatic provisioning. Record it as the
    // automatic grant's tombstone so ensureGrant never quietly re-enables
    // access on the next page view. Best-effort: a racing provision keeps a
    // live grant, which is the correct outcome for that race.
    const autoId = privateId(owner.ownerId, 'account-grant-v1', AUTO_JTI)
    if (grantId !== autoId && !(await backend.listAccountGrantIds()).length && !(await backend.readResource('import', autoId))) {
      await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: autoId, sourceOwnerId: owner.ownerId,
        sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: true, payload: null }).catch(() => {})
    }
  }
  return { issueGrant, ensureGrant, authenticateGrant, authenticateGrantDetailed, revoke }
}
