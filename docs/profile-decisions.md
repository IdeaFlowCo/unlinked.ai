# Profile decisions: reversible merges and renames

Operator decisions about published people, stored as `UnlinkedProfileDecision`
nodes in the pilot graph and applied last when the shared People snapshot is
built (`src/utils/public-people/profile-decisions.mjs`, wired through
`readDecisions` in `mcp-server/private-composition.mjs`).

- **merge** `{profileId → survivorId}`: the merged profile leaves the projection,
  its edges point at the survivor (self-edges dropped, duplicates collapsed), and
  the survivor keeps its own fields, taking the merged profile's only where its
  own are empty. The snapshot carries `aliases`: `/people/<merged>` and
  `/api/people/<merged>` answer 301 to the survivor, `reader.lookup` resolves the
  merged id, and the agent's `unlinked_get_profile` returns the survivor with
  `movedFrom`. A claimed (member) profile is never merged away, and survivors are
  never themselves merged (no chains). Historical membership follows the survivor
  separately from current membership; see the [presence contract](public-people-reader.md#historical-membership).
- **rename** `{profileId, name}`: changes only the published display name, for
  example to mark test accounts.
- Inputs are never changed. A decision is **revoked**, not deleted, and the next
  snapshot is exactly what it would have been without it.

The snapshot revision hashes applied decisions in execution order, including
decision ID, kind, profile ID and survivor ID or trimmed rename value. Automatic
decisions that retain an ID while changing their target invalidate compiled
indexes and cursors; merge order also identifies which source fills missing
survivor fields. Regression coverage is in `tests/profile-decisions.test.mjs`.

Operate inside the runtime container:

```sh
docker exec -i unlinked-private-guest-pilot-20261001-runtime node \
  /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/profile-decisions-operator.mjs \
  merge <mergedId> <survivorId> <decidedBy> "<evidence>"
#   rename <profileId> "<name>" <decidedBy> "<reason>"
#   revoke <decisionId> <decidedBy>
#   list
```

Merge only on identity evidence (same LinkedIn member, or research that settles
it), never on a shared name alone. The 2026-10-02 decisions and their evidence
are in the Unlinked overlay design folder (`duplicate-evidence-review` and
`shared-names-review`).

## Automatic merges: imported copies of legacy people

A member's public-consent import mints a `public-<row>` person for every
connection row. When that row's LinkedIn address (the private observation
subject) is the address of a recovered legacy profile, per the private slug
index that find-me uses, the composition adds an automatic merge
`url:<publicId>` folding the copy into the legacy profile
(`src/utils/public-people/url-identity.mjs`). The importer's edge then points
at the legacy profile, and the copy's address answers 301.

- Same LinkedIn address is the only evidence used. Names never are.
- An explicit operator decision about the same imported person wins.
  Survivors follow explicit merges.
- Each import's rows are read once per published dataset revision and cached.
  If the read fails, the snapshot still builds, without automatic merges.
- 2026-10-02: the 72 copies that already existed were merged explicitly by the
  operator with the same rule. New imports are handled automatically.
