# Unlisted profiles

An unlisted profile stays published: its page, hover card, links to it,
connection lists that include it, lookups by id or LinkedIn address,
messaging and connection requests all keep working. It is left out of
**listings**: the People directory (`/people`, `/network` Everyone,
`/api/people`, `/search-public`), header suggestions, company pages and AI
search. Implementation: `src/utils/public-people/unlisted.mjs`, applied in the
reader (`list`, `suggest`, `company`) and in `shared-search.mjs`. Tests:
`tests/unlisted-profiles.test.mjs`.

## Operator decisions (`unlist`)

`profile-decisions-operator.mjs unlist <profileId> <group|-> <decidedBy> "<reason>"`
stores an `UnlinkedProfileDecision` of kind `unlist`; `revoke` restores the
listing. With a group (lowercase letters, digits and hyphens, e.g.
`appreview`), the profile is still listed for signed-in members whose own
profile is unlisted in the same group; with `-` it is unlisted for everyone.
A member's group is read from their own public profile and kept for 5 minutes.

The App Store review demo accounts (Robin, Jordan and Casey Demo) are unlisted
in group `appreview`: they see each other, nobody else finds them, and the
reviewer still sees their connections and conversation through their own
network and Messages.

An older runtime (0.6.39 and before) treats `unlist` decisions as inert, so a
rollback lists those profiles again; its operator CLI refuses new decisions
while an active `unlist` exists (revoke them first if that CLI is needed).

## Second accounts of one person

Two **member** profiles from different accounts that are provably one person
are listed once: same LinkedIn address, or the same name, headline and About
text (at least 40 characters; the person's own LinkedIn text). A shared name
alone never counts. The profile with the most connections stays listed (then
one with a LinkedIn address, then id order); the others are unlisted for
everyone. Nothing is merged, because each account keeps its own profile.
This is why Harrison Qian appeared twice: one account published his LinkedIn
export (870 connections), a second account claimed his LinkedIn address at
sign-up; both carry the same headline and About.
