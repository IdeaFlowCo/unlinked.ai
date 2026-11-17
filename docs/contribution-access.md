# Contribution-based access (scaffolding, not active)

Tracker: `unlinked-flav`. Jacob's November 16 direction: add a contribution-based second access level, potentially after checks against fake uploads, and preserve his manually granted access.

**Status: evaluation code only.** `mcp-server/contribution-eligibility.mjs` is not imported by the runtime, awards nothing and writes nothing. `AUTO_AWARD` is `false`. Existing tiers (docs/verified-access.md) are unchanged and remain operator-granted.

## What exists

`evaluateContribution` turns one parsed connections archive into an immutable **receipt**:

- counts: rows, rows with an exact LinkedIn address, distinct people, repeats inside the archive, people already credited, people already in the shared network, and **new people**;
- checks: `format` (non-empty, within LinkedIn's 30,000-connection ceiling), `exact_addresses` (at least 60% of rows carry an exact address), `duplicates` (at most 20% repeats), `date_spread` (not half the dated rows on one day), `not_replayed` (this exact archive hash has not earned credit), `new_contribution` (at least 50 new people);
- a **proposal**: Standard → Enhanced (approved), `requires: operator_review`. A Verified or Enhanced account's proposal is always "no change"; a proposal never lowers or replaces manual access;
- `creditableIdentityHashes`: the salted hashes of exactly the new people, so credit can later be recorded per person. The same archive, a re-zipped copy, or people someone else already contributed earn nothing again. The receipt holds hashes and counts only, never who is in the archive.

`contributionDecision(receipt, { reviewer, approve })` returns the instruction for a named reviewer's decision. It performs no write: applying it is the existing operator tool for the approved tier.

## Honest limits

- These are plausibility checks. They do not prove an archive is authentic or the uploader's own; the receipt states this. Identity is the exact LinkedIn address only, never a name.
- Usefulness is measured as new people, not upload size.
- Evaluation implies no publication. Whether contributing requires sharing anything publicly must be disclosed and decided separately; nothing here publishes.
- Thresholds in `CONTRIBUTION_POLICY` are placeholders for review, not a decided policy.

## Not built

A durable receipt/credit store, the wiring from the import pipeline, any member-facing UI or copy, and the award itself. These wait for Jacob's answer: automatic after checks, or manual review first (recommended: manual review).

Tests: `tests/contribution-eligibility.test.mjs`.
