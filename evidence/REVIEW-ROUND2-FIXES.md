# Native community chat review, round 2

Confirmed and fixed R4, R5 and primary-chat-hierarchy.

- Activation now requires the trusted verification adapter to return the verified
  organizer issuer/subject. The service independently resolves and compares the
  live identity, ignores caller-supplied identities, and atomically persists its
  normalized binding with the group activation and outbox revision. Existing
  bound conversations cannot be marked deleted merely because no initial
  snapshot was prepared. Both memory and Neo4j stores retain pending tombstones.
- Delivery/retry processing no longer scans completed rosters. A separate timer
  audits at most one completed roster per 60 seconds with its own concurrency
  guard and cursor. Stalled or failed auditing does not block due deliveries;
  prompt transition and block/unblock enqueues remain intact. External identity
  changes still reconcile through bounded audits, and retries recheck access.
- Leave group is now the existing quiet submit button below the shared lists
  and organizer contact action. Its POST, CSRF and explicit leave semantics are
  unchanged. Native chat remains the primary action near the page heading.

One focused cloud verification passed: **30 tests, zero failures or skips**.
The TAP receipt is `evidence/review-round2-focused-tests.log`.

Coverage includes immediate deletion of an activated legacy group, active-sync
and deletion receipt loss, immutable tombstone replay, organizer proof rejection,
real Neo4j activation persistence, independent auditing of a 500-seat roster,
audit failure recovery, prompt transitions during a stalled audit, identity and
block reconciliation, quiet leave placement and CSRF, readable flyer callbacks,
real shared graph recovery and standalone launcher behavior.

The current worktree modules were streamed in memory to the existing cloud job;
its source checkout was not modified. Tests used the authorized synthetic Neo4j
fixture at 8926 and the existing paired driver. Recovery used disposable cached
Neo4j containers with tmpfs data and test-owned teardown. No live mutation,
production restart, installation, full repository test/lint gate, push, or
pipeline-control operation was performed. The final diff was reviewed after the
focused run; subsequent delivery phases remain with the outer executor.
