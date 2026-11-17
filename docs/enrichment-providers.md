# Enrichment provider plan (interface only, not active)

Tracker: `unlinked-flav`. Jacob's November 16 direction: enrich profile data through APIs, using the existing Exa work and potentially paid/fallback providers.

**Status: an interface, a planner, a spend ledger and an eligibility rule. Nothing is active.** `mcp-server/enrichment-providers.mjs`, `mcp-server/enrichment-spend.mjs` and `mcp-server/auto-enrichment-eligibility.mjs` implement no provider, call nothing, send no notification and are not imported by the runtime. The live path remains operator-published, LinkedIn-address-keyed, gaps-only datasets (docs/imported-profile-enrichment.md). Downloads still never call an enrichment service.

## Decided (Jacob, November 16)

> "I think for now, up to about $100/month even. Anyone who uploads, even if they're not officially approved by me, can get auto-enrichment of their contact if it's over that amount. I'm not sure, but it probably should get escalated to notify me, and then I can check on it."

Confirmed the same day:

- **Cap: $100 per month, one total shared by all users** (`PROVISIONAL_MONTHLY_CAP_CENTS = 10000`). This cap is approved and needs no further budget approval. A per-user cap was considered and not chosen; the ledger refuses `scope: 'per_user'` rather than ignoring it. Spend is still recorded per account for reporting.
- **Pause and notify before the cap.** Paid lookups stop before a request could take the month over the cap, and the owner is notified. There is no overrun path and no automatic cap increase.
- **Who: anyone with a validated import**, without manual approval, independent of the Pro allowlist and of the Standard / Enhanced / Verified tiers. It never grants or implies Enhanced, Verified or Pro.
- **What: the uploader's uploaded contacts.** Enriching the uploader's own profile was not asked for and is an opt-in target (`own_profile`), off by default.
- **Visibility is inherited.** An enrichment result for a contact has the same visibility as that contact's existing data (an uploaded contact's enrichment is as private as the upload). Source permissions are unchanged. Exact LinkedIn-address keys only; a name is never a key.

## Still required before anything runs

- **Code default is 0.** With no configuration `capCents` is 0 and nothing is reserved or called. The $100 is the decided figure to configure, not a default.
- **A paid provider needs explicit activation** (`activated: true`), a daily count budget, the USD ledger and a per-request `estimateCents`; and a **real adapter**, which does not exist yet.
- Runtime wiring: a durable store composed in the server, the import pipeline handing in receipts and uploaded addresses, a notification transport, and an operator schedule for the sweep and flush.

## Provider contract

- **Provider**: `{ id, paid, estimateCents?, lookup(linkedinUrl, { signal }) }` answering `found` (observed fields and time), `not_found` (definite), or `transient` (not charged). Anything else, including a thrown error, is **uncertain**. A `found` or `not_found` answer may report `costCents` or `costMicros`.
- **Key**: the exact canonical LinkedIn address. A name is never a lookup key.
- **Order and failover**: providers run in the configured order. Only a definite `not_found` moves on to the next one. `transient` returns `retry_later` without trying anyone else. An uncertain outcome is counted against that provider's budgets, places a 24-hour hold on that person and stops, so a second paid provider is never charged for the same uncertain lookup.
- **Daily count budgets**: per provider, per day, counted before the call. Defaults are zero. `describe()` reports `ready`, `no_budget`, `not_activated`, `no_spend_ledger`, `no_estimate` or `no_spend_cap` without calling anything.
- **USD for paid providers**: `enrich(url, { ownerId })` does reserve → call → reconcile (release when `transient`). A refusal is recorded as `spend_refused` with its reason and the provider is not called. A person already charged this month for that provider is not charged again (`already_charged`, or a repeated `not_found` that moves on to the next provider). A paid lookup needs the account it is done for (`no_owner` otherwise). Free providers bypass the USD ledger and keep only their count budget.
- **Cache**: a hit (fields, provider, observation time) or a miss confirmed by every provider that actually ran is remembered for 30 days. A person who was not attempted is never recorded as missing.
- **Merge** (`mergeEnrichment`): gaps only. The member's own values and their uploaded data are never replaced; each added field keeps `{ provider, observedAt }`; only the listed standard fields are accepted and nothing is invented.

## Monthly USD ledger (`mcp-server/enrichment-spend.mjs`)

