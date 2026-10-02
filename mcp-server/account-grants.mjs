import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { privateId } from '../src/utils/private-import/job.mjs'

const audience = 'unlinked-account-tools-v1'
const privateTools = ['unlinked_search_network'], publicTools = [...privateTools, 'unlinked_search_everyone']
export function createAccountGrantService({ issuer, signingKey, getBackend, publicSearchEnabled = false }) {
  if (new URL(issuer).protocol !== 'https:' || !(signingKey instanceof Uint8Array) || signingKey.length < 32 || typeof getBackend !== 'function') throw new Error('account_grant_configuration_required')
  const issueGrant = async owner => {
    const tools = publicSearchEnabled ? publicTools : privateTools
    const scope = publicSearchEnabled ? 'owner_network_and_public' : 'owner_network'
    const backend = await getBackend(owner), jti = randomBytes(32).toString('hex'), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: 1, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now },
    })
    const accessToken = await new SignJWT({ grantId: id, ownerId: owner.ownerId, token_use: 'account_tools' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
      .setSubject(owner.userId).setJti(jti).setIssuedAt(now).sign(signingKey)
    return { accessToken, grantId: id }
  }
  const authenticateGrant = async request => {
    try {
      const header = request.headers.authorization
      if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 8192) return null
      const { payload, protectedHeader } = await jwtVerify(header.slice(7), signingKey, { issuer, audience, algorithms: ['HS256'], requiredClaims: ['sub', 'jti', 'iat'] })
      if (protectedHeader.typ !== 'at+jwt' || payload.aud !== audience || payload.token_use !== 'account_tools' || !Number.isSafeInteger(payload.iat) ||
          typeof payload.ownerId !== 'string' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || payload.grantId !== privateId(payload.ownerId, 'account-grant-v1', payload.jti)) return null
      const backend = await getBackend({ ownerId: payload.ownerId, userId: payload.sub })
      const record = await backend.readResource('import', payload.grantId), grant = record?.payload
      if (!record || record.deleted || record.sourceOwnerId !== payload.ownerId || grant?.kind !== 'account_tool_grant' || grant.version !== 1 ||
          grant.ownerId !== payload.ownerId || grant.userId !== payload.sub || grant.jti !== payload.jti || grant.issuer !== issuer || grant.audience !== audience ||
          grant.issuedAt !== payload.iat || !['owner_network','owner_network_and_public'].includes(grant.scope) || !Array.isArray(grant.tools) ||
          JSON.stringify(grant.tools) !== JSON.stringify(grant.scope === 'owner_network' ? privateTools : publicTools)) return null
      return { ownerId: grant.ownerId, userId: grant.userId, grantId: payload.grantId, tools: [...grant.tools], scope: grant.scope }
    } catch { return null }
  }
  const revoke = async (owner, grantId) => {
    if (typeof grantId !== 'string' || !/^[a-f0-9]{64}$/.test(grantId)) throw new Error('account_grant_not_found')
    const backend = await getBackend(owner), record = await backend.readResource('import', grantId)
    if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || record.payload?.kind !== 'account_tool_grant' || record.payload.userId !== owner.userId) throw new Error('account_grant_not_found')
    await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision, deleted: true, payload: null })
  }
  return { issueGrant, authenticateGrant, revoke }
}
