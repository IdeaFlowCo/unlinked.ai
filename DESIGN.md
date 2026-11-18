# MIT Early-Stage Investors/Founders Group: private roster add-on

Status: approved by root d3caa262 for implementation, 2026-11-17. No release, migration,
roster transfer, group creation or outreach is authorized by this document.
Source: Jacob’s Buzz request at 16:11 and root’s 17:30Z resume corrections.
Implementation base: main 539a429, isolated branch
`feat/mit-founders-private-roster`.

## Current source and scope

The original brief said groups did not exist. Current main already contains
`collective-groups.mjs`, `collective-groups-store.mjs`,
`collective-group-browser.mjs` and group views/tests. They implement organizer,
joined seats, invitations, group metadata and validated WhatsApp links. Reuse
those behaviors and routes; do not build a competing groups product. The current
store persists `UnlinkedCollectiveGroup` documents in Neo4j. That is evidence of
existing behavior, not permission to substitute direct graph writes for the
requested Noos adapter design.

Jacob confirmed on 2026-11-18 that the Unlinked display title must match the
verified WhatsApp title exactly: **MIT Early-Stage Investors/Founders Group**.
The MIT group uses the existing collective-group id, organizer, joined seats,
metadata and invitation flow. Its Noos records are a private add-on, synchronized
from that group; they cannot create independent membership. Tags are `investor`
and `founders`. No Beeper title search remains pending. The group has an owner-only pending roster. No WhatsApp invite link is available through the API. Display exactly
“WhatsApp group (ask Jacob for an invite)” until Jacob supplies one. Do not fetch
WhatsApp, scrape members or guess an invite URL. The 1,024-entry private roster
exists ONLY on M5: 1,024 participants with display names, 1,023 with phones.
It remains there until root GO. Use fictional fixtures on Linux. If Jacob later
supplies a WhatsApp invite link, reveal it only to authenticated, currently joined
group members (including the owner); never to the public, invite-preview readers,
nonmember signed-in users, crawlers or link unfurlers.

## Ownership and capability placement

**Groups are a Noos capability, with Unlinked as the UI.** This answers Jacob’s
question: a group node and its membership relationships are reusable Noos
knowledge, while Unlinked provides the group pages, joining and invitation
experience. Noos is the durable authority for those records and their privacy
fences; Unlinked’s service and MCP projections enforce that same authority.

