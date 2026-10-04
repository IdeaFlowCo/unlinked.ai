# Email: invites, notifications and export reminders

The signed-in runtime sends three kinds of email through
[Resend](https://resend.com/docs/api-reference/emails/send-email)'s HTTP API
(`fetch`, no SDK):

- **Invite emails**, sent on a member's behalf when they give the invitee's
  address on `/invites`.
- **LinkedIn export reminders** ([eligibility and timing](#linkedin-export-reminders)).
- **Notification emails** for the in-app notification feed
  ([member-connections.md](member-connections.md#notifications-mcp-servermember-notificationsmjs)).

Code: `mcp-server/member-email.mjs` (configuration, transport, templates,
unsubscribe tokens, the mailer and its graph store). Wiring:
`mcp-server/private-composition.mjs`. Routes: `mcp-server/private-browser.mjs`.
Tests: `tests/member-email.test.mjs` (a fake transport; no network).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `UNLINKED_EMAIL_ENABLED` | on | `false`, `0`, `off` or `no` turns **all** sending off. Anything else (or unset) leaves it on |
| `RESEND_API_KEY` | none | Resend API key. Without it nothing is sent and the app behaves exactly as before |
| `UNLINKED_EMAIL_SECRET` | none | **Required.** Dedicated key for unsubscribe-link signatures and invitee-address hashes: hex or base64/base64url, **at least 32 bytes after decoding** (e.g. `openssl rand -hex 32`). Missing or shorter: email is disabled entirely (no routes, no sending) and the runtime logs one line, `unlinked_email_disabled: UNLINKED_EMAIL_SECRET is missing or shorter than 32 bytes`. Changing it invalidates unsubscribe links already sent and resets the per-recipient invite history |
| `UNLINKED_INVITE_EMAILS_PER_DAY` | `500` | Site-wide ceiling on invite emails per rolling day |
| `UNLINKED_EMAIL_FROM` | `Unlinked <noreply@id.ideaflow.app>` | Sender for notification and export-reminder emails. Its address is also the sender of invite emails, which use the display name `<Member> via Unlinked`. Must be on a domain verified in Resend (`id.ideaflow.app` is). An invalid value turns sending off |

Sending happens only when the flag is on **and** a key and a valid secret are present. In the
private pilot these go in the runtime's private `runtime/runtime.env`, which
Compose passes to the runtime container as its `env_file`; nothing else needs
to change (see `deploy/private-pilot/README.md`). The key is never logged,
serialized or put in an error message.

**To turn email off:** set `UNLINKED_EMAIL_ENABLED=false` (or remove
`RESEND_API_KEY`) and restart the runtime. The invite page and Settings go back
to how they looked before; unsubscribe links in emails already sent keep
working.

## Invite emails

On `/invites` the member types a name and, optionally, the invitee's address.

1. A bad address is refused before anything is created.
2. The invite link is created exactly as before and shown once on the page.
3. If an address was given, the email is sent at once (10-second bound), from
   `"<Member> via Unlinked" <noreply@id.ideaflow.app>` (a long name is
   shortened to 60 characters; the suffix always stays), with `Reply-To` set to
   the member's **verified** sign-in address when one is known. The form says
   so beside the address field ("Replies go to <your address>, so they will see
   your address"). It contains the exact `<origin>/i/<token>` link.
4. The page says whether it was emailed. Either way the link is still there to
   copy, so a failed or refused email never loses the invite.

The invitee's address is **not stored**. The raw link exists only at creation
time, so there is no later retry. To enforce limits, the runtime keeps one
`UnlinkedEmailSend` row per sent invite with only a keyed HMAC of the address
and a hash of the sender's account, pruned after seven days. Claiming an invite
never uses email (accepting needs a signed-in account and a click), so nothing
else needs the address.

Limits (refused sends are reported on the page and nothing is emailed). They
are checked and reserved in **one atomic step** (`reserveInvite`): in the graph,
one write transaction takes the `UnlinkedEmailInviteLock` node, recounts and
creates the send row only when every limit allows it, so parallel requests can
never exceed a cap. A failed send releases its reservation.

- **Per member:** 50 invite emails per rolling day (`INVITE_EMAILS_PER_DAY`,
  equal to the heavy-use report threshold `HEAVY_INVITES_PER_DAY`); **10** in
  an account's first 24 hours (`NEW_ACCOUNT_INVITE_EMAILS_PER_DAY`). An
  account's start is recorded only when it signs up while email is on;
  accounts that existed before are never treated as new.
- **Site-wide:** `UNLINKED_INVITE_EMAILS_PER_DAY` (default 500) per rolling day.
- **Per recipient:** one invite email per address per seven days, from anyone.
- **Suppressed addresses:** someone who used the unsubscribe link in an invite
  email never gets another invite email (`UnlinkedEmailSuppression`, keyed
  HMAC only).

## Notification emails

Which kinds are emailed by default is `NOTIFICATION_KINDS[kind].email`
(`mcp-server/member-notifications.mjs`); members change it per kind in
Settings:

| Kind | Default |
|---|---|
| `connection_request_received` | on |
| `connection_request_accepted` | on |
| `invite_accepted` | on |
| `profile_claimed` | off (it can reach up to 200 members at once) |

The mailer runs in-process on a 60-second timer (unref'd). Startup never waits
for it, a page request never waits for it, and a failing pass only reports a
code to the audit log (at most once per ten minutes) and tries again on the
next tick. Each pass:

1. Reads up to 500 notifications without `emailedAt`, created between one
   minute and 24 hours ago (older history is never emailed, so turning email
   on does not send a backlog). Members inside their 15-minute window or their
   backoff are excluded from that read, so their held rows can never fill the
   batch and starve other members.
2. Per member: notifications already seen in the app, turned off in Settings,
   or for a member without a verified address are settled without email
   (`emailedAt` set, `emailOutcome: skipped`).
3. If the member was emailed in the last 15 minutes, the rest wait and join
   the next email. Otherwise they are claimed (`emailClaim`, compare-and-set),
   sent as one email (a digest when there are several), and stamped
   `emailedAt` with `emailOutcome: sent`.
4. Failures, by kind:
   - **429, 5xx, or 401 (rejected key):** the claim is released, the pass
     stops, and all sending (notifications, invites and export reminders) pauses: for
     `Retry-After` when Resend sends one, otherwise 2, 4, 8 … minutes, capped
     at one hour. A success resets it. (401 is treated like an outage rather
     than a per-message rejection, so a bad key cannot discard every
     notification.)
   - **Any other 4xx (403, 422 …):** permanent. `emailedAt` is set with
     `emailOutcome: failed` and the notification is never retried.
   - **Network errors:** the claim is released and only that member backs off
     (2 minutes doubling to one hour, `retryAfter` on their recipient record);
     a success clears it.
   A pass that crashed between sending and stamping leaves a claim that goes
   stale after ten minutes; the retry uses the same Resend `Idempotency-Key`,
   so Resend does not deliver it twice within its 24-hour idempotency window.

`emailedAt` is only ever set where it is still null, under the record's write
lock, so it is set exactly once. A withdrawn request's notification is a
tombstone and is never emailed.

**Known limit:** the 15-minute window and the provider pause live in one
runtime. Two runtimes sharing a graph could each send a member one email in the
same window (never the same notification twice). We run one runtime.

### Where the member's address comes from

At sign-in, while email is on, the runtime records the address Ideaflow
returns, with whether Ideaflow marked it verified (`email_verified`), in a
private `UnlinkedEmailRecipient` node (with the member's preferences). Only a
verified address is ever emailed or used as `Reply-To`. A member who has not
signed in since email was turned on has no address yet; Settings tells them to
sign in again. The address appears in no page except the member's own Settings,
is included in their data export and is deleted with their account.

## LinkedIn export reminders

The same mailer checks new accounts on its 60-second timer and sends when **48
hours** have elapsed after signup, then **72 hours** if a file is still missing.
Reminders use the existing verified sign-in address, sender, transport/backoff,
unsubscribe links, Settings email choices and account-deletion cleanup; no new
provider or credential is needed. “Remind me to download and upload my LinkedIn
export” is on by default. New accounts created through invitations are enrolled
too; returning sign-ins do not reset the signup anchor. There is no enrollment
for older accounts or accounts created while email was off.

Before each send the runtime authorizes the owner and reads owner-scoped import
job receipts, including files still processing, and recovered original files.
Internal receipts from manually adding a person and deleted receipts do not
count as a LinkedIn upload. A successful upload cancels the remaining reminders
immediately; a failed upload check sends nothing and retries later. An email already in flight can finish
if an upload happens during its provider request. Turning email off stops all
reminders; unsubscribe stops this reminder category only.

Each recipient stores an atomic claim, outgoing payload and completed stage, so
two processes cannot send the same stage concurrently. A stable Resend
idempotency key, signup-anchored unsubscribe token and persisted outgoing message
keep retry payloads identical after restart, including after address or sender
changes; retries stop 23 hours after the stage's first attempt to stay within
Resend’s 24-hour deduplication window. Stale claims recover after ten minutes.
Missing the first window sends only the second reminder, and accounts at least
four days old receive no backlog. All state remains on the private recipient
node and is deleted with the account.

The email explains the [export download guidance](../README.md#import-linkedin-archive)
and directs the member to `/import`. Signup time is only a reminder anchor:
Unlinked cannot see when LinkedIn’s email arrives, so the reminder never claims
an exact expiry date.

Composition coverage for manual-person, deleted, processing and recovered-file
receipts is in `tests/private-composition.test.mjs`; invited signup enrollment
and upload cancellation are covered by `tests/private-invitation-browser.test.mjs`.

## Preferences and unsubscribe

- **Settings → Email** (`/settings#email`, `POST /settings/email` with the
  session CSRF token) shows the member's own address and one checkbox per kind.
  It appears only while email is on.
- **Every email** says why it was sent and has an unsubscribe link, plus
  RFC 8058 headers: `List-Unsubscribe: <https://…/email/unsubscribe?t=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **The link works without signing in.** `GET /email/unsubscribe?t=…` only
  shows a confirm button (link scanners must not unsubscribe anyone);
  `POST /email/unsubscribe` (the button, or a mail provider's one-click POST)
  turns it off. That one POST route is exempt from the same-origin check,
  because mail providers post without the site's `Origin`; the signed token is
  its only authority and it can only turn email off.
- **Tokens** are `v1.<payload>.<HMAC-SHA256>` with a key derived from
  `UNLINKED_EMAIL_SECRET` (never from another credential). The payload names an account hash (never
  an id or address) or an invitee-address HMAC, the kinds to stop, and an
  expiry one year out. Forged, altered, expired or out-of-scope tokens are
  refused. Notification emails stop exactly the kinds they contained; invite
  emails suppress that address for future invite emails.

## Privacy and logging

- No email address, token or key is ever logged or written to the audit log;
  failures record only a code such as `email_transport_status_422`.
- Graph labels: `UnlinkedEmailRecipient` (member address, verified flag,
  preferences, last-emailed time, backoff, new-account start and reminder claims,
  stages and persisted outgoing payload),
  `UnlinkedEmailSuppression` and `UnlinkedEmailSend` (hashes only), and one
  `UnlinkedEmailInviteLock` node. `initialize()` only adds their own
  constraints and indexes.
- Account deletion removes the member's recipient record and their send rows.
