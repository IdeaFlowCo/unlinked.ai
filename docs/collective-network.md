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
limit, including its CSRF token; other group-management forms keep their 4 KiB
limit. Community introduction and intake forms retain their separate 64 KiB limit.
These fields appear in authenticated group, introduction, community and
group-local member views, and the organizer’s export;
they are excluded from direct and flyer invitation previews. When configured,
**Message the group** is the primary OpenChat button, before the description;
on the group detail page it appears just below the heading, outside **About this
group**. It opens the existing chat for people who have already joined;
otherwise, they review the invitation and choose whether to accept.
**Join the WhatsApp group chat** remains a separate link when configured.
Saving either link sends no message and does not synchronize membership or
content to either service.

## Community chat and addresses

With the existing trusted OpenChat messaging integration configured, each managed group
has one shared conversation. Joining (or organizer approval) queues chat membership;
leaving/removal queues its removal. The durable outbox retries transient failures
without duplicate conversations or messages. Delivery normally follows within a
poll interval; while the chat service is unavailable membership updates remain
pending. Group membership is authoritative; standalone chat invites and participant
edits are disabled for managed conversations. WhatsApp remains optional and separate.

The primary **Message the group** action opens the native Unlinked inbox in the
same tab. **Open separately in OpenChat** opens that same conversation externally.
Existing conversations are bound through the verified activation service below;
this preserves their history. Never change that binding after activation.

New groups get stable readable URLs (name plus a short disambiguating suffix).
Organizers can choose **Opaque ID** in group information; readable aliases stop
resolving while this mode is selected. Original UUID routes and invitations stay
valid in both modes. A readable name is not an authorization grant: private group
content still requires membership, and anonymous invitations omit private metadata.

### Activation and safety boundaries

New groups are `chatManaged: true` from creation. Existing groups without that
flag remain on their original invitation action, including after initialization,
metadata edits and restarts. Initialization creates constraints only; it never
queues or activates legacy groups. Native actions require both managed status and
the configured messaging integration.

After the reviewed backend is deployed and the native Unlinked release passes
health checks, a trusted operator calls the domain service
`groups.activateChat(organizer, groupId, { existingConversationId })`. The service
requires the live organizer and an injected `verifyChatActivation` adapter. The
adapter receives the server-resolved organizer, group ID and conversation ID and
must independently verify current chat ownership and backend/native health,
returning `{ healthy: true, organizerVerified: true, conversationId, organizer: { issuer, subject } }`.
The service independently resolves the organizer’s live immutable identity through
its configured `active` reader and requires the proof to match that identity.
An activation caller cannot supply the identity. The normalized organizer binding
is saved in the outbox in the same transaction as managed status and the existing
conversation ID, before delivery can run or account deletion can remove the group.
There is no
browser or agent-grant activation endpoint and no new credential. Runtime
composition accepts this trusted adapter as `verifyCommunityChatActivation`;
without it activation fails closed. The group and organizer are checked again
after verification, and a concurrent group edit requires fresh review. Repeating
the same activation is harmless; changing an established binding is refused.
Boulder's existing conversation must remain `44HsMDzl6YZ7l1AdNusAT`, preserving
history and all 12 verified current members. Activation itself does not edit the
Unlinked flyer or UUID invitations. OpenChat retires its standalone invite on the
first acknowledged managed snapshot. After activation, rollback must retain the
binding, native entry and managed authorization; do not restore obsolete chat
invites or participant writes. Prefer a forward correction.

Group seats grant chat participation subject to the existing safety exceptions:
inactive or unresolvable accounts and members blocked either way with the
organizer have no effective group access and are excluded from chat. Member-to-
member blocks do not remove group seats. Block/unblock enqueue new revisions at
the member-block service boundary. A reconciliation callback failure does not
discard the committed block/unblock record or its OpenChat peer identity, so
downstream safety actions still run. Actual block-store failures still reject;
the periodic audit repairs roster changes whose callback failed. Account deletion
removes participation before the identity is deleted. External identity/account changes and interrupted
boundary callbacks are rechecked by a separate audit timer: one completed
managed roster per 60 seconds, rotating through the directory. A full sweep takes
one audit interval per candidate group. Audit work does not hold the delivery
queue; due membership updates and retries run independently on the one-second
delivery timer. Pending jobs recheck access before retry; block/unblock and group
transitions enqueue immediately. Changed access enqueues a new revision, and an
audit failure waits for its next bounded turn without stopping delivery. Operators changing bindings outside the app should also call
`groups.reconcileActor(actor)`. A missing or changed organizer identity closes
the chat under its original organizer binding, never transfers ownership. Remote
access changes remain pending during outages; existing block rules stay in force
in Unlinked.

### Durable recovery and minimization

`UnlinkedGroupChatJob` and its unique `id` constraint are part of the actual
`graph-migration.mjs` export/shared-export/import/verification domain. Recover
this outbox with the group documents, not as an optional cache. Pending jobs
contain only `id`, monotonic `revision`, a chat-only `document` (name, organizer
binding and accepted roster), `deleted`, `done`, retry fields, an organizer
identity binding, `fingerprint` and an optional `lastSnapshot`. Descriptions,
invitation URLs, pending invitees, profile IDs and list selections never enter
the job. A prepared snapshot is compare-and-set once per revision and is replayed
unchanged after an acknowledgement loss. Access changes get a higher revision;
an older receipt cannot complete it.

Acknowledgement removes the document, snapshot and retry data. An active receipt
retains only `id`, revision, done, the access fingerprint and original organizer
identity needed for a future deletion. Deletion immediately replaces any pending
roster with a minimal tombstone (group ID, optional bound conversation ID, neutral
name, original organizer identity), and acknowledgement drops that identity too.
For a new deterministic conversation with no prepared snapshot, no remote request
could have been sent and deletion can retain just the revision fence. Existing
bound conversations always retain a pending deletion tombstone, even before their
first sync. Activation supplies its verified organizer identity atomically; an
existing conversation with a missing binding remains pending rather than falsely
claiming deletion is complete. Pending tombstones retry until
acknowledged. The recovery integration test exercises native snapshots, shared
export, import/verification, deletion and acknowledgement minimization.
