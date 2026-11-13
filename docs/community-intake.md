# Community introductions and asks

[Collective network](collective-network.md) owns group admission and signup return behavior. With the Social intake connection configured, explicit Join or acceptance of a direct invitation leads to `/groups/:id/welcome`. The introduction is optional; membership does not require an import. `/profile/context` and `/asks` remain available from Me afterward.

Quick introductions, task/idea lists, Goodreads CSV, and an assistant-produced JSON draft are posted to Unlinked for deterministic parsing into a review form. Unlinked sends none of this input to a model. The optional assistant prompt is copied into an assistant you already use; choose what context to give that assistant, then paste its JSON back for review. Tasks are unselected by default unless recognized as asks/offers. Every draft entry has a visible audience selector. A quick introduction typed in a group’s welcome form preselects that group at review; personal introductions and batch-import drafts default to Only me. The member reviews the audience before saving. Only selected entries are saved. Existing X/GitHub/website links and LinkedIn import remain separate supported screens. Photo/live bookshelf sync and X scraping are not implemented.

Social stores the canonical nodes and their owner under the exact verified Ideaflow issuer and subject. First save explicitly consents to a Social profile and this narrow Unlinked connection. A dedicated partner secret enables read/update of intake-created entries only; it does not grant access to existing private Social data. Social's durable request receipt makes retry safe; edit revisions reject stale writes. `/asks/:id` supports status and audience changes, including sharing a previously private entry with a current community. When the saved community is unavailable, group-audience edits require an explicit current community selection or a change of audience; the form never substitutes another community.

Entries with `requiresSocialReview: true` or an audience outside `only_me`, `group` and `public` require visibility review in Social. Both `/asks` and `/asks/:id` show a **Review visibility in Social** link to the canonical Social entry instead of an Unlinked edit form. Unlisted entries are labeled **Unlisted · manage in Social**; other review-required entries are labeled **Audience needs review in Social**, never Only me. If a save returns Social's `entry_visibility_conflict`, Unlinked gives fixed guidance to find the Social link in My asks and offers; it never displays upstream message text or URLs.

Unlinked owns membership and blocking. Before showing a group projection it obtains live authorized members, resolves their persisted identities, requests only exact-group placements, and verifies the roster again. Live member/block checks and persisted identity resolution run with at most eight concurrent operations per pass and retain roster order; lookup failures deny the projection. Removed members and blocked pairs are excluded. No membership is copied to Social or Superconnector. Joining Unlinked does not join a Superconnector network; the handoff uses the same Ideaflow ID.

`/asks` and `/groups/:id/community` show one bounded Social page at a time, with Older entries and Newest entries links. Pagination accepts only a positive integer `cursor` and `limit` (default 100, maximum 500), with entries ordered by descending id below the cursor. Only Open entries appear in group views; Done and Paused entries stay in personal tracking. Group pages repeat live roster validation on every request, even when filtering leaves a page empty. Editing a saved entry uses its id to fetch the exact position in the owner's paginated entries, retaining revision checks for saves.

## Configuration and release

Set `UNLINKED_SOCIAL_INTAKE_SECRET` to the dedicated value configured as Social's `IDEANETWORK_UNLINKED_SECRET` (at least 32 characters), using protected service environment files. `UNLINKED_SOCIAL_INTAKE_ORIGIN` defaults to `https://social.ideaflow.app`. Deploy the compatible Social partner routes before enabling Unlinked. No provider/model credential is required. When disabled or Social reads fail, authorized group rosters and group-local profiles remain usable; shared-entry sections explain the unavailable connection. Adding or editing entries requires the connection.

All intake routes use authenticated sessions, same-origin POSTs and CSRF; group routes also enforce live membership. Responses are no-store/noindex with neutral anonymous metadata. Inputs, prompts and profile entries are never placed in invite URLs. Do not put the partner secret into a browser bundle, logs or repository.

Validation: `node --test tests/community-intake.test.mjs tests/collective-group-browser.test.mjs tests/private-composition.test.mjs`; full Node suite on the designated cloud builder. The HTTP fixtures cover signup intent, selected-only save, CSRF/origin rejection, edit-to-group authorization, former-community form submission, Social visibility review and conflict guidance, final no-store headers, bounded 500-seat reads, and membership/block revalidation. Standalone launcher fixtures cover configured and unconfigured intake forwarding plus login, flyer join, welcome, review, CSRF rejection, private save and personal asks. These fixtures use synthetic identities and Social data; production signup, live Social persistence and browser visual verification remain separate.

## Member context and suggested connections

