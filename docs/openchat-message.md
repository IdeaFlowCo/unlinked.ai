# Message with OpenChat

Unlinked and OpenChat share an Ideaflow account. OpenChat is the messaging network
and the only message store; Unlinked is the professional network. The web
**Messages** surface at `/messages` is Unlinked's own inbox, thread and composer
(no OpenChat client bundle, no iframe). It reads and writes OpenChat's
conversations, history, unread state and realtime events through Unlinked's
server, so the standalone OpenChat apps show the same inbox.
Member profiles open their direct conversation inside Unlinked; unclaimed
profiles show **Not on Unlinked yet** and an invitation.

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

For members, OpenChat's unique shared identity key reuses their existing inbox or
creates it lazily, and Unlinked opens the direct conversation with an empty
composer. Unclaimed people show an invitation instead. The sender must press
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


## Native inbox transport

`mcp-server/messaging-proxy.mjs` serves `/messages/api/*` for the signed-in
browser session only (never agent grants). It obtains the member's 10-minute
embedded OpenChat token from the confidential `/api/unlinked/session` exchange
(`createMessagingSession` in `mcp-server/messaging.mjs`, which reads the live
owner's Ideaflow binding), keeps it in server memory for 8 minutes, and never
puts it in HTML, JSON, URLs or logs. The browser talks only to this origin; the
page CSP keeps `connect-src 'self'` and has no `frame-src` or camera/microphone
delegation.

- Reads: conversation list, a page of messages (`?before=` ISO cursor), unread
  total, search. Writes are POSTs with `Content-Type: application/json` and the
  session's `X-Unlinked-CSRF` header (send, read, mute, edit, delete,
  reaction, typing, focus). Same origin is required for every POST.
- Ids are validated (`[A-Za-z0-9_-]{1,80}`) and encoded before reaching an
  upstream path; bodies are rebuilt from allowed keys; content is 1–8000
  characters; reactions use OpenChat's own emoji allowlist.
- Responses are projected through a whitelist: no email or legacy email
  fields, avatar URLs, status messages, attachment URLs or preview images.
- Upstream calls time out after 8 s with `redirect: 'error'`; a 401 refreshes
  the credential once; other failures return `{error}` without upstream detail.
  Per-member budgets: 300 reads, 60 writes and 40 typing pings per minute.
- Sent message ids are derived per member from the browser's UUID `clientId`
  (`ul_` + sha256 prefix), so retries are idempotent and a member cannot point
  OpenChat at another message id.
