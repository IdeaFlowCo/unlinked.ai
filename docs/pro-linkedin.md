# Pro: owner-only LinkedIn source and explicit LinkedIn search

Tracker: `unlinked-flav`. Jacob's November 16 directions: “we should have a pro mode at least for me for now that lets me sign in w unipile too” and “if you've signed in with Unipile, and if you search for someone who isn't on our platform, it will offer the option to expand the search to your LinkedIn search.”

**Status: source only, default off, never run against the live provider.** Everything here was built and tested against an in-memory fake of the Unipile v1 API. No provider call, credential, account or production graph was touched. Activation gates are listed at the end.

## What it is

- **Pro → Connect LinkedIn via Unipile** (`/pro`). A Pro owner links their *own* LinkedIn session as a private data source. Ideaflow stays the only application sign-in; this adds no login option and creates no account.
- **Search LinkedIn**, an explicit button under a finished Unlinked search that found no one.
- Network sync, saving LinkedIn results, messaging, invitations, posting and publication are **not** part of this slice. The page says "Network sync: Not available yet".

## Who can use it

`createProAccess` (`mcp-server/pro-linkedin.mjs`) is an exact server-side allowlist of `[ownerId, userId]` pairs plus a feature switch. It is not an access tier (Standard / Enhanced / Verified are untouched and confer nothing here), not a browser flag, not an email match and not inferred from uploaded data. A malformed list disables the feature rather than widening it. For anyone else `/pro` and its actions are the ordinary 404 and nothing is advertised.

| Setting | Meaning | Default |
| --- | --- | --- |
| `UNLINKED_PRO_LINKEDIN=on` | compose the feature at all | off |
| `UNLINKED_PRO_OWNERS` | JSON array of `["ownerId","userId"]` pairs | none |
| `UNLINKED_PRO_UNIPILE_DSN`, `UNLINKED_PRO_UNIPILE_API_KEY` | provider workspace for personal sources (host secret handling; never in this repository, logs or errors) | unset → "not set up", no outbound call |
| `UNLINKED_PRO_SYSTEM_ACCOUNT_IDS` | comma-separated provider account ids that are protected system sources | none |
| `UNLINKED_PRO_LINKEDIN_SEARCH=on` | allow the explicit LinkedIn search | off |

With the switch off or no owner listed, nothing is composed: no graph constraint is created and no route exists.

## Connection contract

