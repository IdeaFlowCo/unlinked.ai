# Private investor lists through an agent

An agent can take an uploaded CSV or selected XLSX sheet of previous investors and store it in the
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
   includes a validation preview. Alternatively supply canonical `fileBase64` and
   a `.csv` filename instead of `csv`; `inspectOnly:true` previews headers without
   writing. Supply exactly one of `csv` and `fileBase64`.
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

## Multi-tab XLSX and original-file disclosure

The same three tools accept XLSX; their names and private-notes permissions stay
compatible. Send original bytes as canonical `fileBase64` with `filename` ending
`.xlsx` (at most 512 KiB before base64). Do not convert a workbook to CSV before
uploading if its original bytes or sheet provenance must be preserved.

1. Call `unlinked_stage_investor_csv({fileBase64,filename,inspectOnly:true})`.
   This writes nothing and returns `sourceDigest`, exact sheet names/ids/paths,
   and visibility (including hidden tabs). Never select a tab silently.
2. Inspect the chosen sheet with the same input plus `sheet:"Exact tab name"` and
   optional `headerRow` (one-based physical row, default 1). This returns headers
   and data-row count. Only this sheet is parsed as a table.
3. Disclose that **the entire original workbook, including unselected and hidden
   sheets, will be retained privately on the server**; only the selected sheet is
   imported into the graph. Stage with `sheet`, `headerRow`, `listName`, `mapping`
   and `retainOriginalConfirmed:true` only when the owner has authorized that
   retention. This acknowledgement does not establish who the owner is: the
   authenticated account and private-notes permission still control every call.
   Existing explicit authorization is sufficient; do not ask again needlessly.
   If authorization covers only a tab, have the owner provide a separate file
   containing that tab instead of retaining unrelated workbook data.
4. Resume and page receipts exactly as for CSV. Sheet id/path/name, source hash,
   parser version, header row and original physical row numbers stay attached to
   the job/receipts. Empty rows do not renumber subsequent source rows. Replay
   includes the selected sheet/header in its identity; another sheet is a distinct
   import and can append to the same listId.

For exact XLSX recovery use `sourceOffset:0`. Each response returns `source.base64`
and `offsetUnit:"bytes"`; decode **each chunk separately**, concatenate the bytes,
follow `source.nextOffset` until null, and verify `sourceDigest`. Chunk size is at
most 32,768 bytes. CSV recovery remains `source.text` with UTF-16 offsets. Account
export returns XLSX as `originalFile:{filename,format,...,encoding:"base64",base64}`.
Whole-file retention uses the existing owner-private immutable asset store and
account cleanup; neither the original file nor unselected tabs are published.

The format is deliberately bounded: .xlsx only (not legacy .xls, .xlsm, encrypted
workbooks, ZIP64 or macro/binary parts), UTF-8 XML, up to 100 sheets, 200,000 cells,
100,000 shared strings, 256 columns and physical rows up to 100,001. Existing ZIP
bounds are 8 MiB per expanded part and 40 MiB total; XML is capped at depth 32 and
1,000,000 elements per part. A conservative 8 MiB serialized-table budget counts
every shared-string use, UTF-8 bytes, quote escaping and row padding before
allocation; the 200,000-cell budget also counts sparse-cell padding. Inspection
and staging enforce the same bounds. DTD/entity declarations and external workbook links
are rejected. No external resources are fetched. Selected-sheet formulas and
error cells fail explicitly; provide a values-only copy or CSV. Rich text and
shared/inline strings are read as plain text; number/date values retain stored
lexical values, not display formatting. Hyperlinks, styles, images and Excel
comments are not imported: map actual cell text (including URL text and a notes
column). The original workbook preserves these for owner recovery.

