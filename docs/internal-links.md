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
  people without a public profile link to `/network/contacts/<privateId>` or
  render as text.

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
visitors share the public budget of 120 requests a minute.
`tests/internal-links.test.mjs` runs the same check against fixture pages.