Every current member has a group-local profile at `/groups/:id/community/:memberId`
(the organizer uses `organizer`). These pages show only open entries already
shared with that community, with the same pagination and live access checks as
the community board. Pagination selects a community-wide page before filtering
for the member, so a member page can be empty while older entries remain.
Names and member IDs come from the authorized roster;
identity hashes and operational owner IDs stay server-side. Compact rosters on
the group and community pages link each member’s name to this page,
even without an introduction, LinkedIn import or published public profile.
**Group profile** describes the audience, not an unclaimed account. A separate
public profile link is shown when available. Group-local content is not added
to the public profile or anonymous link previews.

With messaging configured, **Message** on a roster or group-local profile uses a
same-origin, CSRF-protected POST to `/groups/:id/members/:memberId/message`.
The server resolves the recipient from the current authorized roster through
OpenChat's owner resolver, reusing or creating a direct conversation inside
Unlinked. It never sends a message; the existing inbox draft behavior applies.
Removed or blocked members cannot use a stale action to resolve a recipient.

**Groups in common** appears on another member's group-local profile and on their
published profile for a signed-in viewer. It shows only groups both accounts are
currently authorized to access, honoring blocks; it never lists the other
person's full membership. This viewer-only section is excluded from public APIs
and anonymous previews.

Suggested connections compare open asks with offers from other current members,
in both directions, using explicit shared words and a small set of topic
aliases. Each suggestion shows both entry titles and the overlapping topics; it is
not an AI endorsement or a compatibility score. Suggestions use the current
page of authorized entries, not private imports or hidden personal asks. Empty
results invite a more specific ask/offer and browsing the member list.

## Add an ask and confirm its destination

**Add an ask** opens a focused title/details/audience form at
`/groups/<group>/asks/new`, with the current group visibly selected.
`/asks/new`, reached from **My asks and offers**, instead defaults to **Only me**.
Group membership is rechecked at save. Choosing **Only me** saves a private draft;
The focused group form offers group visibility or Only me. Public sharing remains a separate explicit choice in entry editing and other supported review forms.
Introduction and batch-import defaults are described above.

If saving an ask or offer fails, its focused form retains the title, details,
kind, selected audience and request receipt for a safe retry. Group forms keep
the same group/Only me choices after a failure; they do not return to profile
onboarding or introduce Public sharing.

A save containing only entries for the current group returns to its community
board with confirmation that the entries are shared there. Private, public or
mixed-audience saves return to **My asks and offers**, where the saved entries
and their audiences remain visible and editable. The redirect adds `saved=1`
for the confirmation notice; it does not change visibility.

The welcome page suggests LinkedIn import and the normal profile page without
blocking group use.

The group detail page keeps **Message the group**, **Add an ask**, and **Asks and
offers** above a five-member preview; **See all members** opens the full community
roster. Names are the profile links and Message has a 44px touch target. **Add an
offer** uses the same focused flow. Quick introductions typed in a group's welcome
form visibly preselect that group at review; pasted/imported drafts retain Only me.
Existing private entries are never automatically shared. The welcome page leads
with group participation and places optional LinkedIn import after the quick intro.

## Find matches

`/groups/:key/matches` is a signed-in, request-local matchmaking view reached
from group actions, the community board and the welcome page. The existing
board remains paginated; matching starts from the newest group entries and
follows up to four 500-entry pages, including empty filtered pages. A non-null
cursor after that limit produces an explicit partial-results notice, never a
claim that the full group was searched. A failed page discards the partial
result and shows an unavailable state. Results are not persisted or cached.

The existing Social partner group projection is canonical. Only currently
roster-bound, explicitly group-shared, open asks and offers are candidates;
private/public entries, other groups, visibility-review entries, notes and
ideas are excluded. Unlinked rechecks the roster and blocks after the complete
read. No raw graph queries, private imports, inferred skills from biographies,
model calls or Superconnector service dependency are introduced. The separately
owned Superconnector Noos migration does not change this contract.

A deterministic topic matcher normalizes a small explicit set of related terms
(e.g. JavaScript/JS, accessibility/WCAG, user research/customer interviews).
Generic request language such as help, review and advice is not evidence.
Specific topic overlap, coverage and member-level topic frequency rank pairs;
only complementary ask/offer pairs qualify. One card per person retains the
strongest pair in each direction. Reciprocal opportunities receive a modest
ranking boost. This is topic-based suggestion, not semantic understanding or
verified expertise. No percentage confidence is shown. Each card quotes the
supporting entries, explains the matched topics, links the member's private
group profile and uses the existing CSRF-protected verified Message action.
It never sends messages or introductions automatically.

Validation: `tests/group-matchmaking.test.mjs` executes matching and bounded
page loading; `tests/community-intake.test.mjs` exercises real browser HTTP
routes for multi-page matches, escaping, anonymous/outsider access, unsupported
queries/actions, stale membership/blocks and failure without partial leakage.
Use phone/desktop rendered checks for card layout, titles and44px actions.