Parsing uses the existing bounded ZIP reader and pinned saxes 6.0.0 (released
2021-11-07), a strict streaming XML parser; no SheetJS dependency or formula engine.
See its [upstream documentation](https://github.com/lddubeau/saxes).

## Identity and retention

Names, firms and emails are never identity keys. Valid canonical LinkedIn
addresses use the shared `linkedin:in:<slug-hash>` reference. Multiple existing
entities with conflicting exact refs are rejected for review, never silently
merged. An invalid or missing URL gets a separate entity per source occurrence,
so repeated names remain distinct. Valid URLs supplied by the owner are stated
identity evidence, not an independent verification of the source file’s accuracy.

Original bytes are immutable owner-private assets. Durable operational resources
hold the source digest, mapping, list target, progress and one receipt per source
row. XLSX jobs also retain whole-workbook disclosure acknowledgement and selected-sheet metadata. Notes include the import id and row/field/part; membership receipts keep the
entity/link/note ids. Different imports retain independent note contributions.
No existing profile fields or manual notes are overwritten. A replay of identical
bytes, mapping, list name and list target reuses the import; XLSX replay also
requires the same selected sheet, header row and parser version. A replay never
reapplies completed rows after the owner changes/deletes them.

The private import catalog is separate from archive discovery, background workers,
publication and connection indexes. Staging publishes the job and catalog entry in
one atomic owner-private batch after storing the source; interrupted staging does
not reserve catalog capacity. Atomic import storage is required; no sequential-write
fallback is used. A source uploaded before failed publication stays owner-private
and can be reused on retry or removed by account asset cleanup. Account export includes CSV text or exact XLSX base64 originals and receipts;
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
 tests/investor-workflow.test.mjs tests/investor-xlsx.test.mjs` (on one shell line). A cross-repository synthetic
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

## Browser upload: followers and other lists (unlinked-h2e4)

LinkedIn's data export has no followers file. `Member_Follows.csv` lists the people the member follows, not their followers. Members who have followers in a CSV (from LinkedIn analytics, another tool or a spreadsheet) can upload it on the import page under **Upload a list of people, such as your LinkedIn followers**, which is closed by default.

This browser upload accepts CSV only; use the agent workflow above for XLSX.

- `mcp-server/private-list-imports.mjs` detects the mapping from the header row (case and spacing are ignored):
  - Name / Full Name, or First Name + Last Name
  - Profile URL / LinkedIn URL / Public Profile URL
  - Headline / Title / Position
  - Company
  - Email

  With no name column, the page explains what to add. The upload is limited to 512 KB; larger lists are split into several files with the same list name.
- It stages and runs the import above through the shared tool service, as the signed-in owner, with an in-process grant limited to the three list tools plus private-notes permission (`private-pilot.mjs`). That grant has `app: true`, so notes and links record provenance `author: owner`, `source: app`.
- A paced background runner resumes batches of 25, about one every 1.5 s, well under the owner's per-minute tool budget. One owner's imports run one at a time. Runners live in the process, so a restart pauses them. After five consecutive transient failures, or three batches without progress, a runner stops, and `/import/list/<importId>` offers **Continue importing**. That page shows counts and the rows with their outcomes (20 per page), named through the import's mapping.
- The people are owner-private list members (`contains`), never connections, never public, and nobody is notified. They appear in each person's private notes panel and through the list tools for the owner's agent.
- Not yet: a "Follows you" label in My people, which needs list membership joined to network rows.

## Finding existing lists in Unlinked (unlinked-ms39)

Signed-in members open **Lists** in the desktop navigation or **Me → Lists** on
mobile. `/lists` shows private graph lists and saved search result sets in
separate sections. Private lists created through the connector, CSV/XLSX imports
or OpenChat are read from the existing owner-private Noos overlay; there is no
new list store or copy. Noos research collections (such as node-page lists) are
a different data model and are not automatically included.

`/lists/private/:id` pages through outgoing `contains` person members, retaining
the next cursor even when a page contains only other links. Names and descriptions
are escaped; public-profile references may link to existing profile pages. These
pages require the current browser owner, use `Cache-Control: no-store`, never
create a share link, and show an unavailable state when the overlay fails. The
browser adapter has only the two existing private read tools. Import-result pages
link directly to the resulting list once a `listId` exists. List editing remains
in OpenChat/the existing agent tools.

Focused checks: `node --test tests/private-lists.test.mjs
 tests/saved-search-lists.test.mjs tests/private-list-imports.test.mjs` (one line).
Runtime rollout remains subject to the existing qualified Unlinked/Noos release;
source delivery and synthetic browser verification do not establish deployment.
