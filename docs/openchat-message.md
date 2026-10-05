# Message with OpenChat

Every rendered person profile offers **Message with OpenChat** beside its profile
controls: canonical `/people/:id` for signed-out and signed-in visitors, the
member's `/profile`, and the retained Next.js public/private profile components.
It opens OpenChat in a new tab with `noopener noreferrer`; nothing is sent,
no contact is added, and no account is linked by opening the action.

The OpenChat-owned receiving contract is
`https://chat.ideaflow.app/app/?intent=compose&source=unlinked`, with an optional
`profile` query parameter containing the exact canonical public
`https://www.unlinked.ai/people/:id` URL. OpenChat retains this unsent context
through its sign-in/onboarding flow, asks the sender to choose a recipient from
OpenChat, and requires an explicit Send. Unlinked passes no name, email,
account identifier, card token, conversation identifier or message payload.
Names, imported email and Unlinked membership never establish an OpenChat
recipient. Unclaimed people use the same truthful profile-context compose flow.

The member's own profile reuses the existing card flow's snapshot-verified
published target. If that target is absent, unavailable or removed, its action
opens generic recipient selection without exporting any private profile fields
or IDs. Historical Supabase profiles have no verified public mapping and use
that same generic compose entry. A missing OpenChat account or recipient never
becomes an invented direct message; the sender chooses an available contact.

`src/utils/openchat-profile-context.mjs` owns the shared context/link validation.
The canonical host and `/people/:id` grammar exclude private routes, contact
card tokens, credentials, arbitrary destinations, query strings and fragments.
Existing `/c/:token` card sharing and `/meet` confirmation remain unchanged.
The receiving contract is owned by OpenChat's `docs/unlinked-compose-contract.md`.
Unlinked merge and runtime rollout must wait until the coordinated OpenChat
receiver has passed its gates, been deployed and been verified. The Unlinked
release executor checks that dependency; Unlinked does not deploy or modify
the receiver.

Verification executes anonymous and synthetic signed-in HTTP profile flows,
public-target removal, both Next.js profile renderers, and actual generated
link parsing. OpenChat verifies sign-in continuation and no-write-until-Send
with its own capture fixtures. No acceptance check sends personal outreach.
