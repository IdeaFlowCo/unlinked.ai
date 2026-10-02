# Private LinkedIn archive foundation

This slice implements the parser/job foundation. See [README.md](../README.md#import-linkedin-archive) for the public archive entry and upload availability.
Production ingestion, AI search, identity binding, agent linking, migration and backend activation remain unavailable. The default-off staging adapter/browser/search implementation is documented in [Private Noos staging](private-noos-staging.md), and the profile-first background import path is documented in [Durable archive import](durable-archive-import.md).
The legacy onboarding/agent endpoints are not connected to this module.

## Parser and receipts

`src/utils/private-import/archive.mjs` consumes real ZIP or individual CSV bytes.
The authoritative numeric bounds are the exported `LIMITS` in `src/utils/private-import/archive.mjs`: archive/file bytes, total expanded bytes, ZIP entries and parsed CSV records across the archive, including blank, preamble and header records.
Incremental parsing aborts when that shared budget is exceeded. For ZIP input, only supported LinkedIn CSV members are inflated; unsupported entries are recorded in an immutable manifest so the original archive bytes remain recoverable without expanding media or other nonselected files.
Before passing a record to PapaParse, a constant-memory logical-record iterator enforces `LIMITS.recordChars` and `LIMITS.fieldChars` in UTF-16 code units, `LIMITS.fields` and `LIMITS.quoteTokens` (including escaped quotes).
Quoted commas, escaped quotes and multiline fields remain supported within those limits. The first line ending outside quoted fields selects the CSV record separator. Each PapaParse input contains at most one bounded logical record plus its separator, avoiding searches over the remaining file.
Exceeding a boundary fails the entire source with `csv_record_size_limit`, `csv_field_size_limit`, `csv_field_count_limit` or `csv_quote_limit`; no assertions from that file are published and its original bytes remain retained.
Central-directory bounds are checked before expansion; actual inflation is bounded and size/CRC checked.
Encryption, ZIP64, multi-disk archives, symlinks, duplicate paths, path traversal and unsupported compression fail closed.
No archive member is extracted to a filesystem path.
Supported categories are Connections, Profile, Positions, Education and Skills.
CSV headers are discovered within `LIMITS.headerRows` nonempty or malformed records, rather than dropping two lines.
Unknown files, invalid UTF-8, absent headers, invalid URLs and malformed records have explicit receipts; their original bytes remain recoverable.
Logical record identifiers count parsed nonempty or malformed CSV records, including preamble/header records, not physical line numbers (quoted fields may span lines).
Imported URLs and emails are observations, never proof of an app login identity.

`src/utils/private-import/job.mjs` binds deterministic job, source and assertion IDs to a caller-supplied verified Unlinked owner ID.
The ID includes the archive hash/upload filename/parser version, and assertions include the source hash/path/record identifier.
An exact replay returns the original terminal receipt; revised bytes or filenames create a new job and preserve the old source/assertions.
There is no person directory, cross-owner merge, public publication or account claim inferred from archive data.
No active-person materialization or supersession resolver exists yet: a future owner-scoped resolver must select/supersede only this owner's prior assertions. Staging observation indexing is not embedding generation.

Job metadata and original bytes are written before parsing. In the default-off background path, `stageArchive` commits only that `uploaded` receipt before the browser redirects to `/profile`; `runArchiveJob` then parses and publishes from the durable asset outside the request lifecycle.
A job advances from `uploaded` to `parsing`, then publishes an adapter-specific terminal receipt, or `failed` when none are accepted or the archive is invalid.
For `profile-first-v1` background jobs, Profile, Positions, Education and Skills observations are staged before connection observations so `/profile` can read its own bounded chunks before the final search/MCP publication fence. Pending rows remain unavailable to the scoped import reader.
Every source receipt records accepted/rejected counts and unsupported/error outcomes. The Noos adapter stores compact rejection counts; original bytes and parser version preserve exact rejected records.
Without an index adapter, accepted rows yield `partial` with `phase: awaiting_private_index`, zero `counts.indexed` and a missing-index `indexGate`. The staging Noos adapter instead uses the [fenced observation publication contract](private-noos-staging.md#publication-and-scale); parsing alone never establishes indexed completeness.
Persistence errors reject the operation; they are never translated into archive success. Once the `parsing` receipt is saved, later persistence errors leave that retryable receipt. Failures during initial asset/job writes can leave no job or an `uploaded` receipt, depending on the last successful write.
The adapter must serialize one owner's job, preserve immutable assets/assertions and expose assertions only through the final publication fence. Background adapters additionally need owner-scoped pending-job and job-history discovery so the singleton worker and browser Settings/Profile pages can resume after restart without a separate jobs database.
Retry starts its counters from zero, so an interrupted publication cannot duplicate counts.

## Noos boundary and activation gate

`src/utils/private-import/noos-adapter.mjs` implements the explicit server-only HTTP adapter and scoped reader against the isolated Noos operational API.
Its batch publication, private asset, immutable revision and read-fence contract is owned by [Private Noos staging](private-noos-staging.md#publication-and-scale).
No production route mounts this adapter and no generic Noos graph is written.
Noos labels are not isolation by themselves; the destination must be inaccessible to legacy generic query, graph, search, counts, export, attachments and agent credentials.

The browser identity seam remains verified `(issuer, subject)` to an immutable Unlinked owner ID and Noos user ID, preserving explicit account confirmation and established bindings. Invited new-owner claims are owned by [Private invited-owner browser](private-invited-browser.md); open-account signup is owned by the default-off private runtime and summarized in [Open account launch](../deploy/private-pilot/ACCOUNT-LAUNCH.md).
A LinkedIn slug, imported email or a call to the legacy `claim_linkedin_profile` is not that mapping.
The identity owner owns token verification and subject resolution; the import module accepts only the resolved owner, not an owner from browser upload input.
Browser and scoped agent search use the same committed owner-specific dataset in staging; see [Private Noos staging](private-noos-staging.md#scoped-search-and-browser).

Synthetic parser evidence alone does not authorize activation. The remaining provider, identity, storage/recovery and deployment gates are owned by the [pilot release plan](private-pilot-release-plan.md) and [real guest pilot proposal](private-real-guest-pilot-delta.md).
The old Supabase source, archived bytes and historical IDs must remain available for recovery and rollback.
Historical Supabase Storage object recovery is separate from new archive uploads and is documented in [Recovered legacy LinkedIn files](legacy-storage-recovery.md); it preserves original legacy files and exposes only same-owner browser downloads after explicit recovered-account confirmation.
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
