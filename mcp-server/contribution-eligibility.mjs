import { createHash } from 'node:crypto'
import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'

// Exact LinkedIn address only, canonicalized the same way as connection rows
// (mcp-server/connection-identity.mjs). A name is never an identity.
const slugOf = value => { if (typeof value !== 'string') return null; try { return linkedinSlug(value) ?? linkedinSlug(canonicalLinkedinUrl(value)) } catch { return null } }

// Contribution-based access: evaluation scaffolding only (unlinked-flav,
// docs/contribution-access.md). It turns one uploaded connections archive into
// a reusable eligibility RECEIPT and a PROPOSED entitlement transition.
//
// It awards nothing. Jacob has not chosen the policy (automatic after checks
// vs manual review), so AUTO_AWARD is false, nothing here writes an
// entitlement, and nothing in the runtime calls this module yet. Manually
// granted Verified / Enhanced access is never lowered or replaced by a proposal.
//
// The checks are plausibility checks. They do not prove that an archive is
// authentic and the receipt says so.

export const CONTRIBUTION_RECEIPT_VERSION = 1
export const AUTO_AWARD = false
export const CONTRIBUTION_POLICY = Object.freeze({
  minNewIdentities: 50,        // useful new people, not raw upload size
  minExactUrlShare: 0.6,       // rows that carry an exact LinkedIn address
  maxDuplicateShare: 0.2,      // repeated addresses inside one archive
  maxRows: 30000,              // LinkedIn's own connection ceiling
  maxSameDayShare: 0.5,        // connection dates all on one day look generated
})

const sha256 = value => createHash('sha256').update(value).digest('hex')
// Stored instead of addresses: a receipt never carries who is in an archive.
export const identityHash = slug => sha256('contribution-identity\u0000' + slug)
const check = (id, ok, detail) => ({ id, ok, detail })

// rows: [{ linkedinUrl?, connectedOn? }] parsed by the existing importer.
// credited: identity hashes any earlier receipt already earned credit for.
// knownShared: identity hashes already present in the shared network.
export function evaluateContribution({ owner, archiveSha256, rows, credited = new Set(), knownShared = new Set(), creditedArchives = new Set(), currentTier = 'standard', policy = CONTRIBUTION_POLICY, now = Date.now }) {
  if (typeof owner?.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) throw new Error('contribution_owner_required')
  if (typeof archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archiveSha256) || !Array.isArray(rows)) throw new Error('contribution_input_invalid')
  const seen = new Set(), days = new Map()
  let withUrl = 0, duplicates = 0, dated = 0
  for (const row of rows.slice(0, policy.maxRows + 1)) {
    const slug = slugOf(row?.linkedinUrl)
    if (slug) { withUrl++; const hash = identityHash(slug); if (seen.has(hash)) duplicates++; else seen.add(hash) }
    if (typeof row?.connectedOn === 'string' && row.connectedOn) { dated++; days.set(row.connectedOn, (days.get(row.connectedOn) ?? 0) + 1) }
  }
  const total = rows.length, distinct = seen.size
  const fresh = [...seen].filter(hash => !credited.has(hash) && !knownShared.has(hash))
  const busiest = Math.max(0, ...days.values())
  const replay = creditedArchives.has(archiveSha256)
  const checks = [
    check('format', total > 0 && total <= policy.maxRows, total === 0 ? 'no connection rows' : total > policy.maxRows ? 'more rows than a LinkedIn account can hold' : 'row count within bounds'),
    check('exact_addresses', total > 0 && withUrl / total >= policy.minExactUrlShare, `${withUrl} of ${total} rows carry an exact LinkedIn address`),
    check('duplicates', withUrl === 0 || duplicates / withUrl <= policy.maxDuplicateShare, `${duplicates} repeated addresses`),
    check('date_spread', dated < 20 || busiest / dated <= policy.maxSameDayShare, dated < 20 ? 'too few dates to judge' : `${busiest} of ${dated} dated rows share one day`),
    check('not_replayed', !replay, replay ? 'this exact archive already earned credit' : 'archive not credited before'),
    check('new_contribution', fresh.length >= policy.minNewIdentities, `${fresh.length} people not already credited or in the shared network`),
  ]
  const eligible = checks.every(entry => entry.ok)
  // A proposal never lowers or replaces an operator-granted tier.
  const proposal = eligible && currentTier === 'standard' ? { from: 'standard', to: 'approved', requires: 'operator_review' } : { from: currentTier, to: currentTier, requires: 'none' }
  return Object.freeze({
    kind: 'unlinked_contribution_receipt', version: CONTRIBUTION_RECEIPT_VERSION, evaluatedAt: now(), ownerId: owner.ownerId, userId: owner.userId, archiveSha256,
    counts: Object.freeze({ rows: total, withExactAddress: withUrl, distinctIdentities: distinct, duplicatesInArchive: duplicates, alreadyCredited: [...seen].filter(hash => credited.has(hash)).length, alreadyShared: [...seen].filter(hash => !credited.has(hash) && knownShared.has(hash)).length, newIdentities: fresh.length }),
    checks: Object.freeze(checks), eligible, proposal: Object.freeze(proposal), autoAward: AUTO_AWARD, awarded: false,
    // Credit, if a reviewer later grants it, covers exactly these identities.
    creditableIdentityHashes: Object.freeze(eligible ? fresh : []),
    limits: 'Plausibility checks only. This does not prove the archive is authentic or the uploader’s own, and it publishes nothing.',
  })
}

// The only way a receipt becomes an entitlement change is a reviewer decision
// handed to the existing operator tooling (docs/verified-access.md). This
// returns the instruction; it performs no write.
export function contributionDecision(receipt, { reviewer, approve }) {
  if (receipt?.kind !== 'unlinked_contribution_receipt' || receipt.version !== CONTRIBUTION_RECEIPT_VERSION) throw new Error('contribution_receipt_invalid')
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('contribution_reviewer_required')
  if (AUTO_AWARD !== false) throw new Error('contribution_auto_award_not_authorized')
  const grant = approve === true && receipt.eligible && receipt.proposal.requires === 'operator_review'
  return Object.freeze({ kind: 'unlinked_contribution_decision', archiveSha256: receipt.archiveSha256, ownerId: receipt.ownerId, userId: receipt.userId, reviewer: reviewer.trim(), decision: grant ? 'grant_approved_tier' : 'no_change',
    apply: grant ? 'operator runs the existing verified-access operator for this owner; then record archiveSha256 and creditableIdentityHashes as credited' : 'nothing to apply', performed: false })
}