1. `POST /pro/linkedin/connect` (session, CSRF, explicit consent checkbox) creates a durable **attempt** (`UnlinkedProAuthAttempt`): opaque attempt id, the SHA-256 of a one-time 256-bit notify token, owner, kind, the source generation it was issued against, 15-minute expiry. Any earlier pending attempt of that owner is superseded.
2. The server asks Unipile for a Hosted Auth link (`POST /api/v1/hosted/accounts/link`, `providers: ["LINKEDIN"]`). `name` is the opaque attempt id; no internal owner or user id is sent. The owner opens the link from a same-origin page (a plain link, so the page's `form-action 'self'` policy is unchanged).
3. **The browser coming back proves nothing.** `/pro?linkedin=returned` shows "Waiting…" until step 4 completes.
4. Unipile calls `POST /api/pro/linkedin/notify/<token>`. Unipile documents no signature for this callback, so the unguessable single-use path token is the correlation and the payload is treated as untrusted: the server then reads the account (`GET /api/v1/accounts/{id}`) and the identity that signed in (`GET /api/v1/users/me`) with its own key. A source is bound only if all of these hold: the attempt is pending and unexpired; `name` and the status (`CREATION_SUCCESS` / `RECONNECTED`) match the attempt; the owner is still eligible; the account is not a protected system id (it is not even read); it is a LinkedIn account whose sources are all `OK`; for a new link it was created at or after the attempt (a pre-existing workspace account can never be adopted); for a reconnect it is the same account *and* the same LinkedIn identity; neither the provider account nor the LinkedIn identity is bound to another owner (unique constraints as well as checks); and the source generation has not moved.
5. The attempt moves `pending → binding → verified|failed` by compare-and-set, so a replayed or concurrent delivery binds nothing. Responses carry no detail: 204 handled, 404 unknown, 503 when verification could not be reached (the attempt stays pending for the provider's retry).

`UnlinkedProSource` holds one node per owner: role `personal`, state (`connected`, `reconnect_required`, `paused`, `disconnected`), generation, the provider account id (server-side only), hashed account and identity keys, the displayed LinkedIn name and public address, `connectedAt`, `verifiedAt` (the freshness shown as "Last confirmed") and consent version. Browser views never contain the provider account id.

- **System isolation.** Sources bound here are always `personal`. Configured system ids cannot be bound, checked, searched, reconnected or removed, and no call uses a default or "first" account.
- **Check connection** reads the provider status of the owner's own account. It is not a sync.
- **Disconnect** moves the generation first (so it wins over a late callback or an in-flight search), then removes that one session at the provider (`DELETE /api/v1/accounts/{id}`). If that removal fails it is shown as pending and retried before any new link is issued. Imports, notes, lists, grants and public profiles are untouched.
- **Account deletion** calls `removeOwner`: that owner's personal source and attempts only.
- **Restart.** Attempts and sources are durable; a callback that arrives after a restart completes normally (tested with a second service instance over the same store).
- Both labels are in `deploy/private-pilot/graph-migration.mjs` `LABELS`, so they are inside the recovery and validation domain.

## Explicit LinkedIn search

- Offered only when all hold: the owner is eligible, search is switched on, their source is `connected`, the Unlinked search has a query, **finished successfully** and returned no one in either section, with no filters or presence narrowing. A failed, unavailable or rate-limited local search is not a no-match and shows no offer.
- It is a POST form. Nothing is requested while typing, on page load or as an automatic fallback.
- One classic people keyword search (`POST /api/v1/linkedin/search`, `api: classic`, 10 results) on the owner's own account. Never the system account.
- Results are labelled **LinkedIn · not yet on Unlinked**, or **Already on Unlinked** only when the exact LinkedIn address resolves to a published profile; a name never matches anyone. The page states the connected account name, the time of the search and how many were shown.
- "Found no people", "rate limited", "needs reconnect", "timed out", "provider unavailable" and "plan does not include this" are different pages with different HTTP statuses. A reconnect error also marks the source `reconnect_required` so it is not called again.
- A per-owner daily bound (20, in process) is counted before the call, so an uncertain outcome is never retried for free. This is a safety bound, not the spending policy.
- Results are a **private preview held only in that response**: not stored, not published, not added to the network, and no message or invitation is sent. Save is deliberately not built; it waits for the retention decision.

## Not verified / open

- The search response is parsed defensively from the documented v1 shape; the exact fields and whether the workspace plan allows classic search were **not** confirmed against a real account. Confirm with one supervised call before switching search on.
- Whether Unipile retries a failed notify delivery, and its timing, was not verified; an unconfirmed attempt simply expires and the owner can start again.
- A provider account created by an attempt that then fails verification is not auto-deleted (it may be a billable seat). The attempt's failure reason is recorded for the operator.
- The Neo4j store was exercised only through a fake driver (statement shape, parameterization, generation fence), not against a live graph.
- The daily search bound is in process and resets on restart.
- There is no navigation link to `/pro` yet.
- Open decisions with Jacob: retention for LinkedIn results (preview + explicit Save recommended), provider spending and cap, pilot audience beyond Jacob.

## Activation gates (none performed)

1. Reviewed release on the live line (main is not the live release; see the handoff notes).
2. The current provider credential and plan confirmed through the host's secret handling; the system account id(s) listed in `UNLINKED_PRO_SYSTEM_ACCOUNT_IDS`.
3. Jacob's exact `[ownerId, userId]` in `UNLINKED_PRO_OWNERS`.
4. The notify path reachable from the provider through ingress, without access logging of the token path.
5. Jacob completes Hosted Auth himself, including any LinkedIn challenge. Nobody else enters his credentials.
6. Search stays off until the spending and retention answers arrive.

Tests: `tests/pro-linkedin.test.mjs`, `tests/pro-linkedin-browser.test.mjs`.
