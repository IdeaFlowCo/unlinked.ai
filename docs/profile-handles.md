# Member handles

A member's public profile lives at `/people/<handle>` (unlinked-qpud), for
example `https://www.unlinked.ai/people/peterhuynh300`, instead of an internal
id such as `/people/member-signup-<account-hash>`. Internal profile ids do not
change: connections, requests, notifications, blocks, suspensions and account
resolution keep using ids. A handle is only the address of an id.

## Who gets one

Only member profiles (presence `member`: an active account stands behind the
profile) get handles. Imported (shadow) and unclaimed legacy profiles keep their
id addresses, and a shadow's LinkedIn slug is never an address. A handle never
opens a profile that is not currently a member's: if the profile is suspended
(docs/profile-suspension.md), removed, or no longer a member's, every address
for it, handle or id, answers 404 exactly as before.

## Default handle

The first that is free of:

1. the LinkedIn vanity slug already on the member's public profile
   (`linkedinUrl`, so nothing new is exposed), when it fits the grammar;
2. a slug of their public name (`Zoë O’Brien` → `zoe-obrien`);
3. that slug numbered: `ada-fictional-2`, `-3`, …

Handles are assigned, only while an active account still stands behind the
profile (`accountForProfile`), on the first view of the member's page, `/profile` or
`/card`, and by a backfill that runs 5 s after start and every 10 minutes
(`handleBackfillMs`). The backfill gives LinkedIn slugs precedence, so a name
never takes another member's own slug.

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
- a member's id, an earlier handle or a different case answers **301** to
  `/people/<current handle>` (subpage and query string kept);
- merged ids follow their alias to the survivor's handle.

`/api/people/<segment>` and `/api/people/<segment>/card` accept a handle or id
without redirecting and add `handle` for members; `/join`, `/report`, `/block`
and `/removal` accept handles too.

## Emitted links

`profilePath(id)` returns the handle path when one exists. The composition
registers the live lookup (`setProfileHandleLookup`), so profile pages, People
and connection lists, notifications, connection-request redirects, the `/card`
QR code and contact-card profile line, autocomplete and hover cards emit handle
addresses. The OpenChat profile context (`unlinkedProfileContext`) stays
id-based because messaging resolves recipients from it; it redirects like any
id. Agent tools: `unlinked_get_profile` accepts a handle and returns `handle`
and `url`; `unlinked_list_people` rows add `handle` (docs/agent-api.md).

## Storage

`mcp-server/profile-handles.mjs`: one `UnlinkedHandleProfile {profileId,
current}` node per profile and one `UnlinkedProfileHandle {handle, profileId}`
node per handle ever used, both with unique constraints and registered with the
graph migration. Assignment and rename lock the profile node, so concurrent
writes settle on one handle. Pages read an in-memory copy that every write
updates and the backfill reloads. Tests: `tests/profile-handles.test.mjs`
(the durable test runs with the `UNLINKED_TEST_NEO4J_*` opt-in).

## Rollback

Releasing the previous version leaves handle nodes unused: id addresses work as
before and handle addresses 404. Re-releasing restores them unchanged.
