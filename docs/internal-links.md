# Internal links

A link on an Unlinked page must lead to a page. Two rules keep that true:

- **Company links.** `/companies/<name>` lists everyone whose public profile names
  the company: a position, the profile's own company (the one in the profile
  header) or the headline. It answers 404 only when nobody does and there are no
  reviewed company facts. Every name a page links therefore has a page. Names the
  page cannot look up (no letters or digits, more than 12 words, over 200
  characters) render as text (`companyPageName` in
  `src/utils/public-people/text-match.mjs`).
- **People links** go through `profilePath(id)` (see `profile-handles.md`);
  people without a public profile link to their owner-private contact address
  (`contactPathFor`, docs/contact-slugs.md) or render as text.

- **Claim it.** "Is this you?" on an imported profile only links where this
  viewer can claim it (`claimRouteFor` in `mcp-server/private-browser.mjs`):

  | Viewer | Link |
  |---|---|
  | Signed out | `/join` |
  | Signed in, no profile, recovered legacy row | `/find-me`, or `/login?next=/find-me` when the session was restored after a restart (it no longer holds the claim identity) |
  | Signed in, no profile, other imported copy | `/import`: their own export verifies the address and folds the copy in |
  | Member whose LinkedIn address the copy carries | `/import`, "link it to your profile" |
  | Any other member, or profile unreadable | no prompt |

- **Email addresses.** Every page is wrapped in `<!--email_off-->`. Cloudflare
  (in front of www.unlinked.ai since 2026-10-24) would otherwise rewrite mailto
  links into `/cdn-cgi/l/email-protection` links. Their decoder script is blocked
  by the page CSP, so visitors would see "[email protected]".

Members-only pages answer signed-out visitors with a sign-in page (401 HTML).
That is a sign-in wall, not a dead link.

## Checking a running site

```bash
node scripts/check-internal-links.mjs https://www.unlinked.ai \
  --seed /people/aakarshgpt --pages 90 --per-kind 30 --delay 700 --json report.json
# signed in: --cookie-file <file holding one Cookie header value>
```

The crawler uses only GET requests and skips sign-in, sign-out, MCP and photo
URLs. It follows same-site redirects and prints every internal link that does
not end in a 200 page, with the pages that link it. It exits 1 when any link is
broken. Keep `--delay` at 500 ms or more against production, because real
anonymous visitors share the [public admission budget](agent-access.md#capacity-and-abuse-policy).
`tests/internal-links.test.mjs` runs the same check against fixture pages.
