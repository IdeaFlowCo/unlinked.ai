# Private LinkedIn archive foundation

This slice restores a visible **Import LinkedIn archive** entry alongside Meet and implements the parser/job foundation.
The public entry displays an unavailable state and accepts no uploads.
There is no live ingestion, AI search, identity binding, agent linking, migration or backend activation in this change.
The legacy onboarding/agent endpoints are not connected to this module.

## Parser and receipts

`src/utils/private-import/archive.mjs` consumes real ZIP or individual CSV bytes.
The fixed limits are 20 MiB compressed archive, 8 MiB per file, 40 MiB total expanded data, 200 ZIP entries and 100,000 parsed CSV records across the archive, including blank, preamble and header records.
Incremental parsing aborts when that shared budget is exceeded; unsupported files are retained without CSV parsing.
Central-directory bounds are checked before expansion; actual inflation is bounded and size/CRC checked.
Encryption, ZIP64, multi-disk archives, symlinks, duplicate paths, path traversal and unsupported compression fail closed.
No archive member is extracted to a filesystem path.
Supported categories are Connections, Profile, Positions, Education and Skills.
CSV headers are discovered within the first 20 nonempty records, rather than dropping two lines.
Unknown files, invalid UTF-8, absent headers, invalid URLs and malformed records have explicit receipts; their original bytes remain recoverable.
Logical record identifiers count parsed nonempty CSV records, including preamble/header records, not physical line numbers (quoted fields may span lines).
Imported URLs and emails are observations, never proof of an app login identity.

`src/utils/private-import/job.mjs` binds deterministic job, source and assertion IDs to a caller-supplied verified historical owner ID.
The ID includes the archive hash/upload filename/parser version, and assertions include the source hash/path/record identifier.
An exact replay returns the original terminal receipt; revised bytes or filenames create a new job and preserve the old source/assertions.
There is no person directory, cross-owner merge, automatic publication or account claim.
No active-person materialization or supersession resolver exists yet: a future owner-scoped resolver must select/supersede only this owner's prior assertions and invalidate its embeddings.

Job metadata and original bytes are written before parsing.
A job advances from `uploaded` to `parsing`, then `partial` with `phase: awaiting_private_index` when rows are durably accepted, or `failed` when none are accepted or the archive is invalid.
Every source receipt records accepted/rejected counts and unsupported/error outcomes.
`counts.indexed` remains zero and `indexGate` names the missing Noos private index; this foundation never reports `indexed` merely because parsing succeeded.
The future index adapter must prove accepted source-backed assertions are indexed before publishing an `indexed` receipt.
Persistence errors reject the operation and leave a retryable `parsing` receipt; they are never translated into archive success.
The adapter must serialize one owner's job, preserve immutable assets/assertions and atomically publish assertions plus the final job receipt.
Retry starts its counters from zero, so an interrupted publication cannot duplicate counts.

## Noos boundary and activation gate

The Noos owner’s operational v1 foundation defines `GET/PUT /api/operational/v1/unlinked/:type/:sourceId` for `import`, `source` and `assertion` resources.
Each PUT has `{sourceOwnerId, sourceRevision, expectedRevision, audience: 'owner', deleted, payload}` and an immutable verified historical-owner-to-Noos mapping provisioned by the identity owner.
The importer will map job ID to `import`, source ID to `source` and row assertion ID to `assertion`; all IDs already include historical owner scope.
Immutable source/assertion records use first-create revision 1 and exact-content replay; mutable job status advances through CAS revisions.
Source payloads need private asset references and content hashes; original bytes need an authorized private asset store, not public Storage objects or broadly readable graph payloads.
The Noos v1 single-resource contract alone does not provide atomic multi-resource publication or assets: an adapter must add verified batch/commit semantics (or fenced committed-job reads), replay/recovery and private asset authorization before runtime hookup.
Noos labels are not isolation by themselves; the destination must be inaccessible to legacy generic query, graph, search, counts, export, attachments and agent credentials.
No HTTP adapter is mounted by this slice and no generic Noos graph is written.

The browser identity seam remains verified `(issuer, subject)` to existing Unlinked owner ID to Noos user ID, preserving account choice and established bindings.
A LinkedIn slug, imported email or a call to the legacy `claim_linkedin_profile` is not that mapping.
The identity owner owns token verification and subject resolution; the import module accepts only the resolved owner, not an owner from browser upload input.
Future browser search and scoped agent search must read the same committed owner-specific assertions and private index.

Activation requires the real isolated Noos transaction/authorization tests, private assets, verified identity mapping, owner-scoped indexing/search with genuine provider receipts, and subsequent scoped hosted-agent delegation proof.
The old Supabase source, archived bytes and historical IDs must remain available for recovery and rollback.
A parser test or a fresh synthetic import does not prove historical migration parity.
This unmounted slice changes no existing writer, auth deployment, paid service or provider setting; reverting its code needs no live data rollback.

## Validation evidence

`npm test` exercises the parser and importer with synthetic actual ZIP/CSV data.
`tests/private-import-store.mjs` is a durable isolated filesystem adapter used only by tests, never imported by application code.
Its atomic snapshots prove replay, interruption handling and owner-addressed file separation.
Fixture owner strings are injected by the tests; these tests do **not** prove authentication, production authorization, graph traversal/search isolation or Noos database transactions.
The Noos owner separately owns the isolated Neo4j evidence.
Set `TMPDIR` to an external-SSD directory on the constrained M4 so fixtures remain off its internal disk.
No live private contact data or external provider call is needed.