- `/messages/api/stream` is Server-Sent Events. One upstream Socket.IO v4
  connection per member (`mcp-server/openchat-socket.mjs`, a minimal client
  over the runtime's WebSocket) is shared by that member's streams (at most 3)
  and lingers 20 s after the last closes. Gaps are replayed from OpenChat's
  `/messages/since` using `Last-Event-ID` (the last message time). After three
  failed socket attempts the bridge polls every 4 s and retries the socket each
  minute. Reaction `byMe` from socket events is dropped because OpenChat
  computes it for the reacting member. Typing is relayed only into a room
  OpenChat confirmed joining.
- `GET /messages?profile=<canonical profile URL>` resolves on the server
  (OpenChat's `/api/unlinked/recipient`, then its direct-conversation service)
  and redirects to `/messages/c/<conversationId>`; it never sends a message.
- The header **Messages** count is OpenChat's unread total, cached 15 s per
  member (failures 60 s) and bounded like the other header counts.

## Inbox and thread features

`mcp-server/messages-client.mjs` (vanilla JS, `textContent` only) provides:
inbox filter (`/` focuses it) and an unread-first toggle; **New message**, a
picker over your connections who are on Unlinked (`/messages/api/people`:
public profile ids, names and headlines only; browser session, same origin,
20 reads/minute); reactions from OpenChat's allowlist; reply with a quoted
chip that jumps to the original; edit (also ↑ in an empty composer) and
delete your own messages; copy; typing indicators (expire after 6 s; sent
only into a joined room); presence and last seen; Sent/Seen; drafts per
conversation; a header menu with mute (1 h, 8 h, until unmuted), local
**Mark as unread**, **Enter sends** and Open in OpenChat; **View on Unlinked**
when the thread was opened from a profile (the profile id travels in the URL
fragment, never to a server); a "↓ New messages" chip; offline banner with
automatic retry of failed sends; and keyboard navigation (arrow keys in the
list, Alt+↑/↓ between conversations, Esc to clear a reply or cancel an edit).
Drafts, preferences and profile links stay in this browser's localStorage.
Notifications for accepted connection requests open the direct conversation.

## Attachments, search and the dock

- **Attachments.** Images and voice notes in OpenChat messages are public
  capability URLs in one bucket. The proxy only shows URLs that match the exact
  `https://storage.googleapis.com/openchat-attachments/attachments/<user>/<id>/<file>`
  grammar, and only through `/messages/api/file?u=` on this origin (CSP
  `img-src 'self'` is unchanged). That route requires the session, fetches with
  `redirect: 'error'`, allows image/audio types only, caps files at 20 MB,
  passes byte ranges through, and responds with `nosniff` and a sandbox CSP.
- **Uploads.** Images up to 10 MB, 4 per message, by picker or paste. Each one
  is posted raw to `/messages/api/attachments` with the CSRF header. OpenChat
  presigns the upload as the member, the server PUTs the bytes to the bucket
  host, and returns an opaque key. A message can attach only keys this proxy
  issued to the same member. Uploads are budgeted at 20 per minute.
- **Search.** Press Enter in the filter box to search messages in every
  conversation (OpenChat keyword search). Choosing a result opens its thread
  and loads up to ten earlier pages to reach and highlight the message.
- **Dock.** Other signed-in pages at 1024 px and wider show a collapsed
  **Messaging** bar with the unread count. It opens the same client in a
  380×560 panel. The event stream runs only while the dock is open. Open/closed
  state and the current thread persist in localStorage. A profile's **Message**
  link opens the conversation in the dock instead of leaving the page. The
  client is one static, content-hashed script
  (`/public-assets/messages-client.js?v=`) that reads a non-executable
  `#msg-config` block (CSRF token, thread id, emoji list, dock flag).
- **View on Unlinked** for any partner who claimed a published Unlinked
  profile. OpenChat's confidential `POST /api/unlinked/identities` (service
  secret) names which of the member's own conversation partners have a shared
  Ideaflow identity. Unlinked maps each identity to its owner (read-only),
  then to that owner's own profile, and links it only if the published index
  shows that profile as a member. Results are cached 10 minutes per member,
  and the lookup is bounded (2.5 s) so it never delays the inbox. Names,
  emails and imported rows are never used, and nothing private is returned.
- **Mark as unread** is durable in OpenChat (`PATCH .../unread`). The
  conversation counts as unread in every OpenChat app until it is read again,
  and read receipts are unchanged. If OpenChat is unavailable, it falls back
  to this tab only.
- **Block or report** links to OpenChat from the thread menu: embedded sessions
  cannot block (OpenChat's `requireDirectSession`), so it needs a direct sign-in there.
- The legacy Next.js profile pages link **Message** to `https://www.unlinked.ai/messages?profile=…`
  (`unlinkedMessagesUrl`), or to the inbox for private/historical rows, instead of
  OpenChat's web compose page. `openChatProfileMessageUrl` remains for OpenChat's
  own compose contract.

LinkedIn messaging remains plan-only; the coordinated OpenChat repository owns
`docs/linkedin-messaging-plan.md` (Unipile, Beeper, and existing bridge options).

People results (public search, your contacts, AI picks and connected people) offer **Message** for verified members, linking to their direct conversation. Imported nonmembers offer **Invite to Unlinked**. Unclassified private contacts never imply a recipient.

For accepted member requests, see
[OpenChat acceptance delivery and reconciliation](openchat-accepted-connections.md).
