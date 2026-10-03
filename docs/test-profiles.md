# Test profiles: checking the claim flow without a real person

The recovered legacy claim lane in `/find-me` is one-shot: the
self-asserted `UnlinkedLegacyAccount` row stays even when revoked, and its
unique `profileId`, `ownerId`, `userId` and `emailHash` then block that profile
and that account's address from ever self-claiming again. Test profiles let us
check the whole lane end to end and then undo it completely.

The separate public LinkedIn signup source is documented in
[signup LinkedIn profile](signup-linkedin.md).

## What a test profile is

- A shipped, frozen list in `mcp-server/test-profiles.mjs`, separate from the
  recovered legacy dataset, whose bytes and provenance hash are untouched.
  Each entry has an id `test-profile-<uuid>`, a name containing "test", a
  made-up LinkedIn-style address, and provenance `unlinked-test-profile-v1`
  with `test: true`. The set's SHA-256 is recorded on each test claim as its
  `sourceSha256`.
- Found **only** by its exact address in `/find-me` (never by name). The
  "Is this you?" card is labelled "Test profile. Not a real person and never
  shown publicly."
- **Never public.** It is in no dataset, so it is absent from the directory,
  search, `/people/<id>`, `/api/people`, the agent API and account export. This
  is exclusion rather than a badge. A claim on it is marked `testProfile: true`,
  and every reader that turns a claim into membership, a public profile, a
  profile's account (Connect), a notification or a legacy anchor (network,
  export, agent `unlinked_me`) skips marked rows. The claimer's own `/profile`
  shows "Test profile claimed: <name>" and nothing else changes for them.
- The audit event is `test_profile_self_claimed`, not
  `legacy_profile_self_claimed`. No "profile claimed" notification is sent.

Current set: one profile, **Ideaflow test profile**, address
`linkedin.com/in/ideaflow-test-profile-b8052ec5d075` (checked absent from the
private slug index and public search on 2026-10-02; ticket unlinked-ovs).

## Operator: list and release

Inside the runtime container:

```sh
docker exec -i unlinked-private-guest-pilot-20261001-runtime node \
  /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/test-profile-claims-operator.mjs list
docker exec -i unlinked-private-guest-pilot-20261001-runtime node \
  /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/test-profile-claims-operator.mjs release <testProfileId>
```

`release` deletes the claim rows on that test profile, revoked or not. That row
is the only thing blocking a fresh claim, so afterwards the same profile can be
claimed again, by the same account and address. Sign in again for a new
find-me step. It fails closed: it refuses any id outside the shipped set, and
if any claim row on the test profile is not itself marked as a test claim, it
deletes nothing. Real claims are only ever revoked, with
`legacy-account-operator.mjs revoke`. Deleting the account also removes its test
claim.

`list` and `release` are indexed equality lookups on `profileId`.

## Tests

`tests/test-profiles.test.mjs` covers lookup, the labelled card, the claim and
`/profile` notice through the real browser handler, public-surface exclusion,
and release refusal and success. Its graph double rejects any statement whose
`$parameters` are not all supplied.

`tests/test-profiles-neo4j.test.mjs` runs the same lane against a real Neo4j
with the production uniqueness constraints and claim-reader queries. It is
opt-in and loopback-only (`UNLINKED_TEST_NEO4J_URI=bolt://127.0.0.1:<port>`,
`UNLINKED_TEST_NEO4J_PASSWORD`, `UNLINKED_TEST_NEO4J_DRIVER=<path to neo4j-driver>`).
