# Collective network

In the standalone Unlinked web runtime, open **Lists → Collective network** to
create a private group. From the group, create an invitation for a member by
pasting their published Unlinked profile link. This verifies an existing
Unlinked account binding. The organizer can copy the invitation link and open
the existing OpenChat composer for that profile; creating or opening the
invitation sends no message. The recipient can also find it on their own
Collective network page.

Opening a direct invitation displays a review page only to the signed-in intended recipient.
They must choose **Accept invitation** to join, or **Decline** to retire the
invitation. Links expire after seven days and cannot be reused after acceptance,
decline, cancellation or member removal. The organizer can cancel a pending
invitation and remove an accepted member. Groups have one organizer and up to 32
additional members by default.

For a printed flyer, the organizer creates a separate **Flyer invitation** on
the group page. The reusable link expires after 180 days. The organizer chooses
group capacity from 2 to 500, including their own seat, and either explicit
joining or organizer approval. Creating again while the link is usable returns
the existing link. The organizer can revoke it and issue a fresh link.

Visitors can see the group title at
`/groups/<groupId>/join/<inviteId>`. Sign-in and new-account creation return to
that invitation. Membership requires the signed-in person's affirmative
**Join this group** POST with the browser's CSRF token. If approval is enabled,
the organizer must approve the request before membership is granted. Group
capacity includes pending requests. Repeated submissions by one account retain
one seat. Revoking the link rejects subsequent join requests and clears pending
requests. Existing accepted members retain their membership until removed.

An interrupted signup can resume for 24 hours using an HttpOnly return cookie
containing the validated flyer destination and source query. An expired OIDC
transaction restarts sign-in with a fresh state and PKCE exchange.

For the optional introduction and post-join destination, see
[Community introductions and asks](community-intake.md). The flyer landing shows
membership or pending-request state when reopened by the signed-in applicant.
An account removed after joining through that flyer cannot reuse the same
link. Flyer membership retains the group's existing selected-list ACL boundary.

To give a group access to a list, the organizer chooses a specific existing
private list or saved search, reviews the list name and listed public profiles,
then clicks **Share with this group**. The group receives access to that
projection alone. A list share does not enable public link sharing, expose the
source list, or disclose imported-only contacts, addresses, notes, descriptions,
source files, connection edges or the saved search query. Future additions are
not included; removed entries, unavailable source lists and profiles no longer
listed are filtered out on read. Choose **Revoke list access** to disable that
share for everyone. Revoking and sharing again creates a different URL. A member
removed from the group cannot open any of its list URLs, even with an old link.
Previously viewed or copied information cannot be recalled.

The group ACL lives in the standalone runtime. OpenChat remains the messenger
and its existing composer requires an explicit send; it receives no group ACL,
list contents, or invite URL automatically. Browser mutations use the existing
origin and CSRF protections. The organizer and recipient are bound by both
operational owner and user IDs. Invitation and ACL transitions lock one group
record; list access checks the active account, group membership and exact share
again after resolving the projection. Group pages are private, no-store and
noindex. There are no added agent, public API or mobile store surfaces. Account
deletion removes the organizer's groups or the departing account's seats and
invitations; exports include the owner's own selections and participation.

## Attribution interface

The flyer destination is `/groups/<groupId>/join/<inviteId>`. Direct invitations
retain `/groups/<groupId>/invites/<inviteId>`. Attribution can associate those
opaque UUIDs with a source in its own store. Flyer destinations accept one each
of `src`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and
`utm_term`, using 1–120 URL-safe identifier characters per value. The canonical
invitation and query travel in the existing OIDC transaction's validated
`next` value. The affirmative join records those source fields on the accepted
seat or pending request. The fields provide descriptive provenance.

The current YC flyer uses `utm_content=yc_fall_2026_collective_v2`.
The attribution worker owns mapping its homepage campaign URL to the verified
flyer destination. That mapping should preserve the source query. Redirects and
GET previews create zero seats. A future conversion event requires a reviewed
hook after committed acceptance.

The attribution owner is `codex/referrals-20261110` (Paseo
`96f9951d-1598-4c69-9d56-a288a3a9de67`). Its server-only observer contract is
`attachAcceptedInvite({ owner, inviteId, acceptedAt })`. The group service
validates the invite, commits admission and checks the selected-list ACL.
The observer associates an existing signup receipt with completed admission.

Call the observer after a newly accepted membership is durably committed.
`owner` identifies the admitted account using both owner and user IDs.
`inviteId` is the immutable direct-invite or flyer UUID. `acceptedAt` is the
first committed acceptance time in server-generated milliseconds. For an
approval request, use the applicant's account when approval creates the seat.
Preview, sign-in, pending requests, declines and repeated joins do not produce
another acceptance. The integration must retain the original acceptance time
for retries and tolerate an unavailable observer after membership commits.
The current group slice does not call this observer yet.

The lists owner is `codex/lists-20261110` (Paseo
`ff7f0090-5a17-4846-9917-07a9cf38adaa`). Group selection reuses
`privateLists.list(owner, after)`, `privateLists.get(owner, id, after)`
and the existing saved-search store. Its projection remains bounded to 200
reviewed public profiles. Table and performance work should preserve these
owner-scoped read contracts.

## Local review

The historical Next.js dev server does not serve the group pages. Install the
repository's locked root and MCP dependencies, then run:

```sh
node --test tests/collective-groups.test.mjs tests/saved-search-lists.test.mjs
node scripts/preview-collective-network.mjs /private/tmp/unlinked-groups-preview
```

The HTTP tests start the actual standalone browser handler on an ephemeral
loopback port with fictional OIDC, lists and published profiles. They exercise
`/lists`, `/groups`, the invitation review and POST, selection and share pages,
and list/member revocation. The optional Neo4j test uses only the disposable
loopback CI fixture. The preview script writes static fictional pages for visual
review; its forms and links do not perform the flow. Open the generated files
in a browser to review the organizer, invite, review and member views. No real
account, import, email, OpenChat send, or production graph is needed.

`UnlinkedCollectiveGroup` is in the graph recovery allowlist. Standalone
composition with a public People projection initializes its additive ID
constraint when the normal release is started. Coordinate any production
activation separately; no migration or rollout is part of source review.

## Group description and chat

Organizers can edit a plain-text description (up to 2,000 characters) and
optional WhatsApp and OpenChat invitations under **About this group**. Descriptions
render as escaped plain text, preserving line breaks. The group service
checks organizer authority and updates the existing group document atomically;
no migration or separate membership store is required. Empty values clear the
fields independently. WhatsApp accepts validated HTTPS `chat.whatsapp.com`
invitation URLs. OpenChat accepts only `https://chat.ideaflow.app/i/` followed
by 32 letters, digits, underscores or hyphens, with no credentials, nondefault
port, query or fragment. The metadata form alone has a 32 KiB encoded-body
limit, including its CSRF token; other group forms keep their 4 KiB limit.
These fields appear in authenticated group, introduction, community and
group-local member views, and the organizer’s export;
they are excluded from direct and flyer invitation previews. Opening the link
lets the member choose whether to join that chat; saving it sends no message and does
not synchronize membership or content to either service.
