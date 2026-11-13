# People filtering and ordering

The signed-in **People** navigation opens **My connections** (`/network?connected=1`), the first scope tab, with **Recently connected** selected by default. Known connection dates sort newest first; unknown dates remain last. **Everyone** stays a separate discovery tab at `/network`. Explicit sort selections still win, and clearing connection filters restores newest first. The Home recent-connections link uses the same connected scope.

The standalone People directory uses one visible, labelled native GET search field in the toolbar above the list; the header search stays on this page like every other, empty, for a new search of everyone. The filter form always submits to `/network`, including from AI POST results at `/ask` or `/search-account`. Signed-in members have **Everyone** and **My connections** (`connected=1`) scope links. Membership stays visible as **All**, **On Unlinked** (`presence=member`), **Legacy members** (`presence=legacy`), and **Not yet on Unlinked** (`presence=shadow`). Query, directory scope, membership, matching mode, and sort survive searches, links, pagination, and return URLs from connection actions. Everyone supports only name and default/relevance ordering, so switching to Everyone drops a private date sort.

Signed-in page views (`/network`, `/network/contacts/<id>`, the profile preview and the Everyone fallback list) reuse one account network read per owner while younger than `networkFreshMs` (15 s default, 0 restores per-request reads); any finished POST by that owner except `/search` drops it, so accepting, adding or revoking shows on the next page. `/export` and owner AI search always perform a fresh account network read, subject to [verified observation row reuse](private-noos-staging.md#publication-and-scale). GET page navigations are served `Cache-Control: private, no-cache` (back/forward-cache eligible, so Back from a profile restores the results instantly); sign-out and switch-account answer with `Clear-Site-Data: "cache"` so restored pages die with the session. APIs, auth, export, photos and `/c/<token>` stay `no-store`.

Typing filters on the server after a 300 ms pause. It searches the full eligible dataset, not only the rows in the browser, and orders results before pagination. Membership eligibility is applied before deciding whether all-word matches exist or partial matches should be shown. Older requests are cancelled and cannot replace newer results. Rapid control changes retain the pending query, membership and sort; pagination restarts when those controls differ from the displayed results. Controls remain native GET forms and links without JavaScript; failures keep the previous results, show an error, and restore Apply with the pending query, sort and hidden filter state, including newly selected private date sorts. Back/Forward restore list state and the search field. A refresh preserves the control focused when the response arrives if it survives in the new results, including the search selection; focus outside the directory stays untouched. Duplicate person actions retain focus within their original result section and source row, and surviving open removal disclosures remain open. AI ranking remains an explicit action. The result summary shows the current public or connected page size and full matching total; My connections also shows the unfiltered connection count. Clear filters resets query, membership, matching mode and sort while keeping the directory scope. Clear search removes only the query and matching mode.

One card per person (unlinked-tto.4): the owner's connection records join when they share exact identity evidence — the same published profile (the row's own target or the published profile with the same LinkedIn address, merges followed) or the same LinkedIn address — through `groupConnectionRows` in `mcp-server/connection-identity.mjs`, the grouping `unlinked_list_connections` uses. Names never join records; people who only share a name stay separate cards and keep their company next to the headline. A joined card shows the published profile's name, headline, membership and actions, the LinkedIn link and earliest dates from the records, and a quiet **N sources** disclosure listing each record with its provenance and a link to the owner's own record. **Everyone on Unlinked** leaves out every published person matched under **People you know** (`exclude` on the public reader, applied after ranking and bound into its cursor), so the sections never repeat someone; the summary counts cards across both sections. The profile page's connection count and preview, the AI fallback list and AI picks use the same cards.

Browser `sort` values:

- `best`: existing default order, or relevance during a query.
- `name` / `name-desc`: name ascending / descending from the first letter or number (leading emoji and punctuation are ignored; accent- and case-insensitive; names display as written), with deterministic ID ties. The agent tools share this key and add `raw` code-point order ([agent API](agent-api.md#name-ordering)).
- `connected`: My connections only, newest original LinkedIn connection or accepted Unlinked connection first.
- `imported`: My connections only, descending date of first known import into the owner's network.

Date order never substitutes a batch import date for a connection date. Dates come from the original Connections `connected on` field, the live owner's import creation time, or accepted invitation/request `respondedAt`. Unknown dates stay last; duplicate public identities retain their earliest known date, so reimporting does not make an existing contact look new. Rows display the date used, and the sort explains its meaning.

Dates are owner-only listing metadata and are not projected onto public profiles. The browser requests full result counts explicitly; reader ordering, cursor isolation and API compatibility are owned by the [public People reader contract](public-people-reader.md).

Regression coverage: `tests/network-one-card.test.mjs` covers one card per person, section partition, counts and same-name separation; `tests/network-controls.test.mjs` covers server-wide filtering and ordering across pages, cursor isolation, native form state, date semantics, authenticated date ordering, and public date isolation. `tests/network-filter-script.test.mjs` covers pending query/sort/membership state, pagination after edits, Back/Forward, focus during fetches and native fallback after failures.

## Structured filters and saved results

The browser's **All filters** section adds `degree=1|2|3`, `location`, `company`
(current), `pastCompany`, `title`, `school` and `industry`. Text facets are
case/accent-insensitive substring matches, combined with AND before keyword
ranking and pagination. Empty fields do not match a nonempty facet. Current
company/title uses undated or current positions and the profile's current
company/headline; past company requires an ended position. Connection degrees
use the shortest recorded visible path from the viewer's known direct contacts,
up to three hops; unknown reachability is never labeled third-degree. Additional
hops honor connection-list audience rules. The UI uses one compiled snapshot
per page and batched profile lookup, with no provider calls per filter change.

All facets survive native GET submission, pagination and connection-action return
links. Live filtering updates the address bar and Back/Forward restores the
controls. **Copy search link** copies the rendered query URL; it reruns in the
recipient's own account and does not grant access to the sender's network.

Signed-in members can check results and **Save selected results**. Each list holds
up to 200 selected people on that page, a name and the original search URL. It
is a fixed membership set, not an automatically changing saved query. `/lists`
and `/lists/<id>` are browser-only, account-scoped pages backed by the
`UnlinkedSavedSearchList` Neo4j store. Records survive runtime restarts, are part
of graph recovery, are included in account export, and are removed with account
deletion. Current publication/owner contact access is checked again on read.

**Create share link** explicitly shares the list name and currently listed public
profile IDs under a random revocable `/lists/shared/<token>` address. Private
contacts, query text, notes and connection paths are excluded. Every shared read
rechecks current public listing: removed, suspended and unlisted profiles drop
out. Turning off sharing invalidates the link; creating another rotates it.
Shared pages are no-store, noindex and no-referrer. No list is shared by saving it.
These browser routes do not add agent tools or expand existing agent grants.

Profile headers also show **1st · Your connection** to the signed-in viewer when the same exact-identity network read recognizes the person, or an accepted Unlinked connection exists without an import. **Date added** is the earliest known import date; **Connected on** stays separate and is omitted when unknown. These are private viewer context, never public API fields. The existing bounded owner cache supplies the header; if unavailable, no relationship is inferred. Self and blocked profiles suppress this context. Metadata rows have vertical spacing; removal stays available in More and below profile content.

### Cold owner reads

Cold owner observation reads use the shared [publication reader contract](private-noos-staging.md#publication-and-scale), which owns batch bounds, authorization, fallback behavior and regression coverage.
