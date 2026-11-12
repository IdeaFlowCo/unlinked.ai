# Public professional profile creation

The offline `mcp-server/publish-professional-people.mjs` publisher creates public professional profiles in `curated-professional-people-v1`. This separate source fills the structural gap in enrichment-only datasets, which continue to update existing people only. The live directory opts into this dataset through `professionalProfiles: true`.

Rows require a verified canonical LinkedIn URL and an ID derived from that URL via `professionalProfileId`. Supply only independently sourced professional fields: name, headline, company, location, about, website, positions, education, skills. The publisher rejects unknown fields and edges. It never creates accounts, claims identities, imports files, connects people, sends notifications or changes private lists. A source operator must review identity and text provenance before execution; the DTO whitelist alone does not prove that free text is public.

Run from the owned runtime with mode-600 source and provenance files under the private root:

```
node mcp-server/publish-professional-people.mjs ROWS PROVENANCE /srv/unlinked-private-guest-pilot-20261001
node mcp-server/publish-professional-people.mjs ROWS PROVENANCE /srv/unlinked-private-guest-pilot-20261001 --execute --expected-revision=none
```

Provenance requires `source`, `rowsSha256` of the exact source bytes, and `scope: "public-professional-profiles-only"`. A later batch appends or updates canonical IDs without removing existing rows. Execution requires the current revision (`none` for a new dataset), and the store enforces compare-and-set. Unchanged replays make no graph write. A private audit stores the previous snapshot and candidate before publication; a receipt follows verified readback.

The installed Noos store accepts only basic professional fields, excluding `linkedinUrl` and `website`. `professionalStorageSnapshot` strips those two fields while preserving stable IDs and the full content revision. Plan and execute both run the installed store validator on this storage DTO. Before publishing, the operator exclusively creates and fsyncs the full professional rows at `audit/professional-public-source-manifest-<revision digest>.json` (mode 600), then fsyncs its directory and the prepared audit. Existing manifest files must contain identical bytes; they are never overwritten. The manifest digest is the SHA-256 of its exact JSON row bytes, matching the existing content revision.

`withProfessionalProfileDetails` wraps the cached Noos reader for this dataset only. It validates the file's ownership, permissions, hash and full professional DTO, then requires exact agreement between the stored snapshot and the manifest's stripped snapshot before returning URLs. Missing, foreign, corrupt or mismatched manifests fail closed. Other datasets and live `revisionOf`/digest reads remain unchanged. The publisher hydrates the current revision before merging and hydrates readback before accepting success. For rollback, pass the audit's previous snapshot through `professionalStorageSnapshot` and restore it through the store with the published revision as the expected revision, or revoke the exact revision if there was no prior snapshot. Retain immutable manifests for prior revisions so restored snapshots can hydrate.

The shared projection includes this dataset in its content revision and freshness fingerprint. Revoking it removes those standalone profiles at the next rebuild. Existing account claims and same-address deduplication retain their established precedence. Profile decisions, including suspensions, still apply. Ambiguous names and identifier mismatches must remain held until reviewed.

Source IDs remain `professional-<sha256 of canonical LinkedIn slug>`; existing staged rows need no regeneration. Same-address merging, member precedence, operator-decision protection and handle preservation follow the [profile identity and handle contract](profile-handles.md#one-person-one-page).

Validation: `node --test tests/professional-publication-store.test.mjs tests/professional-publication-http.test.mjs tests/professional-profiles.test.mjs tests/professional-profile-identity.test.mjs tests/member-public-projection.test.mjs tests/public-people-cache.test.mjs` exercises storage stripping, manifest failure modes, durable publication/audit/readback, append/replay/CAS, anonymous HTTP lookup, forbidden fields/edges, rollback/revocation, live pointers, identity merging and member precedence. Store lifecycle tests use an injected whitelist/CAS store; set `UNLINKED_NOOS_DIR` to run the additional exact-library validator/driver boundary check. Isolated real Neo4j integration on agent-build-1 remains an outer-executor release requirement.

Field X delivery remains pending acceptance until the outer executor supplies reviewed identity/field provenance, live publication receipts, updated downloadable URL workbooks, finished pages opened on M5 and the tested deployment atop the latest curated live predecessor. Source-phase tests do not claim those operational steps have occurred.
