# Private list progressive loading (unlinked-prz4)

The private list keeps its existing owner-authenticated HTML route and 50-link
cursor service. Load more progressively appends member rows; its href remains
a normal next-page link without JavaScript and for modified clicks. Every fetched
page is authorized again, same-origin, same list and presentation, no-store, and
bounded to 50 rows. Page URLs must retain the current search query and may contain
only `after`, `view` and `q` parameters.
No private-list JSON endpoint, sharing permission, account data or schema changes.

Loading is explicit, not scroll-triggered. Concurrent clicks are suppressed,
member IDs deduplicate overlapping boundaries, and repeated cursors fail rather
than loop. Errors preserve current rows and the retry cursor. Live status announces
loading/results; focus moves to the first added row, including the final page.
An empty filtered page can still advance.

Back restoration stores only page URLs and scroll position in history.state;
it re-fetches each page through normal authorization when a new document loads.
Member HTML is never persisted in browser storage. Native bfcache can retain the
current document under ordinary browser rules. No service worker cache is added.
Restoration is capped at 100 pages; longer sessions can continue loading manually.
After progressive loading, an unmodified List/Table click while idle converts the
saved page URLs to the selected view and reloads through normal authorization.
The previous view retains its own history entry for Back. Native view links and
search cursor behavior are described in [private list presentation](private-list-presentation.md).

Targeted tests: private-list-loading.test.mjs and private-lists.test.mjs.
Deployment remains the standalone runtime release owner's guarded rollout,
not the historical Next.js/Vercel preview. The synthetic preview has no real data.
