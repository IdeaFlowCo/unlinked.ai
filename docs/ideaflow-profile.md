# Ideaflow interests and asks on member profiles (0.6.71, unlinked-4dig.1)

A member's **Interested in / Looking for / Can help with** come from their own Ideaflow ideas-network
About (social.ideaflow.app) through the universal profile contract `ideaflow.profile.v1`.

- **Source and audience.** Unlinked reads `GET <IDEANETWORK_URL>/api/profiles/by-owner-key/<sha256(issuer\nsub)>`
  without credentials, so only sections the member marked **public** there come back. Unlisted, signed-in-only
  and private bullets never reach Unlinked. Nothing is stored here; each read re-validates (schema, ≤8 items × 160 chars) and fails closed.
- **Identity.** Profile → member account (`accountForProfile`) → that account's one verified Ideaflow identity
  (`identityForOwner`). No names, emails or guesses; no identity, no section.
- **Display.** Visitors see a collapsed "Interests and asks" section (a second click opens it). Collapsed is not private.
  The member sees it open on their own profile with **Hide from my profile / Show on my profile**.
- **Control.** Default shown. The choice is the member's (`UnlinkedIdeaflowProfileChoice`, one per account,
  removed with the account, included in graph backups). Hidden means no lookup for other viewers.
- **Switch.** `UNLINKED_IDEAFLOW_PROFILES=off` in runtime.env turns the feature off; `IDEANETWORK_URL` overrides the source.
- **Not here.** No bulk import, no copy into Unlinked's profile fields, no imported (shadow) or legacy profiles.
