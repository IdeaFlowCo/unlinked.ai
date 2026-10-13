# Member-published profile links

Public person pages show a compact link row in the profile header: the retained
LinkedIn address and explicitly public website (docs/profile-details.md), then
the links the member chose to publish — X/Twitter, Substack, GitHub, Bluesky,
YouTube, Instagram or any HTTPS website (unlinked-8dm). The row keeps the
existing `profile-links` style: `Label ↗` items separated by `·`, deduplicated
by address, with one LinkedIn at most (the professional address wins).

## Validation authority

`classifySocialLink` and `normalizeSocialLinks` in
`src/utils/public-people/profile-links.mjs` own the grammar: credential-free
HTTPS only (bare addresses get `https://`, `http:` upgrades, every other scheme
fails), LinkedIn restricted to the existing person grammar, known hosts
labelled by name and anything else labelled by host and path, at most
`SOCIAL_LINK_LIMITS.maxLinks` entries of `maxLength` characters. Both the store
and the renderer re-validate: a stored row that no longer classifies is
dropped, never rendered. Labels are escaped like all view text.

## Editing and persistence

Signed-in members edit their links on `/profile` (the Links card, one address
per line; an empty save removes them all). `POST /profile/links` follows the
session CSRF and origin rules and redirects with `links=saved|invalid|limit`
(plus the 1-based `line` for an invalid entry). Records live one per account in
`mcp-server/profile-social-links.mjs` (`UnlinkedProfileLinks`; memory and Neo4j
stores, label registered with the graph migration), carrying the public profile
id they were published for. The public page reads by profile id with the same
bounded lookup as company facts — a slow graph read costs the link row, never
the page. A record saved before the profile was published (or under a profile
id that has since moved or merged) stops matching and `/profile` rebinds it to
the member's current public profile id, like `/card`'s identity sync. Account
deletion removes the record.

## Boundaries

Links are member-published public data by explicit choice. Contact-card
fields, email addresses and phone numbers never travel through this feature
(`mailto:`/`tel:` do not classify), ownership is never inferred from a pasted
URL, and the public JSON detail API and agent tool schemas are unchanged —
the row renders on the HTML page only.
