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
| `status` | `pending`, `accepted`, `ignored`, `withdrawn`, `removed` |
| `createdAt`, `respondedAt`, `withdrawnAt`, `removedAt` | Epoch milliseconds |
| `removedBy` | `sender` or `recipient` for a removed request |

Rules:

- **Who can be asked:** only a profile with `presence: member`. The account
  behind it is resolved server-side (`accountForProfile`), following the
  [member identity source contract](signup-profile-lookup.md#public-projection-and-export-precedence). Shadow profiles offer
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
is notified about their own action. Each account keeps its newest 500. Retraction retains a dedupe-key tombstone, so delayed inserts cannot restore a withdrawn or removed request notification. Tombstones are excluded from feeds, counts and retention pruning; account deletion removes associated tombstones along with visible notifications.

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

**Email:** [email.md](email.md#notification-emails) owns notification email
preferences, delivery timing, suppression and runtime configuration.

## Routes

| Route | What it does |
|---|---|
| `GET /people/<id>` | Shows the shared connection controls described below; signed-out visitors get "Sign in to connect" |
| `POST /connections/request` | `profileId`, optional `note`, optional `next`. Returns to the profile with `?connect=<code>` or a validated network listing with `?notice=<code>` |
| `POST /connections/respond` | `id`, `action=accept\|ignore`, optional `next` |
| `POST /connections/withdraw` | `id`, optional `next` |
| `POST /connections/remove` | `id`, optional `next`; confirmed bilateral removal as described below |
| `GET /invitations` | My Network: Received (default) and Sent tabs, with a link to off-platform invites |
| `GET /notifications` | The feed. Pending requests can be answered in place. Clears the bell |
| `GET /notifications/<id>` | Marks the item read, then redirects to its target |
| `POST /notifications/read-all` | Marks everything read |

All POSTs check the session CSRF token and the same-origin `Origin` header.
The header shows My Network (pending requests received) and a bell (unseen
notifications) between the main links and the Me menu. They are filled per
request through `NAV_ALERTS_SLOT` / `fillNavAlerts`; an unconfigured feature
shows no icon. See [Browser feedback and badge refresh](#browser-feedback-and-badge-refresh)
for updates on already-open pages.

## Agents

The [agent API contract](agent-api.md#optional-connection-actions)
owns the read tools, explicit opt-in write scope and grant compatibility.

## Not yet

- Push delivery. (Email is built: [email.md](email.md).)

## Connection controls and removal

People rows and profiles share Connect, Accept + Ignore, Connected, or Invite controls; outgoing requests use the pending control described in [Browser feedback and badge refresh](#browser-feedback-and-badge-refresh). Connection browsing includes both graph directions; scope, membership filters, counts and ordering are owned by [People filtering and ordering](network-controls.md).

Either participant can remove an accepted member request through `POST /connections/remove`, after the profile/row confirmation. The request becomes `removed`, releases its pair key and removes the agreed edge from both accounts; no notification is sent. A fresh request can reconnect them when no independent imported edge still connects their profiles. Accepted off-platform invite connections also offer removal (their link is revoked). Removal captures the pair’s active request and accepted invitation IDs, then claims the exact selected accepted agreement with a store compare-and-set before settling only those captured agreements. The claim atomically stores those IDs on the selected agreement; either participant can resume an incomplete removal after a store failure, using only its original IDs. Completion closes that retry authorization. A stale duplicate cannot touch a fresh reconnection. Settlement retracts obsolete request notifications and imposes no withdrawal cooldown. Pair reads include every active request and the latest withdrawal per sender regardless of removed history. Reconnecting requires a fresh request and acceptance. Imported observations and claimed profiles remain independent provenance and are preserved. A profile connected by an imported observation can therefore still show Connected and remain in the connections filter after removal; that observation does not offer Remove.

Focused removal regressions run with `node --test tests/connection-removal-races.test.mjs`. To exercise both stores, point `UNLINKED_CONNECTION_TEST_HTTP` at a disposable Neo4j HTTP endpoint on `127.0.0.1` and set `UNLINKED_CONNECTION_TEST_DISPOSABLE=1`; authentication must be disabled. The integration fixtures replace only their synthetic removal accounts’ request/invitation records and exercise real Cypher, including a transaction holding the selected agreement lock.

## Browser feedback and badge refresh

Connect remains a normal form POST, including when JavaScript is disabled.
The redirect shows a “Request sent” confirmation and the next server-rendered
profile or People row shows “Request sent · Pending” with Withdraw. Requests
and notifications persist in the graph, so reloads retain the state. Duplicate,
already-connected and rate-limit results have plain-language notices. Expired
forms/sessions, unavailable profiles and unexpected failures show recovery links;
an uncertain failure asks the member to check invitations before retrying.
Accept/Ignore from Notifications returns there with a status message.

The nonce-authorized `/public-assets/connection-feedback.js` adds an immediate
“Sending…” state and prevents a second submission while the first is navigating.
It restores controls when the browser restores a page from its back/forward
cache. It adds no inline handlers or styles. The authenticated, read-only
`GET /api/nav-alerts` returns only the current account's counts, with `no-store`.
Visible pages refresh badges every 15 seconds and on focus; hidden pages pause,
expired sessions stop polling, and failed reads keep the last confirmed badge.
Polling does not mark notifications seen or read. Without JavaScript, badges
refresh on page navigation. Notification emails already use the Resend mailer
and preferences described in [email.md](email.md); the feed reflects whether
that runtime has email enabled.

For OpenChat synchronization, rollout requirements, durable retry and removal
semantics, see [Accepted connections in OpenChat](openchat-accepted-connections.md).
