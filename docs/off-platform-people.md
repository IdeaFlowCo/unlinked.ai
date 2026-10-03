# Off-platform people: add someone, or invite them

Two member actions for people who are not on Unlinked. Both live in the
signed-in runtime (`mcp-server/private-browser.mjs`); neither publishes anything.

## Add a person (`GET`/`POST /people/add`)

- Fields: first name (required); last name, LinkedIn profile address, company
  and role (optional). Each text field is at most 120 characters, without control
  characters. A given address must be a LinkedIn `/in/` profile; it is
  canonicalized by the import parser's own `linkedinUrl()` (a bare
  `linkedin.com/in/x` becomes `https://www.linkedin.com/in/x`).
- The person is staged as a one-row `Added people.csv` in the shape of LinkedIn's
  export. The parser accepts that file with only a first name; a row without an
  address gets the private subject `unlinked:added-person:<sha256 of the typed
  fields>`. LinkedIn's own `Connections.csv` still requires the address. Staging
  goes through `stageArchive` with **private consent**
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
- Not yet: removing a single added person (account deletion removes all of them).

## Invites (`/invites`, `/invites/revoke`, `/i/<token>`)

Module: `mcp-server/member-invitations.mjs`. Storage: `UnlinkedMemberInvitation`
nodes in the pilot graph (`createNeo4jInvitationStore`), wired by
`private-composition.mjs`. The routes exist only when the runtime supplies the
store.

- **Create** (`POST /invites`, signed in, CSRF): the member types the invitee's
  name. The server mints 32 random bytes as a 43-character base64url token and
  stores only its SHA-256, the inviter's owner id and display name, the invitee
  name and `status: pending`. Links do not expire (Jacob, 2026-10-02). The link
  `<origin>/i/<token>` is shown once, with an optional `mailto:` draft. While
  email is on, the member may also give the invitee's address and Unlinked
  emails the link for them, from "<Member> via Unlinked"; the address is not
  stored ([email.md](email.md)).
- **No caps.** Every 50th invite an account creates within a day writes a
  `member_invites_heavy_use` event (owner hash and count) to the runtime audit
  log, so heavy use is visible without blocking anyone.
- **Open** (`GET /i/<token>`, signed in or not): shows "<inviter> invited <name>
  to Unlinked" and nothing else about either account. The response sets
  `Referrer-Policy: no-referrer` and is rate limited (60 per minute). Unknown
  tokens return 404. Expired, used and revoked invites say they are no longer
  available.
- **Answer** (`POST /i/<token>`, signed in, CSRF, `action=accept|decline`): a
  compare-and-set from `pending`, so a token works once. The inviter cannot
  answer their own invite. Signing in from the link returns to it before the
  old-account and find-me steps, and the page then continues to them.
- **What accepting does:** it connects the two accounts (Jacob, 2026-10-02). Each
  sees the other in People you know (an `unlinked-invite` row that links to the
  other's public profile when they have one), and when both have a public
  profile the shared public graph carries an edge between them. See the
  [signup source precedence](signup-profile-lookup.md#public-projection-and-export-precedence)
  for confirmed signup profiles and later imports. The inviter sees
  "Accepted" with the name the invitee signed in with. Accepting never claims a
  profile, and the inviter's private notes never transfer.
- **Revoke** (`POST /invites/revoke`): only the inviter, only while pending.
  Removing an accepted invite connection is covered by the
  [member connection guide](member-connections.md#connection-controls-and-removal).
- **Account deletion** removes every invite the account created and revokes the
  invites it accepted, which ends those connections.

## Decided by Jacob, 2026-10-02

Accepting connects both people; a name alone is enough to add someone; links do
not expire and there are no caps, with heavy use logged.
