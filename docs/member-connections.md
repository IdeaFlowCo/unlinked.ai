# Member connections and notifications

Members can ask each other to connect, and each account has an in-app
notification feed. Both live in the signed-in runtime
(`mcp-server/private-browser.mjs`) and are wired by
`mcp-server/private-composition.mjs`; the routes exist only when the runtime
supplies their graph stores.

## Connection requests (`mcp-server/member-connections.mjs`)

Storage: `UnlinkedConnectionRequest` nodes in the pilot graph. `initialize()`
only adds this label's constraints and indexes (`IF NOT EXISTS`), so it is
additive and idempotent; no existing data is touched.

| Field | Meaning |
|---|---|
| `id` | Random UUID (unique) |
| `pairKey` | SHA-256 of the two accounts, order-independent |
| `openKey` | `pairKey` while the request is pending or ignored (unique) |
| `connectedKey` | `pairKey` once accepted (unique) |
| `sender*`, `recipient*` | `ownerId`, `userId`, a plain display name, the public profile id |
| `note` | Optional, one paragraph, up to 300 characters |
| `status` | `pending`, `accepted`, `ignored`, `withdrawn` |
| `createdAt`, `respondedAt`, `withdrawnAt` | Epoch milliseconds |

Rules:

- **Who can be asked:** only a profile with `presence: member`. The account
  behind it is resolved server-side (`accountForProfile`: a confirmed legacy
  claim, or the publisher of a member import). Shadow profiles offer
  "Invite to Unlinked" instead.
- **No duplicates:** one open request per pair, enforced by the `openKey`
  uniqueness constraint, and one accepted connection per pair (`connectedKey`).
  A person already connected through an accepted invite, or through the
  public graph (one of them listed the other in an export), is shown as
  Connected and cannot be asked.
- **Crossed requests:** pressing Connect on someone who already asked you
  accepts their request.
- **Answering:** only the recipient accepts or ignores; only the sender
  withdraws. Requests belonging to other accounts look the same as unknown ones
  (`connection_not_found`). Transitions are compare-and-set.
- **Ignoring is private:** the sender still sees Pending and can withdraw. The
  recipient can still connect later, which accepts the old request.
- **Limits:** 50 new requests per account per rolling day
  (`CONNECTION_REQUESTS_PER_DAY`). After a withdrawal, the same sender must
  wait 21 days to ask the same person again (`RESEND_COOLDOWN_MS`).
- **Names:** the sender is named by their public profile's name when they
  have one, otherwise their sign-in display name. Values containing `@` or
  markup are never stored as names.
- **Accepting connects both accounts** exactly like an accepted invite: each
  appears in the other's People you know (`readMemberConnections`, provenance
  `unlinked-connection`), and the shared public graph gets an edge when both
  have a public profile. Someone connected both ways is listed once.
- **Account deletion** removes every request the account sent or received,
  which ends those connections.

## Notifications (`mcp-server/member-notifications.mjs`)

Storage: `UnlinkedNotification` nodes, unique `id` and `dedupeKey`. An event is
written with `MERGE` on its dedupe key, so retries never notify twice. Nobody
is notified about their own action. Each account keeps its newest 500.

| Kind | Sent to | When |
|---|---|---|
| `connection_request_received` | Recipient | A request is sent. Retracted if it is withdrawn |
| `connection_request_accepted` | Sender | The request is accepted |
| `invite_accepted` | Inviter | An off-platform invite is accepted (the invitee has joined) |
| `profile_claimed` | Members whose exports listed the profile | Someone claims that profile (legacy confirmation or find-me), up to 200 recipients |

There are two read states. `seenAt` is set when the member opens
`/notifications`, which clears the bell. `readAt` is set when they open an
item (`/notifications/<id>` marks it read and redirects) or press "Mark all as
read"; until then the item stays highlighted.

**Email, later:** `NOTIFICATION_KINDS` marks which kinds should be emailed. A
mailer can select records of those kinds without `emailedAt`, send them, and
then set `emailedAt`. Nothing else needs to change.

## Routes

| Route | What it does |
|---|---|
| `GET /people/<id>` | Shows Connect / Pending + Withdraw / Accept + Ignore / Connected / This is you; signed-out visitors get "Sign in to connect" |
| `POST /connections/request` | `profileId`, optional `note`. Redirects to the profile with `?connect=<code>` |
| `POST /connections/respond` | `id`, `action=accept\|ignore`, optional `next` |
| `POST /connections/withdraw` | `id`, optional `next` |
| `GET /invitations` | My Network: Received (default) and Sent tabs, with a link to off-platform invites |
| `GET /notifications` | The feed. Pending requests can be answered in place. Clears the bell |
| `GET /notifications/<id>` | Marks the item read, then redirects to its target |
| `POST /notifications/read-all` | Marks everything read |

All POSTs check the session CSRF token and the same-origin `Origin` header.
The header shows My Network (pending requests received) and a bell (unseen
notifications) between the main links and the Me menu. They are filled per
request through `NAV_ALERTS_SLOT` / `fillNavAlerts`; an unconfigured feature
shows no icon.

## Agents

Grant catalog version 3 adds two read-only tools,
`unlinked_list_connection_requests` and `unlinked_list_notifications` (see
`docs/agent-api.md`). Grants issued earlier keep their own tool list, so a
member gets these tools after regenerating their agent setup in Settings.
Agents cannot send, answer or withdraw requests.

## Not yet

- Email or push delivery (the model is ready; mail is not configured).
- Removing a single connection (account deletion removes all of them).
- Connect buttons on People result rows (only on profile pages).
- Write tools for agents.
