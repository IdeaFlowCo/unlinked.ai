# Collective network

In the standalone Unlinked web runtime, open **Lists → Collective network** to
create a private group. From the group, create an invitation for a member by
pasting their published Unlinked profile link. This verifies an existing
Unlinked account binding. The organizer can copy the invitation link and open
the existing OpenChat composer for that profile; creating or opening the
invitation sends no message. The recipient can also find it on their own
Collective network page.

Opening a link displays a review page only to the signed-in intended recipient.
They must choose **Accept invitation** to join, or **Decline** to retire the
invitation. Links expire after seven days and cannot be reused after acceptance,
decline, cancellation or member removal. The organizer can cancel a pending
invitation and remove an accepted member. Groups have one organizer and up to 32
additional members. Invite links cannot onboard a new account or replace the
existing Unlinked account invitation.

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

Attribution may point to the canonical
`/groups/<groupId>/invites/<inviteId>` destination, or associate the two opaque
UUIDs with a source in its own store. Treat that association as descriptive
metadata. Do not use it to identify the recipient, check membership, mint an
invite, or record a conversion merely because a redirect or GET occurred.
Group GET and sign-in return paths use the canonical route without campaign
query fields. The ACL neither reads nor writes attribution. A future conversion
event would require a separately reviewed hook after a committed acceptance.

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