As documented in [README.md](README.md), the canonical unlinked.ai beta runs the
standalone **Noos-backed runtime** (Neo4j through the Noos adapter). Supabase and
Next.js authentication/data routes are historical. This feature extends that
runtime and its existing Noos adapter/publication contract, not a Supabase
migration or a parallel persistence system. The source contract is
[private-noos-staging.md](docs/private-noos-staging.md#publication-and-scale),
with private/public projection and identity behavior preserved from
[network-controls.md](docs/network-controls.md).

Represent the group as a Noos node, joined memberships as consent-backed edges,
and pending roster entries as separate owner-only edges/records behind a privacy
fence. Extend the existing adapter boundary in
`src/utils/private-import/noos-adapter.mjs` for these versioned records and
bounded operations. Reuse its trusted owner binding, source provenance,
revision/CAS checks, immutable receipts and tombstone rules. Do not expose raw
Neo4j access to UI or agent callers. Verify the precise new record/edge support
in the existing Noos contract before activation; missing support fails closed.
Existing collective-group flows and data must be preserved; any required
backfill/representation transition is a separately reviewed artifact, never an
implicit production startup migration.

Agents and Noos consumers should eventually query Unlinked’s authorized MCP
interface, which enforces the same membership rules. Do not expose unrestricted
Noos record queries. MVP browser work does not silently add tools to old grants.
Any MCP follow-up needs separate consented group scopes, a new immutable catalog
version and the complete discovery-inventory update required by AGENTS.md.

## Records and privacy boundaries

All proposed records have schemaVersion, opaque id, owner binding, revision,
createdAt, updatedAt and deletion state. Trusted issuer/subject bindings identify
actors; names and phone numbers never confer account ownership.

| Record | Contents | Readers |
| --- | --- | --- |
| Group node | Name, description, tags (`investor`, `founders`), visibility PRIVATE, owner, admin bindings, external link or fallback label | Owner; joined members receive an allowlisted projection |
| Joined-membership edge | Group id, verified actor, joinedAt, role; join consent provenance | Owner and joined members, subject to live block/account rules |
| Owner-only pending-roster edge/entry | Group id, source/import id, participant_id, display_name, optional phone_hash, candidate references and resolution evidence | Owner only |
| RosterImport | Owner, group, sanitized file digest, counts, revision and bounded failure codes | Owner only |
| ResolutionJob | Owner, group, input revision, cursor, lease, attempts and status | Owner only |
| Invitation | Existing recipient-bound invitation or expiring capability, acceptance state | Owner and its intended recipient only |

The privacy fence binds every pending-roster edge and candidate-resolution
record to the verified owner, group, source import and live revision. Apply it
before graph traversal, filtering, counts, pagination or serialization; group
membership and admin edges never authorize traversal into pending-roster edges.
Publish a sanitized roster batch only after its bounded immutable chunks and
receipts are durable and a final CAS commits the current manifest. Workers and
readers check the live owner/publication fence before and after retrieval;
provisional, superseded and tombstoned rows are not readable. Respect the existing
64 KiB resource, 600-resource/32 MiB transaction and bounded-chunk contracts;
1,024 entries must span bounded batches. An owner’s upload preview is ephemeral
validated input, not permission to enumerate provisional Noos rows. Pending
roster edges never become published People or public graph edges. Joined-member
projections are separately allowlisted and cannot inherit private roster fields.

The resume correction makes pending rosters OWNER ONLY, stricter than the initial
owner/admin proposal. Admins may manage joined-group metadata and invitations
within explicitly granted powers; they cannot see roster names, counts, matches,
source provenance, phone hashes or job status. Only the owner can see these.
Promoting an admin never grants roster access. Owner transfer is out of MVP.

Joined membership requires an authenticated recipient’s explicit acceptance.
Importing, matching, owner confirmation or an existing WhatsApp membership never
creates an Unlinked membership. Pending entries are not reserved seats and do
not count toward group capacity. Existing group limits remain unchanged; 1,024
pending entries do not imply support for 1,024 joined members.

PRIVATE is the only enabled MVP visibility. Nonmembers get indistinguishable
404s except through a valid bounded invitation preview, which reveals only the
minimum group metadata needed to choose whether to join. No roster information,
member list or external WhatsApp invitation appears in that preview. Joined
members see only people who joined. Never serialize a raw group/roster document
to a browser and hide fields with CSS. Private responses use no-store and stay
out of public search, indexing, social previews, service-worker caches and models.

## Phone preparation on M5

Raw phones never leave M5 and are rejected by the hosted importer, including
unknown fields, nested values and names accidentally containing phone-like data.
The owner cannot reveal raw phones in Unlinked; any raw-number review stays on
M5. This supersedes the original “display except to owner” allowance.

The proposed M5-side preparation service normalizes to unambiguous E.164 locally
(reject ambiguous local numbers), then computes a salted HMAC-SHA-256. Hold its
random secret server-side in that M5 service, outside the browser/client and
export; it is never transferred to GCP or Noos. Use a random per-roster salt and
domain-separated input; keep salt, key identifier and algorithm version in the
M5-side manifest. Reuse the same manifest for repeat exports of this roster.
This is an M5-local service boundary, not authorization to provision a new bridge
or copy keys to the GCP runtime. Only three participant fields travel:
`display_name`, `phone_hash`, `participant_id`. There is no per-row key, salt,
version, raw number or other source metadata in the transferred file.

Generate participant_id as an opaque random stable identifier on M5; never use a
WhatsApp identifier containing a phone number. phone_hash is the 64-hex HMAC, or
null in JSON / empty in CSV for the participant without a phone. Do not fabricate
a number or hash an empty string. An unsalted SHA hash is unsuitable because the
phone-number space is enumerable. Hashes remain owner-private data and must not
enter logs, URLs or invite text. The MVP has no encrypted raw-phone field: no
product requirement justifies bringing recoverable phones to GCP or Noos.

Hashing alone cannot match arbitrary existing Unlinked phone values. MVP uses
these digests for within-roster deduplication, not phone identity claims. Exact
phone matching is available only if a separately authorized M5 workflow can
produce candidate-profile digests under the same key from a permitted local
source. No database export to M5, cloud key transfer or cross-owner phone index
is implied. Otherwise show “phone matching unavailable” and continue name-based
candidate suggestions. The tool and its output schema require review before
root authorizes preparation/transfer of the real roster.

## Import and resolution

Owner-only, same-origin, authenticated CSRF-protected CSV/JSON import accepts a
strict three-field allowlist: `display_name`, `phone_hash`, `participant_id`.
Require all three columns/keys, permitting a missing phone only as null/empty.
Validate participant_id as an opaque UUID generated on M5 and reject duplicates;
upserts are scoped to the verified owner and group. No phone-bearing source ids,
extra columns, nested objects or algorithm/key metadata may travel. Server-owned
schema/revision/provenance fields are generated after validation, not imported.
Bound initial limits: 2 MiB, 2,000 rows, 200-character names, valid 64-hex digests,
fixed columns, no formulas as executable content, no arbitrary JSON properties.
Reject malformed encodings, duplicate headers, raw-number fields and partial
invalid batches without retaining bytes. Escaped text is always rendered as
text. Require owner acknowledgement of private retention before acceptance.
Store only sanitized records; do not retain the upload original on Linux/Noos.
A server-computed sanitized digest and stable participant ids prevent retry duplicates. Show a preview
and confirmation before committing rows; preview has the same owner boundary.

A durable bounded worker resolves against published Unlinked projections and
only the owner’s already-authorized private contacts. Reuse text candidate
ranking in `src/utils/public-people/text-match.mjs` and exact profile/LinkedIn
identity rules in `mcp-server/connection-identity.mjs`; follow profile merges and
use `profilePath` links. `person-lookup.mjs` can invoke external lookup providers:
do not call it for bulk name resolution or send roster names to providers in
this MVP. Reusing a helper never expands its source-data permission boundary.

Resolution statuses: unmatched, suggested, ambiguous, confirmed, stale, error.
Evidence confidence is categorical, not an invented probability: name-only is
low; name plus independent context is medium; permitted exact identifier evidence
is high. Equal names remain ambiguous. Owner confirmation records a reviewed
link, not proof of identity and never consent to join. Existing member status
is shown separately from imported-profile existence. Re-read publication/block
state before showing candidates; removed/private profiles do not leak via caches.
A suggestion offers an editable invite draft only. No emails, notifications,
messages, invitation creation or chat synchronization follows automatically.
Jacob must approve the exact text and recipients before outreach is executed.

Jobs have bounded batches, leases, resumable cursors and versioned input.
Re-import/edit increments the input revision; stale workers cannot overwrite
newer rows. Deletion cancels jobs and invalidates their writes. Errors contain
bounded codes, never input rows or credentials. Owner can delete individual
entries or the entire roster; group deletion removes its private records and
jobs. Backups follow existing Noos retention and must be documented before
activation; do not promise immediate physical backup erasure.

## Feature gate, UI and implementation sequence

Default-off `UNLINKED_PRIVATE_GROUP_ROSTER=on` plus verified Noos capability and
an explicit pilot owner allowlist gates every new route, store and worker.
Disabled routes return 404 and start no initialization, migrations or jobs.
Keep existing group routes working under their existing configuration.

Reuse `/groups/:key` for group metadata and joined members. Add an owner-only
`/groups/:key/roster` view with upload preview, match evidence, review actions,
retry/delete and a draft invitation. Do not show this tab to admins or members.
Requests revalidate the live owner inside mutations, not only at page load.
Store changes use compare-and-set; concurrent joins/invites must preserve current
capacity, account-state and block checks. No automatic OpenChat group creation
or synchronization is introduced for pending entries.

After root reviews this design: (1) confirm Noos record/authorization/transaction
contract; (2) implement versioned record schema and adapter with fake backend;
(3) extend existing group service/projections; (4) importer and local M5 preparation
tool using fictional inputs only; (5) resolution worker; (6) browser views and
focused tests; (7) independent Sol review and fixes. A Noos schema initializer,
if needed, is a reviewed artifact only: no production execution without root GO.

## Acceptance and release gates

Tests must cover owner/admin/member/nonmember isolation for HTML and JSON;
roster counts and hashes absent from member/invite responses; disabled flag makes
no store calls; raw phones rejected; digest-only import, malformed files and
retry deduplication; matching ambiguity/merges/removed profiles; no provider or
outreach calls; three-field transfer only, opaque participant ids, the missing-
phone row retained, and later WhatsApp links restricted to live joined members; job lease/revision/deletion races; CSRF; XSS; joined membership
only on recipient acceptance; preserved legacy group behavior. Fake adapters
must not be presented as live Noos verification. Run focused existing group tests
plus new adapter/import/authorization integration tests on fictional records.

Root received and approved DESIGN.md before implementation. Implementation
contract and verification boundaries are documented in
[docs/private-group-roster.md](docs/private-group-roster.md). Independent Sol
review of the exact implementation head remains a release gate. Separate root GO is required before real roster transfer, production
migration or deployment. No real roster has been read or moved in this task.
