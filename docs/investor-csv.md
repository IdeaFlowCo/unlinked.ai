# Private investor lists through an agent

An agent can take an uploaded CSV of previous investors and store it in the
owner’s private people graph, with original fields, private comments and list
membership. UI support is not required. This is separate from LinkedIn archive
imports: it never creates social connections or public profiles and never sends
messages or invitations. A person without a public persona becomes a private
person entity; when an exact LinkedIn address resolves to a readable public
profile, the private card can reference that persona.

## Connector flow

Use the Unlinked MCP connector or the REST equivalents below. The shared Ideaflow
connector prefixes tool names with `unlinked__` and requires explicit
`unlinked:private_notes` consent in addition to `unlinked:read`. Direct Unlinked
keys use the existing **Private people notes & relations** switch; direct OAuth
uses `private_notes`. Social connection write permission alone is insufficient.
Historical catalogs stay immutable; effective catalog v9 adds these tools only
inside an already enabled private-notes permission.

1. Call `unlinked_stage_investor_csv` with `csv`, `listName` and an explicit header
   mapping, for example `{name:"Investor",linkedinUrl:"LinkedIn",company:"Firm",
   notes:["Comments"]}`. `firstName`, `lastName`, `email` and `title` are also
   supported. A names-only, single-column CSV is valid; malformed quoting is
   rejected. The response includes an `importId`; a newly staged import also
   includes a validation preview.
2. Call `unlinked_resume_investor_import` with that `importId`. Each call commits
   10 rows by default (1–25 configurable). Repeat until `complete` or `partial`.
   When creating a list, the first successful resume returns its `listId`.
   Staging and the user’s instruction to import are sufficient authorization for
   an unambiguous import; another human confirmation is not required.
3. Read `unlinked_get_investor_import` for original row fields and outcome
   receipts; follow `nextOffset` until null. Rejected rows explain why. Transient
   failures retain progress. `import_busy` means another batch holds a lease;
   retry later. A terminated process’s lease expires after five minutes.
4. Discover lists with `unlinked_list_private_things({kind:"list",limit:100})`.
   Follow `nextCursor` as `after`. Read a list using
   `unlinked_get_private_thing({thingId:listId,limit:100})`, again following the
   cursor. Outgoing `contains` edges name members; membership is not `knows`.
5. Add or correct later comments using the ordinary private note/link tools.
   Removing a membership deletes that link only. Deleting the list removes its
   links, not the people or their independently stored notes.

REST: `POST /api/agent/v1/private/investor-imports`,
`POST /api/agent/v1/private/investor-imports/resume`, and
`GET /api/agent/v1/private/investor-imports/status` take the same fields.

## Identity and retention

Names, firms and emails are never identity keys. Valid canonical LinkedIn
addresses use the shared `linkedin:in:<slug-hash>` reference. Multiple existing
entities with conflicting exact refs are rejected for review, never silently
merged. An invalid or missing URL gets a separate entity per source occurrence,
so repeated names remain distinct. Valid URLs supplied by the owner are stated
identity evidence, not an independent verification of the CSV’s accuracy.

Original bytes are immutable owner-private assets. Durable operational resources
hold the source digest, mapping, list target, progress and one receipt per source
row. Notes include the import id and row/field/part; membership receipts keep the
entity/link/note ids. Different imports retain independent note contributions.
No existing profile fields or manual notes are overwritten. A replay of identical
bytes, mapping, list name and list target reuses the import and never reapplies completed
rows after the owner changes/deletes them.

The private import catalog is separate from archive discovery, background workers,
publication and connection indexes. Staging publishes the job and catalog entry in
one atomic owner-private batch after storing the source; interrupted staging does
not reserve catalog capacity. Atomic import storage is required; no sequential-write
fallback is used. A source uploaded before failed publication stays owner-private
and can be reused on retry or removed by account asset cleanup. Account export includes the CSVs and receipts;
account deletion tombstones these resources and removes original assets through
the existing owner-asset cleanup. Shared Ideaflow graph entities/notes remain
subject to the existing explicit shared-overlay retention policy (the account
export labels them `deletedWithUnlinkedAccount:false`); delete private entities or
notes separately when desired. A receipt records the original write outcome,
not the current existence of a graph record.

## Bounds and recovery

512 KiB of UTF-8 CSV per part. Investor upload envelopes allow 4 MiB to accommodate
JSON escaping; unrelated shared-connector calls retain their 1 MiB bound. Split larger uploads at
complete CSV records, repeat headers and pass the first part’s `listId` on later
parts. Exact identities deduplicate across parts; unnamed identities stay separate.
The graph retains its existing 5,000 entities and 5,000 links per owner, 200 notes
per entity, and 4,000 characters per note. Long source comments are split into
attributed notes. Exceeding a graph quota stops at the current durable row and
returns an error; it never silently drops the rest or claims completion. The
private import catalog is bounded at 500 imports. No paid enrichment runs.

Status pages also have an encoded byte budget, so they can contain fewer than the
requested rows. Always follow `nextOffset`. An individual row too large to return
inline has `fields:null` and explicit `sourceRecovery` metadata. Retrieve the exact
original CSV through the same status tool with `sourceOffset:0`, concatenate
`source.text`, and follow `source.nextOffset` until null. Each chunk is at most
32,768 JavaScript UTF-16 code units; offsets use the same unit. Recovery verifies
the stored source digest and requires the same live owner/private permission.

Each batch acquires a persisted compare-and-set lease, renews before graph writes,
uses idempotent graph keys and saves a row receipt before advancing its checkpoint.
A crash after graph writes but before the receipt safely replays that row. Concurrent
writers cannot overwrite a newer checkpoint. Row-level permission revalidation and
existing owner deletion coordination stay active. Pagination is live keyset traversal;
concurrent insertions before the cursor require a fresh traversal after completion.
Legacy private reads without `limit` retain their existing 50-entity/500-link bounds.

## Verification and rollout

Focused behavioral tests: `node --test tests/investor-csv.test.mjs
 tests/investor-workflow.test.mjs` (on one shell line). A cross-repository synthetic
integration uses Noos’s disposable harness, never a production database:

```
UNLINKED_TEST_NOOS_MODULE_ROOT=/absolute/noos/checkout node scripts/test-operational.mjs /absolute/unlinked/checkout/tests/investor-neo4j.test.mjs
```

Run that command from the Noos checkout with its locked dependencies installed.
It imports 503 people through the real overlay and reads every member through
Unlinked pagination, including foreign-owner denial. Deploy reviewed Noos
list/pagination support first, then Unlinked, then the shared gateway scope.
Noos graph semantics also have an OpenChat vendored copy; update that copy through
its owner’s normal release when adding list editing there. No new graph labels or
credential destinations are required by this change.
