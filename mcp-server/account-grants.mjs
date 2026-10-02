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
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ask']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ask']),
  }),
})
export const CURRENT_ACCOUNT_GRANT_VERSION = 2
export const accountGrantTools = (version, scope) => ACCOUNT_GRANT_TOOL_VERSIONS[version]?.[scope] ?? null

export function createAccountGrantService({ issuer, signingKey, getBackend, publicSearchEnabled = false }) {
  if (new URL(issuer).protocol !== 'https:' || !(signingKey instanceof Uint8Array) || signingKey.length < 32 || typeof getBackend !== 'function') throw new Error('account_grant_configuration_required')
  const issueGrant = async owner => {
    const scope = publicSearchEnabled ? 'owner_network_and_public' : 'owner_network'
    const tools = [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, scope)]
    const backend = await getBackend(owner), jti = randomBytes(32).toString('hex'), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: CURRENT_ACCOUNT_GRANT_VERSION, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now },
    })
    const accessToken = await new SignJWT({ grantId: id, ownerId: owner.ownerId, token_use: 'account_tools' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
      .setSubject(owner.userId).setJti(jti).setIssuedAt(now).sign(signingKey)
    return { accessToken, grantId: id }
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
    try {
      const backend = await getBackend({ ownerId: payload.ownerId, userId: payload.sub })
      const record = await backend.readResource('import', payload.grantId), grant = record?.payload
      const tools = grant?.kind === 'account_tool_grant' ? accountGrantTools(grant.version, grant.scope) : null
      if (!record || record.deleted || record.sourceOwnerId !== payload.ownerId || grant?.kind !== 'account_tool_grant' || !tools ||
          grant.ownerId !== payload.ownerId || grant.userId !== payload.sub || grant.jti !== payload.jti || grant.issuer !== issuer || grant.audience !== audience ||
          grant.issuedAt !== payload.iat || !Array.isArray(grant.tools) || JSON.stringify(grant.tools) !== JSON.stringify(tools)) return { error: 'grant_revoked' }
      return { grant: { ownerId: grant.ownerId, userId: grant.userId, grantId: payload.grantId, tools: [...grant.tools], scope: grant.scope, version: grant.version } }
    } catch { return { error: 'grant_revoked' } }
  }
  const authenticateGrant = async request => (await authenticateGrantDetailed(request)).grant ?? null
  const revoke = async (owner, grantId) => {
    if (typeof grantId !== 'string' || !/^[a-f0-9]{64}$/.test(grantId)) throw new Error('account_grant_not_found')
    const backend = await getBackend(owner), record = await backend.readResource('import', grantId)
    if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || record.payload?.kind !== 'account_tool_grant' || record.payload.userId !== owner.userId) throw new Error('account_grant_not_found')
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision, deleted: true, payload: null })
  }
  return { issueGrant, authenticateGrant, authenticateGrantDetailed, revoke }
}
