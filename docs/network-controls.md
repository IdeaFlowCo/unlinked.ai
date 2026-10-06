# People filtering and ordering

The standalone `/network` browser page uses one visible, labelled native GET search field in the directory toolbar above the list; other pages keep the header search. Signed-in members have **Everyone** and **My connections** (`connected=1`) scope links. Membership stays visible as **All**, **On Unlinked** (`presence=member`), and **Not yet on Unlinked** (`presence=shadow`). Query, directory scope, membership, matching mode, and sort survive searches, links, pagination, and return URLs from connection actions. Everyone supports only name and default/relevance ordering, so switching to Everyone drops a private date sort.

Typing filters on the server after a 300 ms pause. It searches the full eligible dataset, not only the rows in the browser, and orders results before pagination. Older requests are cancelled and cannot replace newer results. Controls remain native GET forms and links without JavaScript; failures keep the previous results, show an error, and restore Apply. Back/Forward restore list state. AI ranking remains an explicit action. The result summary shows the current public or connected page size and full matching total; My connections also shows the unfiltered connection count. Clear filters resets query, membership, matching mode and sort while keeping the directory scope. Clear search removes only the query and matching mode.

Browser `sort` values:

- `best`: existing default order, or relevance during a query.
- `name` / `name-desc`: name ascending / descending, with deterministic ID ties.
- `connected`: My connections only, newest original LinkedIn connection or accepted Unlinked connection first.
- `imported`: My connections only, newest first import into the owner's network first.

Date order never substitutes a batch import date for a connection date. Dates come from the original Connections `connected on` field, the live owner's import creation time, or accepted invitation/request `respondedAt`. Unknown dates stay last; duplicate public identities retain their earliest known date, so reimporting does not make an existing contact look new. Rows display the date used, and the sort explains its meaning.

Dates are owner-only listing metadata and are not projected onto public profiles. The browser requests full result counts explicitly; reader ordering, cursor isolation and API compatibility are owned by the [public People reader contract](public-people-reader.md).

Validation: `node --test tests/network-controls.test.mjs` covers server-wide filtering and ordering across pages, cursor isolation, native form state, date semantics, authenticated date ordering, and public date isolation. Browser verification covers live typing, query/sort/status preservation, rapid edits, Back, reset, and responsive layout.
