# Community introductions and asks

[Collective network](collective-network.md) owns group admission and signup return behavior. With the Social intake connection configured, explicit Join or acceptance of a direct invitation leads to `/groups/:id/welcome`. The introduction is optional; membership does not require an import. `/profile/context` and `/asks` remain available from Me afterward.

Quick introductions, task/idea lists, Goodreads CSV, and an assistant-produced JSON draft are posted to Unlinked for deterministic parsing into a review form. Unlinked sends none of this input to a model. The optional assistant prompt is copied into an assistant you already use; choose what context to give that assistant, then paste its JSON back for review. Tasks are unselected by default unless recognized as asks/offers. Every draft entry has an explicit audience, default Only me; selecting a group or Public is an affirmative choice. Only selected entries are saved. Existing X/GitHub/website links and LinkedIn import remain separate supported screens. Photo/live bookshelf sync and X scraping are not implemented.

Social stores the canonical nodes and their owner under the exact verified Ideaflow issuer and subject. First save explicitly consents to a Social profile and this narrow Unlinked connection. A dedicated partner secret enables read/update of intake-created entries only; it does not grant access to existing private Social data. Social's durable request receipt makes retry safe; edit revisions reject stale writes. `/asks/:id` supports status and audience changes, including sharing a previously private entry with a current community. When the saved community is unavailable, group-audience edits require an explicit current community selection or a change of audience; the form never substitutes another community.

Entries with `requiresSocialReview: true` or an audience outside `only_me`, `group` and `public` require visibility review in Social. Both `/asks` and `/asks/:id` show a **Review visibility in Social** link to the canonical Social entry instead of an Unlinked edit form. Unlisted entries are labeled **Unlisted · manage in Social**; other review-required entries are labeled **Audience needs review in Social**, never Only me. If a save returns Social's `entry_visibility_conflict`, Unlinked gives fixed guidance to find the Social link in My asks and offers; it never displays upstream message text or URLs.

Unlinked owns membership and blocking. Before showing a group projection it obtains live authorized members, resolves their persisted identities, requests only exact-group placements, and verifies the roster again. Live member/block checks and persisted identity resolution run with at most eight concurrent operations per pass and retain roster order; lookup failures deny the projection. Removed members and blocked pairs are excluded. No membership is copied to Social or Superconnector. Joining Unlinked does not join a Superconnector network; the handoff uses the same Ideaflow ID.

`/asks` and `/groups/:id/community` show one bounded Social page at a time, with Older entries and Newest entries links. They accept only a positive integer `cursor` and `limit` (default 100, maximum 500), with entries ordered by descending id below the cursor. Only Open entries appear in group views; Done and Paused entries stay in personal tracking. Group pages repeat live roster validation on every request, even when filtering leaves a page empty. Editing a saved entry uses its id to fetch the exact position in the owner's paginated entries, retaining revision checks for saves.

## Configuration and release

Set `UNLINKED_SOCIAL_INTAKE_SECRET` to the dedicated value configured as Social's `IDEANETWORK_UNLINKED_SECRET` (at least 32 characters), using protected service environment files. `UNLINKED_SOCIAL_INTAKE_ORIGIN` defaults to `https://social.ideaflow.app`. Deploy the compatible Social partner routes before enabling Unlinked. No provider/model credential is required. When disabled, group signup still works and profile pages explain the unavailable connection.

All intake routes use authenticated sessions, same-origin POSTs and CSRF; group routes also enforce live membership. Responses are no-store/noindex with neutral anonymous metadata. Inputs, prompts and profile entries are never placed in invite URLs. Do not put the partner secret into a browser bundle, logs or repository.

Validation: `node --test tests/community-intake.test.mjs tests/collective-group-browser.test.mjs tests/private-composition.test.mjs`; full Node suite on the designated cloud builder. The HTTP fixtures cover signup intent, selected-only save, CSRF/origin rejection, edit-to-group authorization, former-community form submission, Social visibility review and conflict guidance, final no-store headers, bounded 500-seat reads, and membership/block revalidation. Standalone launcher fixtures cover configured and unconfigured intake forwarding plus login, flyer join, welcome, review, CSRF rejection, private save and personal asks. These fixtures use synthetic identities and Social data; production signup, live Social persistence and browser visual verification remain separate.

## Member context and suggested connections

Every current member has a group-local profile at `/groups/:id/community/:memberId`
(the organizer uses `organizer`). These pages show only open entries already
shared with that community, with the same pagination and live access checks as
the community board. Pagination selects a community-wide page before filtering
for the member, so a member page can be empty while older entries remain.
Names and member IDs come from the authorized roster;
identity hashes and operational owner IDs stay server-side. A separate public
profile link is shown when available. Group-local content is not added to the
public profile or anonymous link previews.

Suggested connections compare open asks with offers from other current members,
in both directions, using explicit shared words and a small set of topic
aliases. Each suggestion shows both entry titles and the overlapping topics; it is
not an AI endorsement or a compatibility score. Suggestions use the current
page of authorized entries, not private imports or hidden personal asks. Empty
results invite a more specific ask/offer and browsing the member list.


## Member profiles and everyday asks

Groups is a primary signed-in navigation link and **Me → My groups** also opens
`/groups`. Each current member has a private group profile, including members who
have not imported LinkedIn or published a public profile. The name and View profile
open it; **Group profile** describes its audience, not an unclaimed account.
Message uses the current authorized roster identity, with CSRF and the existing
OpenChat owner resolver. It opens an empty composer and never sends a message.
Removed or blocked members cannot use a stale action to resolve a recipient.
Groups in common are a signed-in intersection, never the other person's full
membership list, and are omitted from public APIs and previews.

**Add an ask** opens a focused title/details/audience form at
`/groups/<group>/asks/new`. Group membership is rechecked at save. The group is
visibly selected; Only me saves a private draft and returns to My asks, so a private
save does not appear to disappear from the group board. Existing introduction and
batch-import drafts retain their existing private defaults. The welcome page
suggests LinkedIn import and the normal profile page without blocking group use.
