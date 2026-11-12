# Public professional profile creation

The offline `mcp-server/publish-professional-people.mjs` publisher creates public professional profiles in `curated-professional-people-v1`. This separate source fills the structural gap in enrichment-only datasets, which continue to update existing people only. The live directory opts into this dataset through `professionalProfiles: true`.

Rows require a verified canonical LinkedIn URL and an ID derived from that URL via `professionalProfileId`. Supply only independently sourced professional fields: name, headline, company, location, about, website, positions, education, skills. The publisher rejects unknown fields and edges. It never creates accounts, claims identities, imports files, connects people, sends notifications or changes private lists. A source operator must review identity and text provenance before execution; the DTO whitelist alone does not prove that free text is public.

Run from the owned runtime with mode-600 source and provenance files under the private root:

```
node mcp-server/publish-professional-people.mjs ROWS PROVENANCE /srv/unlinked-private-guest-pilot-20261001
node mcp-server/publish-professional-people.mjs ROWS PROVENANCE /srv/unlinked-private-guest-pilot-20261001 --execute --expected-revision=none
```

Provenance requires `source`, `rowsSha256` of the exact source bytes, and `scope: "public-professional-profiles-only"`. A later batch appends or updates canonical IDs without removing existing rows. Execution requires the current revision (`none` for a new dataset), and the store enforces compare-and-set. Unchanged replays make no graph write. A private audit stores the previous snapshot and candidate before publication; a receipt follows verified readback. For rollback, restore the audit's previous snapshot through the store with the published revision as the expected revision, or revoke the exact revision if there was no prior snapshot.

The shared projection includes this dataset in its content revision and freshness fingerprint. Revoking it removes those standalone profiles at the next rebuild. Existing account claims and same-address deduplication retain their established precedence. Profile decisions, including suspensions, still apply. Ambiguous names and identifier mismatches must remain held until reviewed.

Source IDs remain `professional-<sha256 of canonical LinkedIn slug>`; existing staged rows need no regeneration. The shared identity merger folds them into existing imported or legacy survivors, following explicit merges and retaining readable handles. Removals absorb new copies and suspensions cover their LinkedIn identity. Named operator decisions stay attached to their profiles; conflicting decisions and distinct claimed members are never merged away. Verified members absorb copies without taking their professional-source fields; unverified signup addresses cannot absorb them.

Validation: `node --test tests/professional-profiles.test.mjs tests/professional-profile-identity.test.mjs tests/member-public-projection.test.mjs` exercises anonymous profile lookup, forbidden fields/edges, append/replay, rollback visibility, identity merging, decisions, readable handles and member precedence.
