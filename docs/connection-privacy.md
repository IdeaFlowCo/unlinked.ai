# Who can see your connections

A member chooses who can see the connections their imports (and other listings) put on Unlinked. The choice is per account and covers every import, now and later. It is offered under **Advanced: who can see your connections** on the import form (closed by default) and in **Settings → Privacy**.

Two choices (`src/utils/public-people/connection-privacy.mjs`):

| Who can see (`audience`) | Meaning |
|---|---|
| `everyone` (default) | Anyone, signed in or not |
| `members` | Anyone signed in to Unlinked |
| `second_degree` | The member's connections and their connections |
| `connections` | Only the member's connections |
| `only_me` | Nobody else |

| What they see (`scope`) | Meaning |
|---|---|
| `all` (default) | Every connection |
| `shared` | Only connections the viewer also has (mutuals) |

Every combination is allowed; `only_me` ignores the scope. The default is fully public, so nothing changes for members who never open the disclosure.

## What it covers and what it does not

- Covered everywhere a member's connections are shown to someone else: profile connection lists and counts (`reader.profile`), the listing count on people cards (what an anonymous visitor may see), hover-card mutual counts (`reader.card`), `reader.neighbors`, the second-degree search agents use (`known-connections.mjs`) and the `unlinked_get_profile` agent tool.
- A connection is stored from the person whose export listed it. An accepted invitation or Connect request counts as listed by both people. On X's profile a connection to Y shows when **X's own choice** allows it for the viewer **and** someone who listed it (X or Y) allows it. So a private importer's list stays off the profiles of the people it imported (Bob's page no longer lists Alice when only Alice's private list connects them), a member's choice governs their own page even for connections others listed, and someone else's public list still shows on their own page.
- **Relationships come only from the owner's side.** "Your connections" means people *your* list names (or accepted invitations/requests). "Their connections" means people someone you listed has listed. "In common" means people who vouch for the viewer: their own list names the viewer (accepted invitations and requests count). Anyone can upload a file naming anyone, so a viewer's own upload never makes them someone's connection, second degree, or a mutual. People who are not members never list anyone, so they do not count as in common; that is the price of a mutual that cannot be forged.
- The member always sees all their own connections.
- It does **not** unpublish people. Under the existing public professional upload disclosure, people in a member's file can still be found on Unlinked, just not as that member's connections. The member's own profile stays public.
- Degrees for `second_degree` and `connections` are computed on the whole published graph.

## Storage and enforcement

- One `UnlinkedConnectionPrivacy` node per account (`mcp-server/connection-privacy-store.mjs`); choosing the default deletes it. The label is in the shared graph migration set. Account deletion removes it.
- The public index (`createMemberPublicIndex`, option `readConnectionPrivacy`) maps each account to the profile it resolves to after merges and publishes `connectionPrivacy: { [profileId]: { audience, scope } }` with non-default entries only. The choices are hashed into the index revision, so a change rebuilds the compiled index. Saving a choice calls the index's `invalidate()` (wired in `private-composition.mjs`), so the next read builds fresh instead of serving the kept or stale build; a build already running cannot store its older result. A member linked to a recovered legacy profile with no import is mapped through their own backend's legacy link (eight at a time, remembered between builds). If that lookup fails with nothing remembered, the build fails rather than publishing the connections without the choice. The edge capacity limit is checked after accepted invitations are added in both directions. When two accounts fold into one profile, each dimension takes the stricter choice.
- Readers take `viewer: { signedIn, id? }`. **A missing viewer is an anonymous visitor**, so a call site that forgets it can only show less. Signed-in cursors are bound to the viewer.
- The import form saves the choice **before** any file is staged, so new connections are never public first. A form is never rendered with a guessed value: if the stored choice cannot be read, the control is left out rather than defaulting to "Everyone".

Tests: `tests/connection-privacy.test.mjs` (matrix of audiences × viewers, shared scope, both-ends rule, cards/neighbors/cursors, second-degree search, index mapping and revision, views) and the HTTP test in `tests/background-import.test.mjs`.
