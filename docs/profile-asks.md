# Asks on profiles

Source implementation for `unlinked-uoj` / `OpenChat-whxy.6`. This change is
unmerged and undeployed. The coordination/release owner retains the explicit
merge, deployment, production environment/graph, native build and restart holds.

A signed-in owner opens **Profile → Add an ask**, writes the request, chooses
**Only me**, **Selected people or groups**, or **Public**, chooses expiry and
presses **Publish ask**. Only me is the default. Native HTML controls support
keyboard, mobile and voice interaction. Owners can edit an active ask, close it
as fulfilled, or remove it after reviewing the inline removal explanation.
Closed asks cannot be republished; create a new ask instead. Expired asks vanish
for other viewers. Changes take effect at the next permission-checked read.

## One canonical record and permission boundary

Unlinked has no ask database or projection cache. Its private server adapter
(`mcp-server/profile-asks.mjs`) calls OpenChat's fixed confidential
`POST /api/unlinked/profile-asks` using the existing dedicated messaging secret.
OpenChat stores an `OpenChatStory` linked by `ACTIVATES` to the canonical
`AgentIntent`; owner edges, Story audiences, blocks and lifecycle remain
OpenChat-owned. New profile asks are Context-only, matching paused, with no
agent search consent. Publication never exposes a raw private intention, draft,
match, counterparty, archive field or Context excerpt. Existing Stories default
to no profile publication; their ordinary authorized feeds remain available.

Only `showOnProfile:true` Stories are read for Unlinked profiles. Public access
requires explicit `profileVisibility:'public'`; selected asks use the existing
selected-user or live shared-conversation audience. Group access ends when
either member leaves. Blocking works in either direction. An empty DM or public
profile never establishes friendship or ask permission. Choosing a specific
person explicitly grants that Story's audience permission; removing a friendship
alone does not revoke that separate explicit selection. Edit the audience or
block the person to revoke it. Hidden asks reveal no counts or metadata.

The viewer is resolved from the HttpOnly Unlinked session. The target is resolved
from the current published profile, its live claimed owner and exact active
Ideaflow issuer/subject, using the existing confidential messaging resolver.
Unclaimed, revoked or ambiguous identities show no asks. Names and imported email
never establish ownership. Owner actions require same Origin, CSRF and a live
owner identity. OpenChat authenticates the service, forbids browser Origin,
rechecks owner/viewer equality for mutations and enforces revision conflicts.
All responses and rendered profile pages are no-store. Public People JSON,
AI search and existing Unlinked agent grants gain no ask access.

## Message about this

The card links to `/messages?profile=<canonical URL>&askId=<opaque Story ID>`.
The ID survives sign-in and the existing embedded/standalone OpenChat entry.
OpenChat first resolves the profile's verified inbox, then checks the ask belongs
to that owner and is currently active, unexpired and readable by the authenticated
viewer. An old revoked link is unavailable, never a generic composer or different
person. The normal direct conversation service supplies the existing thread.
Opening sends nothing and grants no friendship or Context permission.

Verified ask text remains account/conversation-scoped in client memory. The chat
shows **About this ask**, with **Add ask to draft** and **Dismiss**. It never
replaces an existing draft or auto-sends; the sender retains the normal explicit
Send action. Account changes clear pending context. Already-read text cannot be
retracted from someone's memory or messages they explicitly sent.

## Validation and coordinated rollout

`tests/profile-asks.test.mjs` exercises the fixed adapter DTO, escaped controls,
real browser session, same-origin/CSRF mutations, anonymous view, sign-in return
and absence from public People JSON. OpenChat owns real Neo4j permissions,
canonical lifecycle, addressed message and client context tests in
`profileAskPublication.integration.test.ts` and `profileAskEntry.mobile.test.ts`.
All personas are synthetic; no real member ask, publication or message is used.

After the release owner clears the holds, deploy the OpenChat receiver and
canonical web client before the Unlinked adapter. Both use the already existing
`UNLINKED_MESSAGING_SECRET`; no new credential, production graph migration or
identity link registry is required. Coordinate source merges with held Unlinked
PR115/116 and OpenChat PR154/155. Removing the service secret disables this bridge
and existing messaging; reverting Unlinked UI independently stops new profile
writes while OpenChat retains canonical history. No iOS build is part of this
change. A separate native launch remains held.

Owner inventory accepts all fifty active asks plus fifty recent historical asks from the canonical receiver; viewer reads remain capped at fifty active asks.

Failed publish/edit submissions preserve unsaved text, visibility, expiry and
submitted audience IDs in the error page, even when inventory is unavailable.
When inventory is available, failed edits show the stored current text for
comparison and retain the submitted revision, so retrying cannot silently
overwrite a newer version. Audience controls use only currently available people
and groups; submitted IDs remain readable separately for failed edits. During an
inventory outage, recovery is read-only: no publish or edit form is offered.
Copy unsaved changes before reloading the profile; they are not durably saved.
