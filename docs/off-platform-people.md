# Off-platform people: add someone, or invite them

Two member actions for people who are not on Unlinked. Both live in the
signed-in runtime (`mcp-server/private-browser.mjs`); neither publishes anything.

## Add a person (`GET`/`POST /people/add`)

- Fields: first name, last name and LinkedIn profile address (required), company
  and role (optional). Each text field is at most 120 characters, without control
  characters. The address must be a LinkedIn `/in/` profile; it is canonicalized
  by the import parser's own `linkedinUrl()` (a bare `linkedin.com/in/x` is
  accepted and becomes `https://www.linkedin.com/in/x`).
- The person is staged as the one-row `Connections.csv` a LinkedIn export would
  contain, through `stageArchive` with **private consent**
  (`COMBINED_UPLOAD_CONSENT`). Member public projection only takes
  public-consent imports, so an added person is never published, whatever the
  site's upload default is.
- The job carries `origin: { kind: 'added-person', label: '<first> <last>' }`.
  Settings lists it as "Added by you: <name>". The header import status and the
  owner's profile builder ignore it.
- From then on it is an ordinary own connection: it appears in People you know
  after the background import (`/network?added=1` says so), your agent can
  search it, and account export and deletion cover it. Adding the same row twice
  replays the same import.
- Not yet: removing a single added person (account deletion removes all of
  them), and adding someone without a LinkedIn address (the import format needs
  one; see the open questions).

## Invites (`/invites`, `/invites/revoke`, `/i/<token>`)

Module: `mcp-server/member-invitations.mjs`. Storage: `UnlinkedMemberInvitation`
nodes in the pilot graph (`createNeo4jInvitationStore`), wired by
`private-composition.mjs`. The routes exist only when the runtime supplies the
store.

- **Create** (`POST /invites`, signed in, CSRF): the member types the invitee's
  name. The server mints 32 random bytes as a 43-character base64url token and
  stores only its SHA-256, the inviter's owner id and display name, the invitee
  name, `status: pending` and an expiry 14 days out. The link
  `<origin>/i/<token>` is shown once, with an optional `mailto:` draft. Unlinked
  never sends anything.
- **Limits:** 50 created per inviter per rolling day, 100 pending at once.
- **Open** (`GET /i/<token>`, signed in or not): shows "<inviter> invited <name>
  to Unlinked" and nothing else about either account. The response sets
  `Referrer-Policy: no-referrer` and is rate limited (60 per minute). Unknown
  tokens return 404. Expired, used and revoked invites say they are no longer
  available.
- **Answer** (`POST /i/<token>`, signed in, CSRF, `action=accept|decline`): a
  compare-and-set from `pending`, so a token works once. The inviter cannot
  answer their own invite. Signing in from the link returns to it before the
  old-account and find-me steps, and the page then continues to them.
- **What accepting does:** it records which account accepted and when, and the
  inviter sees "Accepted". It does **not** link the invitee to any profile, shadow
  or added person, and the inviter's private notes never transfer. Identity still
  binds only through the existing old-account or find-me confirmation.
- **Revoke** (`POST /invites/revoke`): only the inviter, only while pending.
- **Account deletion** removes every invite the account created.

## Open questions for Jacob

1. Should accepting an invite also connect inviter and invitee (an edge both
   can see), or link the inviter's added person to the new member? v1 records
   acceptance only.
2. Should a person be addable without a LinkedIn address? That needs a manual
   person record outside the LinkedIn import format.
3. Is 14 days the right expiry, and are 50 a day / 100 pending the right limits?
