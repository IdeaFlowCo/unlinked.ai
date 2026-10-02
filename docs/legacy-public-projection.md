# Legacy public people projection

`createLegacyPublicProjection(plan, limits?)` in `src/utils/public-people/legacy-projection.mjs` consumes the complete [legacy public-table plan](legacy-import-plan.md) and returns `{snapshot,manifest}` without database access, authentication lookup, graph writes or publication side effects.
Use it only for the explicitly approved public legacy corpus; it is not a visibility policy for private account imports.
The runtime owner is responsible for atomically storing and publishing the coherent snapshot before supplying it to the [public reader](public-people-reader.md).
A returned `state:'published'` DTO describes the intended reader contract and does not certify that a backend publication occurred.

`snapshot` contains `state:'published'`, `complete:true`, a revision, profiles and directed connections.
Each profile preserves its exact legacy ID and approved name, headline, biography, professional positions, education and skills.
Source `startedOn` and `finishedOn` map directly to `startDate` and `endDate` without date inference or rewriting.
No location is invented because the approved source profile schema has no location column.
Optional null text is omitted; required null position titles/company names, institution names and skill names become empty strings for reader compatibility.
The manifest retains those original nullable source values so an unknown organization remains distinguishable from a named organization.
Profile names must be present and nonempty.
All directed edges retain their exact endpoints; neither reciprocal edges nor accepted-friend state is inferred or required.

`manifest` is separate from the reader DTO and contains uncompressed source SHA-256, optional separately verified compressed-container SHA-256, transform version, revision, complete source counts, and whitelisted entity IDs and table/row provenance.
It includes original public organization names and related IDs/provenance, nullable professional mapping values and source timestamps.
The nullable `legacyUserId` is opaque unresolved provenance only and never becomes identity, ownership, email or authentication authority.
Upload manifest rows retain only IDs, profile references, timestamps and provenance; filenames, file paths and blob/archive contents are excluded.
Unreferenced public companies and institutions remain in the manifest.
Both snapshot and manifest are deeply frozen; the source plan is unchanged.

The compact ASCII revision is `legacy-public-v1:<uncompressed-source-sha256>` and identifies exact source bytes and transformation version.
Change the transformation version whenever publication semantics change.
Identical plans replay identically without writes or generated IDs.
A different compressed container for identical uncompressed bytes does not change the public revision.

Default maxima match the reader: 20,000 profiles, 100,000 directed edges, 16 MiB public text, 20,000 characters per text field, 100 positions, 100 education rows and 500 skills per profile.
Callers may lower the top-level profile, edge and text limits but cannot raise them beyond reader bounds.
Malformed or sparse arrays, missing counts, duplicate entity IDs/provenance/direct endpoint pairs, dangling profile/organization references, incomplete source counts, source issues and invalid source hashes abort with fixed data-free `legacy_public_*` errors.
No rows are silently truncated.
Each approved source table must have exactly its declared number of distinct one-based provenance ordinals.

The mapper copies only explicit DTO/manifest fields and excludes email, phone, private notes, authentication properties and arbitrary extra keys.
It preserves the approved public biography/professional text verbatim; it does not inspect or redact contact information that might occur inside already-approved free text.
Do not expose the separate manifest through the public reader or treat this mapper as approval for unrelated private data.

Run `node --test tests/legacy-public-projection.test.mjs` for the synthetic public-table fixture, real-reader behavior, directed edges, null handling, replay, privacy, malformed plans, completeness and bounds checks.
