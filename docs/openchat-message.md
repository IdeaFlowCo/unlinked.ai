# Message with OpenChat

Unlinked and OpenChat share an Ideaflow account. OpenChat is the messaging inbox;
Unlinked is the professional network. The web **Messages** surface at `/messages` embeds the canonical responsive
OpenChat client and uses the same conversations, history and read state.
Member profiles open a named composer inside Unlinked; unclaimed profiles show
**Not on Unlinked** and an invitation.

The public action passes only the canonical public profile URL. OpenChat resolves
its recipient server-to-server through `POST /api/messaging/v1/recipient`, sending
`{profileId}` with the dedicated `UNLINKED_MESSAGING_SECRET` bearer credential.
`mcp-server/messaging.mjs` checks the current published snapshot, resolves the
profile's live owner and reads its active Ideaflow issuer/subject binding. Imported
names/email and caller-provided identity fields are never identity evidence.
The response is member + identity + public name, unclaimed + public name, or
unavailable. No private archive fields or email are returned. Only the trusted
OpenChat server can call it; ordinary browser sessions and agent grants cannot.
Missing configuration/outages return 503; requests are bounded and rate limited.

OpenChat shows **Message [name]** and an empty draft for members; its unique shared
identity key reuses their existing inbox or creates it lazily. Unclaimed people
see an invitation path through the sender's OpenChat card. The sender must press
Send. No contact request or message happens on opening the profile. Inbox creation
does not publish a public Unlinked profile or claim an imported contact.

Both apps accept the same Ideaflow login. Unlinked silently creates a private app
record for an already-verified Ideaflow session and returns to the original page;
it does not publish a profile or open onboarding. Recovery of an old profile still
requires its existing explicit confirmation. See docs/ideaflow-sign-in.md.

Configure the same dedicated service secret in the two private server environments.
Roll out this resolver before the coordinated OpenChat receiver/client. Requests
carry no service credential or identity in URLs, logs, HTML or discovery. Removing
the secret disables the resolver. HTTP JSON is no-store, server-to-server only;
this endpoint is not an MCP or account-grant tool.

The strict link grammar lives in `src/utils/openchat-profile-context.mjs`;
private-only/historical profiles use generic compose without exporting their IDs.
OpenChat owns `docs/unlinked-compose-contract.md` and sign-in continuation.


The signed-in `/messages/session` POST requires same origin and CSRF. It reads
the authenticated owner's live binding, then calls OpenChat's confidential
`/api/unlinked/session` with the dedicated service secret. A short-lived session
travels to the exact OpenChat iframe via an origin/window/nonce-bound handshake,
never a URL, persisted browser credential or agent tool. Renewal rechecks the
Unlinked session. Errors show Retry and an OpenChat fallback; private pages and
responses stay no-store. CSP permits only the canonical OpenChat frame.

LinkedIn messaging remains plan-only; the coordinated OpenChat repository owns
`docs/linkedin-messaging-plan.md` (Unipile, Beeper, and existing bridge options).

People results (public search, your contacts, AI picks and connected people) offer **Message** for verified members, linking to their addressed draft. Imported nonmembers offer **Invite to Unlinked**. Unclassified private contacts never imply a recipient. The embedded and standalone fallback URLs both retain the selected profile.

Accepted member connection requests create or reuse one empty shared direct chat;
see [acceptance delivery and reconciliation](openchat-accepted-connections.md).
