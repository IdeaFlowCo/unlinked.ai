# Account linking

In Settings → Login identities, a member can link a second Unlinked login and
choose which login’s records to view. Both sign-ins open the primary account by
default. Unlinking restores the other login as a separate account. Up to eight
logins can be attached to one primary, and an account with attachments cannot
itself become an attachment.

## Records and reversibility

The merge attaches the duplicate’s entire owner scope to the primary account.
Unlinked’s connections, imports and originals, private lists, settings, profile
overrides, and Noos notes keep their original owner and record IDs. The existing
screens read and write that owner’s records when selected in Settings. This
preserves conflicting settings, import state, notes revisions, and links to
existing public profiles. Network searches and downloads use the selected
records. New work defaults to the primary records. On unlink, any work done
while viewing the attached records stays with those records.

The operational graph keeps its immutable Ideaflow issuer/subject bindings.
Unlinked’s browser uses an additional attachment on the duplicate owner to
resolve its login to the primary. Existing service accounts and API grants
keep their original private scopes. Crossed sessions can use Unlinked records
but cannot reveal or issue API keys, authorize OAuth clients, use OpenChat
sessions or groups, claim a legacy profile, or delete an account. Deletion of a
primary account with linked logins requires unlinking first.

## Authority and audit

Authority comes from the configured Ideaflow OIDC issuer and exact subjects.
Email and names never join accounts. Both logins must already have Unlinked
accounts. Self-linking requests fresh authentication for each identity using
`prompt=login`, and requires a signed `email_verified: true` with an email
on each proof. Future sign-ins through an attached login also require that
verification. The regular standalone login policy is unchanged. A primary
login session without verified email can still use its own records. Unlinking
requires fresh proof of the primary login. The flows bind PKCE, nonce and
state to the browser and bind one-use, five-minute confirmations to the
initiating session and its CSRF token.

An operator-listed super-admin can enter two exact account IDs, reauthenticate
and confirm the verified addresses associated with those accounts. These
addresses are observed on provider sign-in and are display evidence. The
mutation rechecks the subjects, account state, addresses and topology under
lock. Admin identities cannot participate in a merge.

Neo4j commits the attachment, immutable `UnlinkedAccountLinkEvent` audit entry
and session fence together. The audit stores operation, actor, account IDs,
and the link ID needed to pair unlink with its original link. It excludes
emails and provider credentials. Merge and unlink invalidate affected browser
sessions. A session for an attached record is restored only while the exact
attachment and session epoch still match. Both accounts can sign back in as
soon as the operation commits.

## Activation and verification

`UNLINKED_ACCOUNT_LINKS=on` enables Settings mutations. Optional
`UNLINKED_ACCOUNT_LINK_ADMINS` is a JSON array of exact Ideaflow subjects
authorized as super-admins, set only in operator configuration. Disabling new
mutations retains existing sign-in routing and access to attached records.
Keep link-aware runtimes in service while any attachments exist. Return to a
pre-feature runtime only after authorized unlink of all attachments and
session invalidation. The graph recovery domain includes the link audit
label and attachment properties.

The signed OIDC harness covers the fresh prompt and verified-email claim.
Source CI runs synthetic account-link and unlink flows through the canonical
browser handlers and a disposable Neo4j graph. Production enablement and any
operation on a real account require their own authorization.
