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
  never themselves merged (no chains).
- **rename** `{profileId, name}`: changes only the published display name, for
  example to mark test accounts.
- Inputs are never changed. A decision is **revoked**, not deleted, and the next
  snapshot is exactly what it would have been without it. The applied decision
  ids are folded into the snapshot revision, so cursors restart after a change.

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
