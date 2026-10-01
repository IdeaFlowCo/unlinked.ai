import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
let factory
try { factory = (await import('../mcp-server/private-grants.mjs')).createPrivateGrantService } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }

test('separate signed search-only grant consults durable owner record and publication on every request', { skip: !factory }, async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), owner = { ownerId: 'legacy-a', userId: 'noos-a' }, importId = 'a'.repeat(64)
  const records = new Map([[importId, { sourceOwnerId: owner.ownerId, payload: { id: importId, status: 'indexed', consent: COMBINED_UPLOAD_CONSENT } }]])
  const getBackend = async binding => {
    if (binding.ownerId !== owner.ownerId || binding.userId !== owner.userId) throw new Error('untrusted_binding')
    return { readResource: async (_type, id) => records.get(id), writeResource: async resource => records.set(resource.sourceId, structuredClone(resource)) }
  }
  const service = factory({ issuer: 'https://private-staging.invalid', ...keys, getBackend })
  const originalConsent = records.get(importId).payload.consent
  delete records.get(importId).payload.consent
  await assert.rejects(service.issueGrant(owner, { importIds: [importId], tools: ['unlinked_search_import'] }), /consent_required/)
  assert.equal(records.size, 1)
  records.get(importId).payload.consent = originalConsent
  const token = await service.issueGrant(owner, { importIds: [importId], tools: ['unlinked_search_import'] })
  const request = { headers: { authorization: `Bearer ${token}` } }
  assert.deepEqual((await service.authenticateGrant(request)).tools, ['unlinked_search_import'])
  const grantId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).grantId
  await assert.rejects(service.issueGrant(owner, { importIds: [importId], tools: ['unlinked_read_import'] }), /scope_required/)
  const pieces = token.split('.'); pieces[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pieces[1], 'base64url')), ownerId: 'legacy-b' })).toString('base64url')
  assert.equal(await service.authenticateGrant({ headers: { authorization: `Bearer ${pieces.join('.')}` } }), null)
  records.get(importId).deleted = true
  assert.equal(await service.authenticateGrant(request), null)
  records.get(importId).deleted = false
  assert.deepEqual(records.get(grantId).payload.consent, originalConsent)
  delete records.get(importId).payload.consent
  assert.equal(await service.authenticateGrant(request), null)
  records.get(importId).payload.consent = originalConsent
  delete records.get(grantId).payload.consent
  assert.equal(await service.authenticateGrant(request), null)
  records.get(grantId).payload.consent = originalConsent
  await service.revoke(owner, grantId)
  assert.equal(await service.authenticateGrant(request), null)
  const restarted = factory({ issuer: 'https://private-staging.invalid', ...generateKeyPairSync('rsa', { modulusLength: 2048 }), getBackend })
  assert.equal(await restarted.authenticateGrant(request), null)
})
