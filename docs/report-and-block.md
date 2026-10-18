# Report and block

App Store guideline 1.2 requires a way to report objectionable content and to
block abusive users (beads `unlinked-ac9.1`). Unlinked mirrors OpenChat's
own report and block (OpenChat-wgl, OpenChat-46p) and keeps its own record,
because Unlinked messaging runs on the OpenChat API through
`mcp-server/messaging-proxy.mjs`.

## Report

| What | Where | Route |
|---|---|---|
| A profile (member or imported) | profile **•••** menu → **Report** | `/people/<id>/report` (public; signed-in reports carry CSRF) |
| A message | message actions (hover / tap) → **Report** (others' messages only) | `/messages/report?conversation=<id>&message=<id>` (signed in) |
| A conversation | conversation **⋯** menu → **Report conversation** | `/messages/report?conversation=<id>` (signed in) |

The form asks for a reason (spam or scam, harassment, hate or threats, sexual
or violent content, fake profile or impersonation, something else), optional
details and an optional reply address. It is stored as an `UnlinkedSafetyReport`
(`kind: report`) and emailed to `support@ideaflow.app`, exactly like a removal
request ([removal-requests.md](removal-requests.md): same store, budget,
honeypot, operator script and email path). A message report keeps the message
as OpenChat had it (sender, text, time) in `evidence`; a conversation report
keeps its latest 20 messages. Message and conversation reports are also
forwarded, best effort, to OpenChat's own queue (`POST /api/chat/reports`). The
reported person is never told. After reporting a member, the page offers Block.

## Block

| From | Route |
|---|---|
| A member's profile **•••** menu → **Block** | `GET` confirm, `POST /people/<id>/block` (CSRF) |
| A one-to-one conversation **⋯** menu → **Block <name>** | `GET` confirm, `POST /messages/block?conversation=<id>` (CSRF) |
| Settings → **Blocked people** → **Unblock** (also on the blocked profile) | `POST /blocks/unblock` |

`mcp-server/member-blocks.mjs` keeps one `UnlinkedMemberBlock` node per blocker
and blocked person (unique `key`; indexes on blocker and blocked owner; in the
graph-migration LABELS), naming the blocked person by whatever is known: their
Unlinked account (from the profile, or from a conversation partner's claimed
profile), their public profile id and their OpenChat user id. Blocking:

- **Connection requests**: `createConnectionRequests({ blocked })` refuses new
  requests and accepts in either direction (`connection_not_available`; agent
  tools answer `request_unavailable`). Blocking ignores an incoming request,
  withdraws an outgoing one and removes an existing connection.
- **Messages**: OpenChat's own block (`POST /api/chat/users/<id>/block`, as the
  member) drops messages either way. Unlinked also hides the direct
  conversation from the inbox, serves no history for it, refuses to send to it,
  drops the person's messages from the live stream, and answers a profile
  Message link with "You blocked …". Group conversations are not hidden.
- **Notifications** from the blocked profile are hidden; their profile shows
  "You blocked …" with Unblock instead of Connect and Message.
- The blocked person is not told. Unblocking reverses all of it (and OpenChat's
  block). Account deletion removes blocks the member made and blocks of them.

Tests: `tests/report-and-block.test.mjs` (a real-Neo4j store test runs when
`UNLINKED_TEST_NEO4J_*` is set).
