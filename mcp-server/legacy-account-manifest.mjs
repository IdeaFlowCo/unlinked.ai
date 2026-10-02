import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
const sourceSha256 = '21bf382c5bdd28a96193d2873c257e1acc6571a54f69b2a2286ddb6e09b78cd0'
const containerSha256 = '6f1e8c2c86881191ebb3fdea92348e7abb2ef87207b65eba01789e9f6969cca2'
const privateInventorySha256 = 'f66639961f131cd24d01ffba5c0100be49bf22b9671a428032d523ceab2500cf'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const dataRecord = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.keys(descriptors).sort().join('\0') === [...keys].sort().join('\0') && Object.values(descriptors).every(descriptor => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true)
}
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const LEGACY_ACCOUNT_SOURCE_SHA256 = sourceSha256
export const LEGACY_ACCOUNT_PRODUCTION_MANIFEST_SHA256 = '6500e2b07469e5259ab621236caa4cdad459e29e3897590de493f63b27105d42'
export function validateLegacyAccountManifest(manifest) {
  if (!dataRecord(manifest, ['version', 'sourceSha256', 'accounts']) || manifest.version !== 1 || manifest.sourceSha256 !== sourceSha256 || !Array.isArray(manifest.accounts) || manifest.accounts.length !== 81) throw Error('complete_verified_legacy_manifest_required')
  const seen = { legacyUserId: new Set(), profileId: new Set(), emailHash: new Set() }
  for (const account of manifest.accounts) {
    if (!dataRecord(account, ['legacyUserId', 'profileId', 'emailHash', 'userOrdinal', 'profileOrdinal']) || !uuid(account.legacyUserId) || !uuid(account.profileId) || !hex64(account.emailHash) || !Number.isSafeInteger(account.userOrdinal) || account.userOrdinal < 1 || !Number.isSafeInteger(account.profileOrdinal) || account.profileOrdinal < 1) throw Error('complete_verified_legacy_manifest_required')
    for (const key of Object.keys(seen)) {
      if (seen[key].has(account[key])) throw Error('complete_verified_legacy_manifest_required')
      seen[key].add(account[key])
    }
  }
  return manifest
}
export function legacyAccountManifestSha256(manifest) {
  validateLegacyAccountManifest(manifest)
  return hash(canonical({ ...manifest, accounts: [...manifest.accounts].sort((a, b) => a.legacyUserId.localeCompare(b.legacyUserId)) }))
}
export function assertProductionLegacyAccountManifest(manifest) {
  if (legacyAccountManifestSha256(manifest) !== LEGACY_ACCOUNT_PRODUCTION_MANIFEST_SHA256) throw Error('complete_verified_legacy_manifest_required')
  return manifest
}
export function createLegacyAccountManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024 || hash(bytes) !== privateInventorySha256) throw Error('verified_private_account_inventory_required')
  const inventory = JSON.parse(bytes.toString('utf8'))
  if (inventory.sourceSha256 !== sourceSha256 || inventory.sourceContainerSha256 !== containerSha256 || inventory.sourceUnmodified !== true || inventory.policy?.privateOnly !== true || inventory.coverage?.authAccounts !== 81 || inventory.accounts?.length !== 81) throw Error('complete_private_account_inventory_required')
  const accounts = inventory.accounts.map(account => {
    if (!uuid(account.legacyUserId) || typeof account.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || account.matchingProfileCount !== 1 || account.profileMatches?.length !== 1 || !uuid(account.profileMatches[0].profileId) || account.userProvenance?.table !== 'auth.users' || account.profileMatches[0].profileProvenance?.table !== 'public.profiles') throw Error('unique_legacy_account_profile_required')
    return { legacyUserId: account.legacyUserId, profileId: account.profileMatches[0].profileId, emailHash: hash(account.email.normalize('NFKC').toLowerCase()), userOrdinal: account.userProvenance.rowOrdinal, profileOrdinal: account.profileMatches[0].profileProvenance.rowOrdinal }
  })
  for (const key of ['legacyUserId', 'profileId', 'emailHash']) if (new Set(accounts.map(value => value[key])).size !== 81) throw Error('ambiguous_legacy_account_inventory')
  if (accounts.some(value => !Number.isSafeInteger(value.userOrdinal) || value.userOrdinal < 1 || !Number.isSafeInteger(value.profileOrdinal) || value.profileOrdinal < 1)) throw Error('legacy_account_provenance_required')
  // No raw email/name, auth credentials, external-provider keys or subject
  // binding enter this manifest. All81 rows remain unclaimed until confirmation.
  return validateLegacyAccountManifest({ version: 1, sourceSha256, accounts })
}
