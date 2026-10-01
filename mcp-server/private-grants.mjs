import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { privateId } from '../src/utils/private-import/job.mjs'

const audience = 'unlinked-private-tools-staging'
const toolsAllowed = ['unlinked_search_import']

// Explicit isolated staging issuer, separate from production Ideaflow identity
// and Noos operational access. Ephemeral signing keys revoke all grants on
// restart; durable owner-private records provide immediate per-grant revocation.
export function createPrivateGrantService({ issuer, privateKey, publicKey, getBackend }) {
  if (new URL(issuer).protocol !== 'https:' || !privateKey || !publicKey || typeof getBackend !== 'function') throw new Error('explicit_private_grant_issuer_required')
  return {
    async issueGrant(owner, scope) {
      if (!owner?.ownerId || !owner.userId || !Array.isArray(scope?.importIds) || scope.importIds.length !== 1 || !/^[a-f0-9]{64}$/.test(scope.importIds[0]) || !Array.isArray(scope.tools) || scope.tools.length !== 1 || scope.tools.some(tool => !toolsAllowed.includes(tool))) throw new Error('explicit_private_grant_scope_required')
      const backend = await getBackend(owner), publication = await backend.readResource('import', scope.importIds[0])
      if (!publication || publication.deleted || publication.sourceOwnerId !== owner.ownerId || !['indexed', 'partial'].includes(publication.payload?.status)) throw new Error('private_import_not_found')
      const jti = randomBytes(32).toString('hex'), id = privateId(owner.ownerId, 'agent-grant', jti), now = Math.floor(Date.now() / 1000)
      await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
        sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
        payload: { kind: 'private_tool_grant', issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
          jti, importIds: [...scope.importIds], tools: [...scope.tools], expiresAt: (now + 900) * 1000 },
      })
      return new SignJWT({ grantId: id, ownerId: owner.ownerId, token_use: 'private_tools' }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
        .setIssuer(issuer).setAudience(audience).setSubject(owner.userId).setJti(jti).setIssuedAt(now).setExpirationTime(now + 900).sign(privateKey)
    },
    async authenticateGrant(request) {
      try {
        const header = request.headers.authorization
        if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 8192) return null
        const { payload, protectedHeader } = await jwtVerify(header.slice(7), publicKey, { issuer, audience, algorithms: ['RS256'], maxTokenAge: '15m', requiredClaims: ['sub', 'jti', 'iat', 'exp'] })
        if (protectedHeader.typ !== 'at+jwt' || payload.aud !== audience || payload.token_use !== 'private_tools' || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.exp <= payload.iat || payload.exp - payload.iat > 900 || typeof payload.ownerId !== 'string' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || payload.grantId !== privateId(payload.ownerId, 'agent-grant', payload.jti)) return null
        const backend = await getBackend({ ownerId: payload.ownerId, userId: payload.sub })
        const record = await backend.readResource('import', payload.grantId), grant = record?.payload
        if (!record || record.deleted || record.sourceOwnerId !== payload.ownerId || grant?.kind !== 'private_tool_grant' || grant.ownerId !== payload.ownerId || grant.userId !== payload.sub || grant.jti !== payload.jti || grant.issuer !== issuer || grant.audience !== audience || grant.expiresAt !== payload.exp * 1000 || !Array.isArray(grant.importIds) || grant.importIds.length !== 1 || !/^[a-f0-9]{64}$/.test(grant.importIds[0]) || !Array.isArray(grant.tools) || grant.tools.length !== 1 || !toolsAllowed.includes(grant.tools[0])) return null
        const publication = await backend.readResource('import', grant.importIds[0])
        if (!publication || publication.deleted || publication.sourceOwnerId !== payload.ownerId || !['partial', 'indexed'].includes(publication.payload?.status)) return null
        return { ownerId: grant.ownerId, userId: grant.userId, importIds: [...grant.importIds], tools: [...grant.tools], expiresAt: grant.expiresAt }
      } catch { return null }
    },
    async revoke(owner, grantId) {
      const backend = await getBackend(owner), record = await backend.readResource('import', grantId)
      if (!record || record.deleted || record.sourceOwnerId !== owner.ownerId || record.payload?.kind !== 'private_tool_grant' || record.payload.userId !== owner.userId) throw new Error('private_grant_not_found')
      await backend.writeResource({ ...record, sourceRevision: record.sourceRevision + 1, expectedRevision: record.sourceRevision, deleted: true, payload: null })
    },
  }
}
