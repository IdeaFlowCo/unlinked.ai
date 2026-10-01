# Legacy COPY migration plan

This is a deterministic, read-only planning interface, not an import completion receipt.
`createLegacyPlan(uncompressedDumpBytes, limits?)` produces a normalized migration plan without executing SQL, accessing a database, or writing to Noos.
`sourceSha256` identifies the exact uncompressed dump bytes; keep the compressed backup hash separately in the recovery receipt.

Only eight `public` tables are decoded: profiles, connections, positions, education, skills, companies, institutions and uploads.
All other COPY sections, including authentication and storage/security tables, are discarded without decoding their fields.
Every expected public table must be present, including empty tables.
Headers may reorder columns, but must contain precisely the approved schema columns.
Duplicate sections, IDs, directed endpoint pairs, unknown schema columns, dangling references and malformed input fail closed with data-free error codes.
Default bounds are64MiB dump bytes,2MiB per line,1,000,000 rows per COPY section and256 COPY sections.
Callers must bound decompression before passing input.
COPY null, escaped controls/backslashes, octal and hexadecimal UTF-8 bytes are decoded without interpreting SQL.

The plan retains every source row ID and its public table/one-based row ordinal.
Positions, education and skills are nested under their source profile, with related organization IDs and provenance.
Companies and institutions are also preserved as top-level arrays, including unreferenced source rows.
Directed connections preserve both endpoints exactly; reciprocal edges are not invented.
Uploads preserve metadata paths and filenames but never read blobs or storage credentials.
Counts represent all whitelisted source rows without truncation.
`issues: []` means all permitted relational references validated; any failure aborts the entire plan.

`profiles.user_id` remains an opaque nullable `legacyUserId` for a future identity mapping step.
Its external auth.users reference cannot be validated because auth rows are deliberately excluded.
No email field exists in the approved profile schema; this transform cannot prove provider verification or bind an owner.
Uploaded or typed identities never become verified identities through this plan.
Any future safe identity manifest needs a separately explicit provenance/verification contract.

Profile summaries and professional fields may contain personal information.
This private planning DTO is not a public reader projection.
The runtime owner must apply visibility policy and safe public provenance before exposing a profile.
Do not log plan rows or write the raw backup into source/test fixtures.
Production graph writes, idempotent publication, owner binding, verified-email confirmation, and public reader integration remain outside this module.

Synthetic tests execute both parsing and normalization, checking full cardinality, provenance, escaped bytes, directed edges, skipped secrets, malformed input, limits, duplicates and relational failures.
A read-only validation of the recovered private backup counted16,296profiles,16,603connections,55companies,18institutions,45positions,17education rows,248skills and181uploads with no planner issues.
This proves the source can be planned; it does not prove graph publication or blob migration.
