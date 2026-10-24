# Profile handles

Every published profile lives at a readable `/people/<handle>` address
(unlinked-qpud for members, unlinked-3l8h for imported profiles), for example
`https://www.unlinked.ai/people/peterhuynh300`, instead of an internal id such
as `/people/member-signup-<account-hash>` or `/people/public-<row-hash>`.
Internal profile ids do not change: connections, requests, notifications,
blocks, suspensions and account resolution keep using ids. A handle is only
the address of an id.

## Who gets one

Members (presence `member`: an active account stands behind the profile) and
imported profiles alike: the copies member uploads mint (`public-<row>`) and
unclaimed legacy profiles. A handle opens only a published profile: if the
profile is suspended (docs/profile-suspension.md) or removed
(docs/removal-requests.md), every address for it, handle or id, answers 404
exactly as before, and a removed or suspended profile's handle is never handed
to anyone else. A member who leaves keeps nothing: account deletion removes
their handles, and a profile that stays published as an imported profile
(an unclaimed legacy row) gets its default address again.

## Default handle

The first that is free of:

1. the LinkedIn vanity slug already on the public profile (`linkedinUrl`, so
   nothing new is exposed), when it fits the grammar (`linkedinHandle`);
2. a slug of their public name (`Zoë O’Brien` → `zoe-obrien`);
3. that slug numbered: `ada-fictional-2`, `-3`, …

Members get theirs on the first view of their page, `/profile` or `/card`, only
while an active account still stands behind the profile (`accountForProfile`).
Everyone else gets theirs from the backfill, which runs 5 s after start and
every 10 minutes (`handleBackfillMs`), writing in batches of 500
(`assignMany`). The backfill hands out LinkedIn slugs first, members before
imported profiles, then names: a name never takes anyone's own slug, and a
member's own slug outranks an imported copy's. Each backfilled handle records
how it was chosen (`kind`: `linkedin` or `name`).

## One person, one page

Published profiles carrying the same LinkedIn address are the same person, so
the index folds them into one (`linkedinIdentityMerges` in
`src/utils/public-people/url-identity.mjs`, applied after every stored
decision):

- A member's profile absorbs every imported copy of itself and keeps only its
  own fields, when the member's address is verified: it comes from their own
  uploaded archive or a confirmed recovered account. A URL typed at signup, or
  a self-asserted claim, absorbs nothing, so typing someone's URL can never
  take over their page; those members' imported copies stay separate pages
  until the address is verified (for example by uploading their archive).
- The copies several imports mint fold into one survivor: a copy an operator
  removed (so the person stays removed), else the copy that already holds the
  person's address, else the smallest id.

Legacy profiles already absorb their copies by address
(docs/profile-decisions.md). Other profiles named by an operator decision, and
addresses shared by two members, are left alone. Names alone never merge
anyone.

A LinkedIn handle follows the person. When an imported profile is claimed it
becomes the member's profile under the same id, so its handle stays. When the
person joins with a new profile, their imported copies fold into it, the old
ids answer 301 to the member's page at once, and the next backfill moves the
copies' handles to the member (`transfer`), making the slug current unless
the member already chose another handle. The same happens when the copy
holding a slug disappears (its import was deleted) while another copy remains.
A name handle that happens to equal someone's slug never moves, and an address
alone never takes a handle from a live profile that did not fold in. Names
past the numbered defaults keep counting (`-61`, `-62`, …), so every profile
whose name or slug fits the grammar gets an address.

## Grammar

`validateHandle` in `src/utils/public-people/profile-handles.mjs` owns it:
3–60 characters, lowercase `a-z`, `0-9` and single hyphens, starting and ending
with a letter or digit. Input is trimmed, lowercased and may start with `@`.
Route and official words (`add`, `lookup`, `settings`, `admin`, `unlinked`, …,
`RESERVED_HANDLES`) are refused, as is anything shaped like an internal id
(UUIDs, `public-`/`member-`/`legacy-`/`shadow-`/`test-` prefixes, long hex),
so every existing id address keeps meaning that id.

## Changing a handle

Members edit it on `/profile` (Profile address card). The field checks
availability as you type (`GET /profile/handle/check?handle=` → `{ available,
handle, current }` or `{ available: false, code }`, signed-in only) and saves
with `POST /profile/handle` (session CSRF), redirecting with
`handle=saved|taken|invalid|length|reserved|limit|unavailable`. Only the account
behind the published member profile (`ownProfileId`) can change it.

Every handle a profile has used stays bound to it: earlier handles redirect to
the current one and nobody else can take them, so shared links never break or
change owner. A member may switch back to any earlier handle; new handles are
capped at 10 per profile. Account deletion removes all of the member's handles.

## Resolution and redirects

`/people/<segment>` and `/people/<segment>/connections`:

- a handle (any case) resolves to its profile id;
- an id (member, `public-<row>`, legacy uuid, signup or import id), an earlier
  handle or a different case answers **301** to `/people/<current handle>`
  (subpage and query string kept), so existing links never break;
- merged ids follow their alias to the survivor's handle.

`/api/people/<segment>` and `/api/people/<segment>/card` accept a handle or id
without redirecting and add `handle`; `/join`, `/report`, `/block` and
`/removal` accept handles too.

## Emitted links

`profilePath(id)` returns the handle path when one exists. The composition
registers the live lookup (`setProfileHandleLookup`), so profile pages, People
and connection lists, notifications, connection-request redirects, the `/card`
QR code and contact-card profile line, autocomplete and hover cards emit handle
addresses. The OpenChat profile context (`unlinkedProfileContext`) stays
id-based because messaging resolves recipients from it; it redirects like any
id. The plain search page (`/search-public`) and private-context relation links
use `profilePath` too. Agent tools: `unlinked_get_profile` accepts a handle and
returns `handle` and `url`; `unlinked_list_people` rows add `handle`
(docs/agent-api.md).

## Storage

`mcp-server/profile-handles.mjs`: one `UnlinkedHandleProfile {profileId,
current}` node per profile and one `UnlinkedProfileHandle {handle, profileId,
kind?, movedFrom?}` node per handle ever used, both with unique constraints and
registered with the graph migration (about two nodes per published profile,
roughly 80,000 for 40,000 profiles). Assignment and rename lock the profile
node, so concurrent writes settle on one handle; a batch that races another
process falls back to one assignment per row. Pages read an in-memory copy that
every write updates and the backfill reloads. Tests:
`tests/profile-handles.test.mjs` and `tests/imported-profile-addresses.test.mjs`
(the durable tests run with the `UNLINKED_TEST_NEO4J_*` opt-in).

## Rollback

Releasing the previous version leaves the imported profiles' handle nodes
unused: their id addresses work as before and their handle addresses 404
(0.6.50–0.6.55 serve handles for members only). Same-address merges are
computed per build, so rolling back un-merges them. Re-releasing restores
everything unchanged.
