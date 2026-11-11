# Private list progressive loading (unlinked-prz4)

The private list keeps its existing owner-authenticated HTML route and 50-link
cursor service. Load more progressively appends member rows; its href remains
a normal next-page link without JavaScript and for modified clicks. Every fetched
page is authorized again, same-origin, same list, no-store, and bounded to 50 rows.
No private-list JSON endpoint, sharing permission, account data or schema changes.

Loading is explicit, not scroll-triggered. Concurrent clicks are suppressed,
member IDs deduplicate overlapping boundaries, and repeated cursors fail rather
than loop. Errors preserve current rows and the retry cursor. Live status announces
loading/results; focus moves to the first added row, including the final page.
An empty filtered page can still advance. No-JS pages include a first-page link.

Back restoration stores only page URLs and scroll position in history.state;
it re-fetches each page through normal authorization when a new document loads.
Member HTML is never persisted in browser storage. Native bfcache can retain the
current document under ordinary browser rules. No service worker cache is added.
Restoration is capped at 100 pages; longer sessions can continue loading manually.

Targeted tests: private-list-loading.test.mjs and private-lists.test.mjs.
Deployment remains the standalone runtime release owner's guarded rollout,
not the historical Next.js/Vercel preview. The synthetic preview has no real data.
