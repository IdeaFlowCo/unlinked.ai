import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'
import { CONTRIBUTION_RECEIPT_VERSION } from './contribution-eligibility.mjs'

// Exact LinkedIn address only, canonicalized the same way as connection rows
// (mcp-server/connection-identity.mjs). A name is never an identity.
const slugOf = value => { if (typeof value !== 'string') return null; try { return linkedinSlug(value) ?? linkedinSlug(canonicalLinkedinUrl(value)) } catch { return null } }

// Who may receive automatic enrichment (unlinked-flav, docs/enrichment-providers.md).
// Decided by Jacob (November 16): anyone who has uploaded a validated import,
// with no manual approval. It is independent of the Pro allowlist and of the
// Standard / Enhanced / Verified tiers, and it grants or implies no tier: the
// result carries no tier, proposal or award, and nothing here writes.
//
// Not imported by the runtime. Spending still needs a configured cap, an
// activated provider and a real adapter (docs/enrichment-providers.md).

export const AUTO_ENRICHMENT_TARGETS = Object.freeze(['uploaded_contacts', 'own_profile'])
// Decided: uploaded contacts are in scope. Enrichment of the uploader's own
// profile was not asked for and stays opt-in configuration.
export const DEFAULT_AUTO_ENRICHMENT_TARGETS = Object.freeze(['uploaded_contacts'])
// The plausibility checks of the existing contribution receipt that say an
// upload is a real-looking connections archive. `new_contribution` and
// `not_replayed` are about earning access credit and do not apply here.
const IMPORT_CHECKS = ['format', 'exact_addresses', 'duplicates', 'date_spread']

// receipt: a server-side receipt from evaluateContribution for this account.
export function isValidatedImport(receipt, owner) {
  return receipt?.kind === 'unlinked_contribution_receipt' && receipt.version === CONTRIBUTION_RECEIPT_VERSION
    && receipt.ownerId === owner?.ownerId && receipt.userId === owner?.userId && typeof receipt.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.archiveSha256)
    && Number.isSafeInteger(receipt.counts?.withExactAddress) && receipt.counts.withExactAddress > 0
    && IMPORT_CHECKS.every(id => Array.isArray(receipt.checks) && receipt.checks.some(check => check?.id === id && check.ok === true))
}

export function autoEnrichmentEligibility({ owner, receipts = [], targets = DEFAULT_AUTO_ENRICHMENT_TARGETS } = {}) {
  if (typeof owner?.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) return Object.freeze({ eligible: false, reason: 'owner_required', validatedArchives: Object.freeze([]), targets: Object.freeze([]) })
  if (!Array.isArray(targets) || targets.some(target => !AUTO_ENRICHMENT_TARGETS.includes(target))) throw new Error('auto_enrichment_targets_invalid')
  // A replayed or re-uploaded archive adds nothing: eligibility is a yes/no
  // over distinct archives, never a counter, and charges are keyed per person.
  const validatedArchives = [...new Set((Array.isArray(receipts) ? receipts : []).filter(receipt => isValidatedImport(receipt, owner)).map(receipt => receipt.archiveSha256))].sort()
  const eligible = validatedArchives.length > 0
  return Object.freeze({ eligible, reason: eligible ? 'validated_import' : 'no_validated_import', validatedArchives: Object.freeze(validatedArchives), targets: Object.freeze(eligible ? AUTO_ENRICHMENT_TARGETS.filter(target => targets.includes(target)) : []) })
}

// The people an eligible account may have enriched: exact LinkedIn addresses
// only, deduplicated. Results keep the visibility of that contact's existing
// data (`visibility: 'inherit'`): an uploaded contact's enrichment is as
// private as the upload; nothing here publishes.
export function autoEnrichmentSubjects(eligibility, { ownProfileUrl, uploadedContactUrls = [] } = {}) {
  if (eligibility?.eligible !== true) return []
  const subjects = new Map()
  if (eligibility.targets.includes('own_profile')) { const slug = slugOf(ownProfileUrl); if (slug) subjects.set(slug, { slug, target: 'own_profile', visibility: 'inherit' }) }
  if (eligibility.targets.includes('uploaded_contacts')) for (const url of Array.isArray(uploadedContactUrls) ? uploadedContactUrls : []) { const slug = slugOf(url); if (slug && !subjects.has(slug)) subjects.set(slug, { slug, target: 'uploaded_contacts', visibility: 'inherit' }) }
  return [...subjects.values()].map(subject => Object.freeze(subject))
}
