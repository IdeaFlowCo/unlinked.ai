# The People directory in the iOS app

App Store guideline 5.1.1(viii) does not allow apps that compile personal
information that did not come from the person. Unlinked's public directory
includes profiles imported from members' LinkedIn connections ("Not on
Unlinked") and recovered legacy accounts awaiting a claim. The Unlinked iOS app
(`ai.unlinked.app`, a WKWebView shell) therefore shows only people who joined
Unlinked themselves (beads `unlinked-ac9.3`).

**Detection.** The shell appends `UnlinkediOS/<version>` to WebKit's user agent
(`Browser.swift` in the iOS repository). `iosAppUserAgent` in
`src/utils/public-people/members-only.mjs` matches `\bUnlinkediOS/\d`. Every
other client, including Safari on the same phone, gets the website unchanged.

**What changes in the app.** `mcp-server/private-browser.mjs` reads a
members-only index (`createMembersOnlySnapshotReader`) for app requests:

- `/people`, `/network` (signed out and the "Everyone" section signed in),
  `/api/people`, `/search-public`, header suggestions, hover cards, company
  pages and `/api/companies/*` list members only;
- an imported or legacy profile has no page (`/people/<id>` answers 404 with a
  "Profile not available" page), no JSON and no hover card;
- a member's profile lists only connections who are members;
- AI search ("Ask AI") ranks members only;
- the membership filter is hidden, since everyone listed is a member.

The members-only index drops non-member profiles, every edge that touches
them, legacy membership and aliases that point at removed profiles. Its
revision is derived from (and distinct from) the full index's, so compiled
indexes and cursors are never shared between the two.

**What stays.** A signed-in member still sees their own imported people: their
own network rows, Home's recent connections and `/network/contacts/<row>`
detail pages. In the app those rows link to the member's own contact record
rather than to an imported public profile. Agent APIs, MCP and the website are
unchanged. Imported profiles on the website carry a **Request removal** link
([removal-requests.md](removal-requests.md)).

Tests: `tests/ios-app-directory.test.mjs`.
