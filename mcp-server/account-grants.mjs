import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { privateId } from '../src/utils/private-import/job.mjs'

const audience = 'unlinked-account-tools-v1'
const privateTools = ['unlinked_search_network'], publicTools = [...privateTools, 'unlinked_search_everyone']
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
    const tools = publicSearchEnabled ? publicTools : privateTools
    const scope = publicSearchEnabled ? 'owner_network_and_public' : 'owner_network'
    const backend = await getBackend(owner), now = Math.floor(Date.now() / 1000)
    const id = privateId(owner.ownerId, 'account-grant-v1', jti)
    await backend.writeResource({ namespace: 'unlinked', type: 'import', sourceId: id, sourceOwnerId: owner.ownerId,
      sourceRevision: 1, expectedRevision: null, audience: 'owner', deleted: false,
      payload: { kind: 'account_tool_grant', version: 1, issuer, audience, userId: owner.userId, ownerId: owner.ownerId,
        jti, tools, scope, issuedAt: now },
    })
    const accessToken = await signGrant(id, owner, jti, now)
    return { accessToken, grantId: id }
  }
  // Prepare the account's setup without a click. Reuses any live grant (whatever
  // tool list a later migration gives it) so repeated visits never mint
  // duplicates and never clobber a manually created grant. Mints the one
  // deterministic automatic grant only when the owner has no grants at all and
  // has never revoked the automatic one; returns null once it is revoked.
  const ensureGrant = async owner => {
    const backend = await getBackend(owner)
    const autoId = privateId(owner.ownerId, 'account-grant-v1', AUTO_JTI)
    const derive = record => record && !record.deleted && record.sourceOwnerId === owner.ownerId && record.payload?.kind === 'account_tool_grant' &&
      record.payload.ownerId === owner.ownerId && record.payload.userId === owner.userId && record.payload.issuer === issuer && record.payload.audience === audience &&
      typeof record.payload.jti === 'string' && Number.isSafeInteger(record.payload.issuedAt) ? record : null
    const ids = await backend.listAccountGrantIds()
    const records = []
    for (const id of ids) { const record = derive(await backend.readResource('import', id)); if (record) records.push(record) }
    const latest = records.sort((a, b) => (b.payload.issuedAt - a.payload.issuedAt) || a.sourceId.localeCompare(b.sourceId))[0]
    if (latest) return { accessToken: await signGrant(latest.sourceId, owner, latest.payload.jti, latest.payload.issuedAt), grantId: latest.sourceId, created: false }
    const existing = await backend.readResource('import', autoId)
    if (existing?.deleted) return null // the owner revoked the automatic setup; it stays revoked
    try { return { ...(await issueGrant(owner, AUTO_JTI)), created: true } }
    catch (error) {
      // A concurrent visit may have provisioned first; the durable record wins.
      const record = derive(await backend.readResource('import', autoId))
      if (!record) throw error
      return { accessToken: await signGrant(autoId, owner, record.payload.jti, record.payload.issuedAt), grantId: autoId, created: false }
    }
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
  return { issueGrant, ensureGrant, authenticateGrant, revoke }
}
