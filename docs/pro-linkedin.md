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

With the switch off or no owner listed, no feature is composed: no graph constraint is created, no route exists (`/pro`, its actions and `/api/pro/linkedin/notify/…` answer exactly like unknown routes; tested) and nothing calls the provider. One thing still runs: **account deletion** always performs Pro cleanup (`createProLinkedinCleanup`), so a source or provider session left from an earlier period with the switch on is removed with the account.

## Connection contract

1. `POST /pro/linkedin/connect` (session, CSRF, explicit consent checkbox) creates a durable **attempt** (`UnlinkedProAuthAttempt`): opaque attempt id, the SHA-256 of a one-time 256-bit notify token, owner, kind, the source generation it was issued against, 15-minute expiry. Any earlier pending attempt of that owner is superseded.
2. The server asks Unipile for a Hosted Auth link (`POST /api/v1/hosted/accounts/link`, `providers: ["LINKEDIN"]`). `name` is the opaque attempt id; no internal owner or user id is sent. The owner opens the link from a same-origin page (a plain link, so the page's `form-action 'self'` policy is unchanged).
3. **The browser coming back proves nothing.** `/pro?linkedin=returned` shows "Waiting…" until step 4 completes.
4. Unipile calls `POST /api/pro/linkedin/notify/<token>`. Unipile documents no signature for this callback, so the unguessable single-use path token is the correlation and the payload is treated as untrusted: the server then reads the account (`GET /api/v1/accounts/{id}`) and the identity that signed in (`GET /api/v1/users/me`) with its own key. A source is bound only if all of these hold: the attempt is pending and unexpired; `name` and the status (`CREATION_SUCCESS` / `RECONNECTED`) match the attempt; the owner is still eligible; the account is not a protected system id (it is not even read); it is a LinkedIn account whose sources are all `OK`; for a new link it was created at or after the attempt (a pre-existing workspace account can never be adopted); for a reconnect it is the same account *and* the same LinkedIn identity; neither the provider account nor the LinkedIn identity is bound to another owner (unique constraints as well as checks); and the source generation has not moved.
5. The attempt moves `pending → binding → verified|failed` by compare-and-set, so a replayed or concurrent delivery binds nothing. Responses carry no detail: 204 handled, 404 unknown, 503 when verification could not be reached (the attempt stays pending for the provider's retry). After the source is written the attempt must still be `binding` when it settles; if a disconnect or an account deletion ran meanwhile (both supersede `pending` *and* `binding` attempts), the new source is immediately closed (`disconnected`, generation bumped) and its provider session removed through the ordinary revocation path. For a deleted owner nothing remains except, if that removal failed, a pending-removal record. A status page shows an attempt stuck in `binding` for longer than the attempt lifetime as failed, not as waiting.
6. **Reconnect identity.** If a reconnect signs in as a different LinkedIn identity, the attempt fails `identity_mismatch` *and* the source moves to `reconnect_required` (generation bumped), so it is neither checked back to `connected` nor searched until the owner reconnects as the bound person.
7. **Accounts a failed link created.** When a *create* attempt fails after the provider made the account (not ready, identity already linked to another owner, superseded or replaced link, expired link, Pro access withdrawn, binding superseded), that account is deleted at the provider if it is a LinkedIn account created by this attempt (`created_at` check), is not a system id and is not bound to any owner. A reconnect attempt never deletes anything. If the removal fails or the account could not be verified, the attempt keeps a durable marker (`cleanup: pending`, the account id server-side only) for the operator sweep.

`UnlinkedProSource` holds one node per owner: role `personal`, state (`connected`, `reconnect_required`, `paused`, `disconnected`), generation, the provider account id (server-side only), hashed account and identity keys, the displayed LinkedIn name and public address, `connectedAt`, `verifiedAt` (the freshness shown as "Last confirmed") and consent version. Browser views never contain the provider account id.

- **System isolation.** Sources bound here are always `personal`. Configured system ids cannot be bound, checked, searched, reconnected or removed, and no call uses a default or "first" account.
- **Check connection** reads the provider status of the owner's own account *and* the LinkedIn identity signed in on it (`GET /api/v1/users/me`). It returns `connected` only when the account is healthy and the identity is still the bound one; otherwise `reconnect_required`. It is not a sync.
- **Disconnect** moves the generation first (so it wins over a late callback or an in-flight search), then removes that one session at the provider (`DELETE /api/v1/accounts/{id}`). If that removal fails it is shown as pending and retried before any new link is issued. Imports, notes, lists, grants and public profiles are untouched.
- **Account deletion** calls `removeOwner`: that owner's personal source, attempts and search count only, whenever a Pro store exists, even with the feature switched off. It retries a disconnect that was superseded, removes everything else even when the disconnect fails, and rethrows; the browser records `pro_linkedin_cleanup_incomplete` (owner hash and code only) and continues with the remaining deletion steps. A provider removal that did not finish keeps only its record, marked `ownerDeleted`, for the sweep; once the provider session is gone the record is deleted.
- **Operator sweep.** `sweepPendingRemovals()` (on the composed service and on the cleanup-only object) retries pending source revocations, including deleted owners', and pending attempt cleanups. Each cleanup re-reads the account and re-checks that this attempt created it and that no owner has it bound before deleting. It never touches a system id. Nothing schedules it; an operator runs it.
- **Graph writes.** A compare-and-set miss writes nothing (no placeholder node is created). A record without a known state is not treated as a linked source.
- **Restart.** Attempts and sources are durable; a callback that arrives after a restart completes normally (tested with a second service instance over the same store).
- All three labels (`UnlinkedProSource`, `UnlinkedProAuthAttempt`, `UnlinkedProSearchCount`) are in `deploy/private-pilot/graph-migration.mjs` `LABELS`, so they are inside the recovery and validation domain.

## Explicit LinkedIn search

- Offered only when all hold: the owner is eligible, search is switched on, their source is `connected`, the Unlinked search has a query, **finished successfully** and returned no one in either section, with no filters or presence narrowing. A failed, unavailable or rate-limited local search is not a no-match and shows no offer.
- **Server-enforced, not only in the UI.** Rendering the offer issues a **search receipt**: server-side, single use, valid 10 minutes, bound to the owner and the normalized query (trimmed, whitespace collapsed, case-folded). `POST /pro/linkedin/search` must present a matching receipt; otherwise it fails `local_search_required` and the page says to search Unlinked first, with a link to that search. Nothing is sent to LinkedIn and nothing is counted. Receipts are held in memory (at most 1,000); a restart only means searching Unlinked again.
- It is a POST form. Nothing is requested while typing, on page load or as an automatic fallback.
- One classic people keyword search (`POST /api/v1/linkedin/search`, `api: classic`, 10 results) on the owner's own account. Never the system account.
- Results are labelled **LinkedIn · not yet on Unlinked**, or **Already on Unlinked** only when the exact LinkedIn address resolves to a published profile; a name never matches anyone. The page states the connected account name, the time of the search and how many were shown.
- "Found no people", "rate limited", "needs reconnect", "timed out", "provider unavailable" and "plan does not include this" are different pages with different HTTP statuses. A reconnect error also marks the source `reconnect_required` so it is not called again.
- A per-owner daily bound (20, UTC day) is counted durably in the store (`UnlinkedProSearchCount`, an atomic increment under a write lock) before the call, so an uncertain outcome is never retried for free and a restart does not reset it. This is a safety bound, not the spending policy.
- Results are a **private preview held only in that response**: not stored, not published, not added to the network, and no message or invitation is sent. Save is deliberately not built; it waits for the retention decision.

## Not verified / open

- The search response is parsed defensively from the documented v1 shape; the exact fields and whether the workspace plan allows classic search were **not** confirmed against a real account. Confirm with one supervised call before switching search on.
- Whether Unipile retries a failed notify delivery, and its timing, was not verified; an unconfirmed attempt simply expires and the owner can start again.
- Cleanup of an account a failed attempt created depends on the provider's `created_at`; an account whose verification is never possible stays marked pending until the operator sweep can re-check it. In the rare case that an owner is deleted while such an unverified cleanup is being recorded, the marker is lost with the attempt.
- If disconnect keeps losing its compare-and-set during account deletion (three tries), the source record is still removed and the failure recorded, but that provider session is not revoked; the audit event is the operator's signal.
- The search-receipt condition at the People route (completed, zero results, no failure) is covered at the view and offer level; the full People route with a live local search was not exercised in these tests.
- The Neo4j store was exercised only through a fake driver (statement shape, parameterization, generation fence, compare-and-set miss without a placeholder, deletion keeping only pending removals, the counter's lock-then-read statement), not against a live graph. The concurrency behaviour of the first-write `CREATE` (unique-constraint race read as a miss) and of the counter lock is asserted from Cypher semantics, not observed.
- There is no navigation link to `/pro` yet.
- Open decisions with Jacob: retention for LinkedIn results (preview + explicit Save recommended), provider spending and cap, pilot audience beyond Jacob.

## Activation gates (none performed)

1. Reviewed release on the live line (main is not the live release; see the handoff notes).
2. The current provider credential and plan confirmed through the host's secret handling; the system account id(s) listed in `UNLINKED_PRO_SYSTEM_ACCOUNT_IDS`.
3. Jacob's exact `[ownerId, userId]` in `UNLINKED_PRO_OWNERS`.
4. The notify path reachable from the provider through ingress. **The callback token is in the URL path** (`/api/pro/linkedin/notify/<token>`), so access-log and request-log redaction of that path at our ingress, and confirmation that the provider does not log or expose the notify URL, remain a required activation gate.
5. Jacob completes Hosted Auth himself, including any LinkedIn challenge. Nobody else enters his credentials.
6. Search stays off until the spending and retention answers arrive.

Tests: `tests/pro-linkedin.test.mjs`, `tests/pro-linkedin-browser.test.mjs`.
