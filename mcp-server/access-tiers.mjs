// Account access tiers and their per-owner request allowances.
// The tier is resolved server-side from the operator-held entitlement on the
// active OperationalOwner (mcp-server/verified-access.mjs); never from input.
export const ACCESS_TIER = Object.freeze({ standard: 'standard', approved: 'approved', verified: 'verified' })

// Standard values are the long-standing defaults. Approved ("enhanced access")
// raises only per-owner allowances: cheap deterministic graph reads 5x, paid AI
// calls 3x and per-owner AI concurrency 2x. The process-wide AI in-flight
// ceiling, connection-write budgets and the daily connection-request allowance
// are deliberately unchanged, so one approved agent cannot starve other
// accounts or send more unsolicited requests. Verified bypasses these quotas.
export const TIER_LIMITS = Object.freeze({
  standard: Object.freeze({ deterministicPerMinute: 120, aiPerMinute: 20, aiPerDay: 2000, aiInFlight: 2, privateContextPerMinute: 60, peoplePickerPerMinute: 20 }),
  approved: Object.freeze({ deterministicPerMinute: 600, aiPerMinute: 60, aiPerDay: 6000, aiInFlight: 4, privateContextPerMinute: 300, peoplePickerPerMinute: 100 }),
})

export const isAccessTier = value => Object.values(ACCESS_TIER).includes(value)
// Downloads of the published network visible to the account (scope everyone/all).
export const sharedExportAllowed = tier => tier === ACCESS_TIER.verified || tier === ACCESS_TIER.approved
// Approved limits are standard limits scaled by the same factors, so a caller
// that configures custom standard limits (tests, operators) keeps the ratios.
export const APPROVED_FACTORS = Object.freeze({ deterministicPerMinute: 5, aiPerMinute: 3, aiPerDay: 3, aiInFlight: 2, privateContextPerMinute: 5, peoplePickerPerMinute: 5 })
export function limitsForTier(tier, standard = TIER_LIMITS.standard) {
  if (tier !== ACCESS_TIER.approved) return standard
  return Object.fromEntries(Object.entries(standard).map(([key, value]) => [key, APPROVED_FACTORS[key] ? value * APPROVED_FACTORS[key] : value]))
}
// Back-compat: callers that only supply isVerified get verified/standard tiers.
export const tierResolver = ({ accessTier, isVerified }) => typeof accessTier === 'function' ? accessTier
  : async owner => typeof isVerified === 'function' && await isVerified(owner) ? ACCESS_TIER.verified : ACCESS_TIER.standard
