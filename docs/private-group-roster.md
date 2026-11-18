# Private group roster pilot

Default off. No deployment, production migration, real roster preparation/transfer
or real import is authorized by implementation or tests. Root GO remains required.
The real 1,024-participant roster exists only on M5, with 1,023 phone-bearing rows.
See [DESIGN.md](../DESIGN.md) for the approved privacy and M5 hashing design.

The canonical runtime is standalone Noos-backed Unlinked, not legacy Next.js or
Supabase. Groups are a Noos capability with Unlinked as UI. This pilot extends the
existing collective-group pages without changing existing invitation acceptance.
No existing group is migrated or created automatically. The MIT group is an
ordinary collective group named **MIT Early-Stage Investors/Founders Group**.
Its collective id is also the add-on id: there is no second group creation or
joining flow. `collective-groups.mjs` remains authoritative for organizer,
metadata, consent and membership; the private Noos group record is a synchronized
projection used to fence the owner-only roster. The 1,024 pending entries do not
occupy joined seats or expand the existing group capacity.

## Activation contract

A reviewed release would require both `UNLINKED_PRIVATE_GROUP_ROSTER=on` and a
nonempty comma-separated list of exact owner ids in
`UNLINKED_PRIVATE_GROUP_ROSTER_OWNERS`. These are server configuration, not request
parameters. Missing either leaves pilot routes at 404 with no pilot initialization
or schema writes. An eligible group owner sees an explicit enable control on the
existing group page; enabling publishes only its existing joined seats, not a
pending roster. Do not enable these settings in production without root GO.

The existing Noos operational adapter persists owner-private `import` resources
with `contract: unlinked-private-group-v1` and distinct `kind` values. Group nodes
reference logical membership-edge records; pending-roster edges are stored in
bounded owner-private chunks behind a separate manifest. This representation uses
the existing Noos resource schema rather than new Neo4j labels or DDL. No new Noos
endpoint, Supabase table or migration is required. The node and membership-edge
publication is atomic. Live accepted collective-group membership, owner binding,
account state and blocks are rechecked before returning any joined projection.
Members cannot use the owner backend themselves; only the request-bound internal
service obtains it after authorization. These are not agent-grant endpoints.

Noos group-node/membership and roster reads fail closed for missing, foreign,
tombstoned, malformed or conflicting records. Every record has a kind, so ordinary
archive publication readers exclude it. Admin membership is recognized in the
contract but never grants roster visibility; this MVP adds no admin promotion UI.

## Browser flow

- `/groups/:id/private`: group metadata, tags and live joined members. The pending
  roster link is owner-only. WhatsApp fallback: “WhatsApp group (ask Jacob for an
  invite)”. Any later supplied link is restricted to live joined members.
- `/groups/:id/roster`: owner-only, 25 entries per page, current low-confidence
  name suggestions from the published People reader. Names never prove identity.
- CSV/JSON preparation stays on M5. Its HMAC service keeps its secret and salt
  there. Only `display_name`, `phone_hash`, `participant_id` are accepted; raw
  phone fields, extra/nested fields, phone-bearing ids and phone-like names fail.
  The participant without a phone has null/empty phone_hash. No raw-phone encrypted
  field exists. No M5 bridge or key transfer is introduced by this code.
- A file chooser loads a prepared file locally into the preview form; paste is
  also supported. Preview is ephemeral, owner/session-bound and expires after ten
  minutes. At most eight previews are retained per process. A restart discards
  them. The user acknowledges private retention before publication. The server
  reparses the rows and checks node and roster revisions before committing.
- Publication stages immutable chunks of at most 25 rows, then commits the current
  manifest, receipt and group revision fence atomically. Staged chunks are never
  an owner/member/agent read path. Limits: 2 MiB, 2,000 rows, 200-character names;
  Noos resources remain below 60 KiB and atomic batches below 600 records/32 MiB.
- “Resolve next 25 entries” advances a durable CAS-protected job, with no external
  provider/model calls. It resumes on a later click/restart; there is no autonomous
  daemon to run against the real roster. The job is bound to the current roster
  generation. Page suggestions are refreshed rather than trusting stored results
  after a person is removed. Phone matching is unavailable without separately
  authorized compatible M5-side candidate hashes.
- “Prepare draft” creates text only. No email, message, notification, invitation
  record or OpenChat sync is triggered. Jacob must approve exact text/recipients
  separately. Existing explicit collective-group invitations remain unchanged.
- Clear removes the current roster from use. Replaced/cleared chunks and receipts
  remain private records pending account deletion; the UI does not promise physical
  erasure or immediate backup erasure.

Every write, including staging, atomically appends an owner-private journal and
updates a catalog. Existing account export includes current group records and
pending entries. Existing account deletion fences the catalog first, then
idempotently tombstones every tracked record, including interrupted staging and
superseded rosters. Cleanup runs independently of pilot flags/allowlist so a
rollback does not strand records. Limits: 200 pilot groups per owner, 10,000
journal pages per group. There is no background cleanup or retention expansion.

## Verification and release boundary

Focused tests: `node --test tests/private-group-pilot.test.mjs
 tests/collective-groups.test.mjs tests/group-matchmaking.test.mjs
 tests/group-matchmaking-views.test.mjs tests/account-data.test.mjs` (one command).
They use fictional records, an atomic in-memory Noos contract double and a fake
transport through the real Noos adapter. This is not a live Noos/multi-host or Mac
verification receipt. Before activation, verify the shipped Noos operational
artifact accepts the existing import-record kinds and atomic CAS batches in an
isolated test environment. No production initializer/migration should be run.
Independent Sol review must identify the exact committed head before any deploy.
MCP group tools and scope changes are deferred and require discovery parity.
