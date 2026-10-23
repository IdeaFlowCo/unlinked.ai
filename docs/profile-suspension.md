# Profile suspension (reversible soft delete)

A **suspend** [profile decision](profile-decisions.md) temporarily disables a
whole profile and hides it from everyone, including the account it belongs to.
Nothing is deleted: imports, claims, connections, cards and the account stay
in the graph, and restoring the decision brings back exactly the earlier
projection. It is operator-only (beads `unlinked-t9fg`). It is not erasure,
and it never touches the person's Ideaflow ID or any other app.

## What it hides

The decision is applied when the shared People snapshot is built
(`src/utils/public-people/profile-decisions.mjs`), so every reader of that
snapshot follows it: signed-out and signed-in pages, the iOS app, `/people/<id>`
and `/api/people/<id>` (404), connections pages, hover cards, the directory,
search, suggestions, counts and presence filters, company pages, AI search,
other people's connection lists and "you both know" counts, contact lookups,
messaging from a profile, and every agent/MCP tool. It hides:

- the profile it names, a member's profile included (unlike `remove`), with
  every edge touching it and every address merged into it;
- every other published profile with the same LinkedIn address. The
  decision stores the SHA-256 of the canonical LinkedIn slug
  (`linkedinRefHash`, never the address), and the composition also suspends
  any imported `public-<row>` copy whose LinkedIn address matches
  (`urlIdentitySuspensions`). A new import, a sign-up that claims the same
  LinkedIn address, or a recovered-profile claim therefore cannot re-list
  the person while the suspension is active, even if the original import is
  later deleted.

The snapshot also names the suspended ids (`suspended`) and their LinkedIn
references (`suspendedRefs`) without publishing them; the reader exposes
`reader.suspended({id})` and `reader.suspensions()`. A suspension's own id
stays in `suspended` as a tombstone even while that profile is not published,
so a retracted or not-yet-rebuilt profile still answers as suspended.

### The account's own pages

The member's own `/profile`, `/card` and `/scan`, and their edits
(`/profile/links`, `/card/contact*`), answer "temporarily unavailable"; the
profile photo answers 404, contact-card links (`/c/<token>`, the vCard, Add and
Message) 404, find-me never offers a suspended profile for claiming, and
`unlinked_whoami` omits the recovered profile. Everything fails closed. The
account's own pages use the authoritative stored decisions
(`readSuppressions()`), which can prove "not suspended" when nothing is
suspended, or when the index confirms that no LinkedIn-matched profile is the
account's; otherwise the page answers 503 unavailable with no profile content.
If the index cannot be read, photos answer 503 and contact cards 404.

### Owner-private rows

People are also hidden from members whose own exports or accounts list them,
including the importer. Every owner backend has `readSuppressions()`, which
reads the stored suspend decisions directly (authoritative, independent of the
public index; adds the index's LinkedIn-matched ids when available; an error
fails closed). Rows are dropped by stable identity only: the published profile
id they point at, or the SHA-256 of the canonical LinkedIn slug in the row's
subject or URL field (`src/utils/public-people/suspension-filter.mjs`). Names
never match. This covers the owner network (`/network`, contacts, Home, the
profile preview, "you know" sets), text and AI network search, contact
lookup and connection listing tools, per-import search (`/search`), the
account data export's parsed rows, and connection requests and notifications
whose other person is suspended (browser and agent tools). Second-degree and
public-graph readers already use the snapshot.

### Intentionally not covered

- The owner's original files: recovered legacy CSV downloads
  (`/legacy-files/<id>`) are byte-for-byte the owner's own old upload and are
  not rewritten, and uploaded archives stay stored as uploaded (no page serves
  them). Their parsed rows are filtered everywhere.
- People added without a LinkedIn address, and old rows with no URL or profile
  id, cannot be matched without using names; suspend those profiles by id.
- Requests and notifications recorded with a different (older) profile id for
  the same member.
- Other Ideaflow apps: OpenChat conversations and the Noos people overlay
  (private notes) are not changed, and the person's Ideaflow ID is untouched;
  a suspended member can still sign in.
- The staging-only `private-hosted.mjs` per-import MCP handler, which the
  canonical runtime does not mount.

## Operating it

Inside the runtime container (`$RT`, `$R` as in the rollout notes):

```sh
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/profile-decisions-operator.mjs \
  suspend <profileId> <you> "<reason, e.g. removal request <reference>>" [linkedinUrl]
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/profile-decisions-operator.mjs list
# Restore (audited; records who, when and why):
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/profile-decisions-operator.mjs \
  restore <suspendDecisionId> <you> "<reason>"
```

The LinkedIn identity is found from the recovered legacy source (legacy ids)
or the import row (`public-<row>` ids); pass the address explicitly for a
member's sign-up profile. Without one, `suspend` refuses
(`profile_decision_linkedin_required`) unless the address argument is `-`.
Plain `revoke` refuses suspensions; use `restore`. Changes are visible within the public index's
freshness window (about 20 seconds, at most 90).

An older runtime (0.6.47 and before) treats `suspend` decisions as inert, so
rolling back re-exposes suspended profiles. Before such a rollback, add a
`remove` decision for each suspended imported profile, and note that its
operator CLI refuses new decisions while a `suspend` is active.

Tests: `tests/profile-suspension.test.mjs`.
