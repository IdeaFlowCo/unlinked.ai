# Enrichment provider plan (interface only, not active)

Tracker: `unlinked-flav`. Jacob's November 16 direction: enrich profile data through APIs, using the existing Exa work and potentially paid/fallback providers.

**Status: an interface and a planner.** `mcp-server/enrichment-providers.mjs` implements no provider, calls nothing and is not imported by the runtime. The live path remains operator-published, LinkedIn-address-keyed, gaps-only datasets (docs/imported-profile-enrichment.md). Downloads still never call an enrichment service.

## Contract

- **Provider**: `{ id, paid, lookup(linkedinUrl, { signal }) }` answering `found` (observed fields and time), `not_found` (definite), or `transient` (not charged). Anything else, including a thrown error, is **uncertain**.
- **Key**: the exact canonical LinkedIn address. A name is never a lookup key.
- **Order and failover**: providers run in the configured order. Only a definite `not_found` moves on to the next one. `transient` returns `retry_later` without trying anyone else. An uncertain outcome is counted against that provider's budget, places a 24-hour hold on that person and stops, so a second paid provider is never charged for the same uncertain lookup.
- **Budgets**: per provider, per day, counted before the call. Defaults are zero. A paid provider additionally needs `activated: true`; a budget alone never calls it. `describe()` reports `ready`, `no_budget` or `not_activated` without calling anything.
- **Cache**: a hit (fields, provider, observation time) or a miss confirmed by every provider that actually ran is remembered for 30 days. A person who was not attempted (no budget, not activated) is never recorded as missing.
- **Merge** (`mergeEnrichment`): gaps only. The member's own values and their uploaded data are never replaced; each added field keeps `{ provider, observedAt }`; only the listed standard fields are accepted and nothing is invented.

## Not built / pending

Real provider adapters (the existing Exa cohort publisher is separate and unchanged), a durable ledger, runtime wiring, and any spending. No new paid provider may be activated until Jacob chooses the budget and cap.

Tests: `tests/enrichment-providers.test.mjs`.