- **What it counts**: incremental per-request spend only. Existing provider **subscription fees are not in this ledger** and do not count against the $100.
- **Money** is integer micro-dollars (1 cent = 10,000 micros); never a float, including in the graph (`toInteger`). Months are UTC calendar months (`YYYY-MM`).
- **`reserve({ ownerId, provider, subject | requestId, estimateCents })`** before any request, atomically: `spent + in flight + this worst case ≤ cap`. The worst case is the estimate plus the reconcile tolerance (default 20%), so an actual inside the tolerance can never cross the cap. Outcomes: `reserved`; `existing` (this key is in flight or already charged: make no request); `refused` with `no_budget` (cap 0), `cap_reached` or `provider_suspended`.
- **Idempotency**: one reservation per key, `month + person + provider` (the person is stored as a salted hash, not the address) or `month + caller request id + provider`. A repeat returns the existing reservation and never double-counts. A fallback provider has its own key, so each provider's attempt is counted once. A retry after a release reopens the same key with a new attempt number; a stale handle cannot settle it.
- **`reconcile(reservation, { outcome, costCents | costMicros })`** settles to the reported actual, lower or higher. Above the estimate is flagged `above_estimate`. Above the tolerance is recorded truthfully, flagged `above_tolerance` (and `over_cap` if the month is now over the cap), pauses that provider for the rest of the month and notifies. An `uncertain` outcome, or no valid reported cost, settles at the full estimate. Repeats change nothing.
- **`release(reservation, { reason: 'transient' | 'not_sent' })`** only for outcomes that provably cost nothing.
- **`sweepStale()`**: a reservation older than 15 minutes (a crashed worker) is settled at its estimate and flagged `stale`; it is never released. A truthful late report may correct it once.
- **`summary(month)`**: cap, spent, in flight, remaining, amount over the cap, per provider, per account, refused (paused) requests, flagged entries and notices.
- **Stores**: `createMemoryEnrichmentSpendStore` and `createNeo4jEnrichmentSpendStore` share one transaction interface and the ledger logic is written once over it. In Neo4j each write transaction first takes the write lock on the month node (`UnlinkedEnrichmentSpendMonth`) or notice, which serializes reservations for the month. Labels `UnlinkedEnrichmentSpendMonth`, `UnlinkedEnrichmentSpend`, `UnlinkedEnrichmentNotice` are in `deploy/private-pilot/graph-migration.mjs` `LABELS` with uniqueness constraints.

## Budget notifications

- A durable outbox entry, labelled `kind: 'enrichment_budget'` so a transport can route it apart from signup notifications, is written **once** per month and reason: each threshold crossed (`threshold`, default 80% and 100% of the cap, on spent + in flight), the first refusal at the cap (`cap_reached`), and a provider paused for an over-tolerance cost (`provider_over_tolerance`).
- Each entry has a stable id (for example `2026-11:threshold:80`), month, spend, in flight, cap, refused count and a proposed-extension text that says nothing increases automatically. While pending its figures are refreshed; a sent entry is never recreated.
- `flushNotifications()` delivers pending and failed entries through an injected `notifier.deliver(entry)` (no transport is built). Each delivery is claimed first, so concurrent flushes deliver once; failures are retried with an attempt count up to 5. Nothing calls it automatically. Without a notifier it reports `no_notifier` and changes nothing.

## Eligibility (`mcp-server/auto-enrichment-eligibility.mjs`)

- `autoEnrichmentEligibility({ owner, receipts, targets })`: eligible when the account has at least one **validated import**, meaning a contribution receipt (docs/contribution-access.md) for this exact account whose upload checks pass (`format`, `exact_addresses`, `duplicates`, `date_spread`) and that carries exact LinkedIn addresses. Contribution credit (`new_contribution`, `not_replayed`) does not matter here. The result carries no tier, proposal or award.
- `autoEnrichmentSubjects(eligibility, { uploadedContactUrls, ownProfileUrl })`: deduplicated exact addresses, each `{ slug, target, visibility: 'inherit' }`.
- A replayed or re-uploaded archive adds no entitlement (eligibility is yes/no over distinct archives) and no charge (the ledger key is the person, not the upload).

## Not built / open

Real provider adapters (the existing Exa cohort publisher is separate and unchanged), runtime wiring, the notification transport, scheduling of the sweep and flush, what account deletion does to spend records (they hold the account id for reporting), and any spending. The tests use an in-memory store and a **fake** Neo4j driver that applies the store's constant statements to maps and models the month lock as a mutex; the Cypher has not been run against a real Neo4j.

Tests: `tests/enrichment-providers.test.mjs`, `tests/enrichment-spend.test.mjs`.
