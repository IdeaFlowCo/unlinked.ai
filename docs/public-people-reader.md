# Public people reader contract

`createPublicPeopleReader()` has no backend or fixture fallback and returns unavailable until the runtime owner supplies a published projection.
This source module changes no route, Noos adapter, authentication, publication or graph data.

The factory injects `readPublishedSnapshot({maxProfiles,maxConnections,maxTextBytes,signal,viewer})`.
The injected adapter is trusted code that produces data-only DTOs. Snapshot and identity values use standard plain objects and arrays without custom prototypes, getters or executable traversal overrides; client input cannot supply the adapter or these values.
The provider returns `{state:'published',complete:true,revision,profiles,connections}` only after one immutable final migration publication fence.
`revision` must be a nonempty ASCII string of at most 128 characters, identifying that immutable publication. Invalid, oversized or non-ASCII backend revisions return the fixed data-free unavailable503 error. This bound keeps every emitted list/connection cursor within the existing 2048-character DTO limit without hashing the revision.
It must enforce current visibility on every profile and both endpoints of every connection before returning any row used in search, ranking or pagination.
`viewer` is null or an immutable server-resolved identity passed through factory configuration; query input cannot supply identity authority. Identity objects and arrays must be recursively frozen plain data, with no accessors, cycles, sparse arrays or mutable nested values.
Unknown, unpublished, unavailable, incomplete, malformed or over-limit snapshots fail closed.
Provider exceptions are replaced with data-free errors.
Requests time out and receive an abort signal; adapters must honor that signal to stop their own work.

Default maxima are 100,000 profiles, 500,000 directed public edges, 96 MiB accepted DTO text and 8 seconds per snapshot call. Text remains bounded to 20,000 characters per field; the higher whole-index cap accommodates published profile histories across member connection uploads.
The standalone runtime warms the process-local public index before opening its HTTP listener only when the source sets `revisionIdentifiesContent: true`; absent or non-content-addressed sources are skipped. It uses an anonymous reader with the default size limits and an eight-second snapshot-read timeout, moving cold compilation to startup without a synthetic viewer or model call. Warmup is best effort: unavailable publication does not prevent account routes from starting. Every subsequent request still reads the live source and validates publication and owner visibility; warmup never authorizes stale rows. Startup ordering and compilation reuse are covered by `tests/public-people-warmup.test.mjs`.
The provider must bound its own fetch/serialization before returning; these maxima are not permission to read private operational rows.
All entity arrays must have their own data entries at every index. On compilation, the factory validates all rows before computing counts/order, never truncates an oversized snapshot, and rejects duplicate IDs/edges or dangling endpoints. Reusing a compiled index relies on the trusted source's content-addressed revision guarantee below.
Empty published snapshots are valid, distinguishable from unavailable publication.

Each published profile has `id`, `name`, optional `headline`, `location`, `about`, optional search-only `company`, and arrays `positions`, `education`, `skills`.
Position fields are `title`, `company`, optional `startDate`, `endDate`, `description`.
Education fields are `institution`, optional `degree`, `startDate`, `endDate`.
The reader also returns the derived status fields described below; email, phone, raw imports, notes, auth metadata and search-only company are never returned as profile properties.
The publication provider must separately sanitize the contents of public biography/professional text, since a whitelist cannot prove free text contains no private information.
Connections are `{fromId,toId}` and remain directed; reciprocal relationships and mutual status are not inferred.

`reader.list({query?,mode?,presence?,enrichmentStatus?,sort?,includeTotal?,cursor?,signal?})` returns `{profiles:[{id,name,headline?,location?}],nextCursor?}` with `match` and `total` for a nonempty query, and `total` for a presence or enrichment status filter or explicit `includeTotal: true`. `exclude` (array of published ids, merged ids resolved) leaves those people out after ranking and before paging and totals; the exclusion set is bound into the cursor scope.
`reader.profile({id,cursor,signal?})` returns `{profile:{...summary,about?,positions,education,skills,connections,nextConnectionsCursor?}}`, or null for an unknown/unpublished profile in an otherwise valid published snapshot.
A profile's connections are its edges from both ends: an edge is stored only from the person whose export listed it, and an edge recorded by both people appears once.
When the snapshot carries `members` (profile IDs supplied by the shared index), every summary and detail adds `presence: 'member'|'legacy'|'shadow'` and `connectionCount` (both directions). See [signup source precedence](signup-profile-lookup.md#public-projection-and-export-precedence) for member identity sources. Snapshots without `members` add neither field. A member or legacy-member ID missing from the profiles is a malformed snapshot (503).
The list accepts `presence: 'member'|'legacy'|'shadow'`; the filter is part of the cursor scope, so a cursor never pages a different filter. A snapshot without `members` matches none of these filters; any other value is a 400. List `sort` accepts `best` (default), `name` and `name-desc`; other values are a 400. Nondefault sorts also bind into cursor scope. The `/api/people` route keeps default ordering and does not opt into unfiltered totals; existing agent defaults are unchanged. Browser use is owned by [People filtering and ordering](network-controls.md).
`reader.lookup({ids,signal?})` takes at most 1000 IDs and returns a `Map` of the summaries that are published, in request order; unknown IDs are omitted.
Overlapping reads without their own signal share one snapshot build. A request-scoped reader may use `reuse: true` to keep one coherent snapshot for that request. Across requests, compiled public indexes are reused only when the trusted source sets `revisionIdentifiesContent: true` and the revision and configured limits match; every request still reads the source and validates its publication envelope. Signed-in viewer-scoped sources never use the shared cache. Returned cached rows are frozen.

The standalone composition wraps immutable public datasets with `cachePublicPeopleReads`: every read checks the current published revision and digest in Neo4j, reusing validated chunks only while both match. Changed, revoked, failed or racing pointers trigger a full store read. The member projection checks current owner/source authorization and includes every content input in its revision. No member page or browser response is cached.

The member projection additionally keeps its last successful build for a bounded freshness window (`UNLINKED_PUBLIC_INDEX_FRESH_MS`, default 20000, 0–300000; 0 disables keeping). A page view inside the window is served from the kept build without reading any source, so a publication, revocation, decision or claim becomes visible to anonymous and member pages within the window plus one build rather than on the very next request. Past the fresh window but inside the stale window (`UNLINKED_PUBLIC_INDEX_STALE_MS`, default 90000, 0–600000, at least the fresh window; 0 disables it, and fresh 0 defaults it to 0), the kept build answers immediately while one refresh with every live owner/source check runs behind it, so no page view pays the rebuild in-band; visibility of a change is then bounded by the fresh window plus one background build under steady traffic, and by the stale window otherwise. A failed refresh or build drops the kept index (fail closed, like suggest), a build that finds no legacy publication drops it immediately, and past the stale window a read waits for the rebuild. The composition also pre-builds the index at startup and keeps it young on a timer (interval at most 45 s, always inside the stale window), so neither the first request after a restart nor the first after an idle gap pays the rebuild in-band; the timer stops with the composition and never tightens the staleness bound.

Company pages match against position-company and headline tokens prepared once per compiled index, not re-tokenized per request.

Decision content and execution order participate in the revision; see [profile decisions](profile-decisions.md) for that contract.

Each dataset cache retains at most 64 snapshots and 64 MiB of estimated retained data, evicting least-recently-used entries to satisfy both limits. The estimate counts UTF-16 strings, property names and conservative per-object/property overhead; it is a retention budget, not an exact heap measurement. Oversized snapshots are returned normally without retention. Evicted datasets are read fresh on their next request after the usual publication pointer check. Tests may supply smaller limits (including zero to disable retention); limits cannot exceed the defaults. Replacement, revocation and failed reads release the previous entry, so inactive deleted/replaced imports cannot accumulate without bound.

Profile photos have an independent live publication. `photoFor` is applied to returned summaries and details after compilation, so photo changes, revocation and different photo providers cannot inherit stale cached URLs.
The controller maps null to HTTP404; `PublicPeopleReaderError.status===503` maps to unavailable.
Requests must be plain data objects. Invalid request shapes, signals, queries, IDs and cursor structures/scopes return a data-free status400 error before backend access or unknown-profile handling.
No HTTP route is implemented by this module; the standalone runtime maps it to anonymous `/network`, `/people`, `/people/:id`, `/api/people` and `/api/people/:id`.

Reader search is plain normalized name/headline/company term matching. Member Everyone AI search uses `createSharedPeopleSearch()` on top of the same published snapshot, while owner-private AI search remains in the owner-scoped controller.
The default list order without a query sorts by Unicode NFKC/lowercase name and binary ID as tie-breaker, independent of provider order and machine locale; queried default lists use lexical relevance. Explicit list name ordering uses an English collator with base sensitivity, numeric comparison and ignored punctuation, then an ID tie-breaker, before pagination. Profile connection ordering is owned by [connection browsing](connection-browsing.md).
Pages contain at most100rows, default50.
Cursors bind offset to normalized query/profile scope and publication revision, and contain no profile names or emails.
A stale publication cursor returns503 so the caller can restart against the new revision; a cursor from another query/profile is invalid400.
The backend must supply one coherent complete snapshot for that revision; this module cannot make unrelated backend reads transactional.

Synthetic tests exercise unavailable/default behavior, whitelist output, deterministic pagination/search, connection pages from both ends, member/legacy/shadow presence, malformed/oversized snapshots, immutable viewer propagation, aborts/timeouts and invalid client input.
These fixtures are confined to tests and are never production fallback data.
Real Noos publication/readback and standalone route integration are covered by the shared People beta work; Next.js route injection remains separate.

## Historical membership

The shared projection keeps current `members` separate from `legacyMembers`. The standalone provider reads historical evidence only from the pinned production manifest and source digests in `mcp-server/legacy-account-manifest.mjs`, requiring the matching manifest node and non-revoked account rows with neither test nor self-asserted markers. The projection fails closed for more than 81 rows or an unknown profile ID; absence of a historical provider means an empty historical set. No name, extracted contact detail or self-assertion supplies this evidence.

Presence resolves in order: `member` (**On Unlinked**, current membership from the [member identity sources](signup-profile-lookup.md#public-projection-and-export-precedence)), then `legacy` (**Legacy member · awaiting claim**, verified recovered account), otherwise `shadow` (**Not on Unlinked**, imported contact). Historical display records create no owners, sessions, login permissions or member messaging. A legacy profile offers **Sign in to reclaim it** at `/legacy-account`, which still requires verified sign-in and explicit confirmation; its existing profile and connections remain available.

Historical IDs follow [profile merge decisions](profile-decisions.md), including aliases, without becoming current members. Both membership sets contribute to the snapshot revision, so claim or revocation changes invalidate filtered cursors after the existing freshness windows above. Regression coverage: `tests/legacy-membership.test.mjs`; published filter parity: `tests/public-presence-contract.test.mjs`.

## Enrichment status

Summaries and details expose `enrichmentStatus` independently of membership
(`presence`) and visible content depth (`detailLevel`). `enriched` means there
is current published enrichment evidence in the composed index; `not_recorded`
means there is no such evidence, not that the person was never enriched. A
source without a status yields `unknown`. Evidence includes matching published
ID-keyed or LinkedIn-keyed enrichment, including matches from every linked owner
upload even when an older overlay is discarded. Evidence follows profile merges
and does not imply that enrichment text was applied. The list accepts these three values as an `enrichmentStatus` filter,
which is bound into the cursor; invalid values are rejected. Contact lookup
uses `unknown` when public evidence is unavailable. See the
[agent API](agent-api.md) for the exposed endpoints.

## Enrichment shards

Operator enrichment comes from `curated-enrichment-v1` plus the bulk shard datasets
`curated-enrichment-exa-1` through `-exa-4`. The Noos public store caps each published snapshot at 8 MiB,
so bulk data is split across shards. The runtime index reads all five datasets (`ENRICHMENT_DATASETS`).
It applies the shards first and `curated-enrichment-v1` last, so for the same legacy id the
per-person reads in `curated-enrichment-v1` win.
ID-keyed rows do not override confirmed or historical members' own profile text,
including when a member absorbs an imported copy.
Publish a shard with `publish-enrichment-people.mjs <rows> <root> --dataset=curated-enrichment-exa-N [--execute]`.
Roll it back with `UnlinkedPublicPeopleStore.revoke(<dataset>, <revision>)`.
Imported profiles without a legacy id are enriched by LinkedIn address instead, from
the LinkedIn-keyed datasets, filling empty fields only; see
[imported profile enrichment](imported-profile-enrichment.md).

## Cold-start warm-up (2026-11-06)

On 2026-11-06 the People index was unavailable for about 7 minutes after a restart (People pages returned 503 from 10:16:02Z to 10:23:13Z). The startup warm-up gives up after 8 s and the build continues in the background, so the claim above that the first request never pays the rebuild holds only once a build exists. The main cold cost is re-reading every import's assertions: the detail cache lives in memory. `createMemberPublicIndex` now prefetches missing import details four imports at a time (`IMPORT_PREFETCH`) before its sequential loop. The loop still re-validates every source and is the only thing that uses the results, so a source that changed is still rejected. On a synthetic test this made the cold build about 2.8× faster. Two smaller fixes: overlay lookups use an id → position map, and edge de-duplication keys use string concatenation instead of `JSON.stringify`. Still open: the per-revision compile and per-build loops run on the main thread and stall every request while they run. Moving them to a worker thread is the next step.


## Index worker (2026-11-06)

The compiled index now lives in one worker thread. Each compile used to block the main event loop: a synthetic snapshot at the index caps took 1.6 s in one synchronous block, and a recompile kept two full indexes in the main heap. In production, `runtime_health` measured loop stalls up to 24 s.

- **Who uses it.** `private-pilot.mjs` installs `createPublicIndexHost()` (`src/utils/public-people/index-host.mjs`) at startup. While a host is installed, every reader whose source identifies content by revision (`revisionIdentifiesContent`) keeps only a small descriptor on the main thread. Sources without that guarantee, and code that never installs a host (most tests), compile in-process exactly as before.
- **How a snapshot reaches the worker.** It is sent only when its compile key (revision plus limits) is new to the worker. It goes in chunks of 2,000 rows with an event-loop turn between chunks. The worker compiles with the same `reader.mjs` code and answers every reader method. The main thread still reads, validates and owns the published snapshot, so revocation, freshness, cursor scopes, `reuse` pinning and connection-privacy invalidation behave as before. Every call re-reads the source first.
- **Revisions kept.** The worker keeps the newest index per source, plus the previous one for 60 s, so a request-scoped (`reuse: true`) reader can finish paging through the revision it started on. A call for an index the worker no longer holds is answered `stale`; the reader then re-reads the source, installs it and retries once.
- **Photos.** Photos have their own live publication, so they are resolved on the main thread for returned rows. Returned rows are frozen, like compiled rows.
- **Failures.** If the worker dies (for example on its own heap limit), only it dies. Pending calls fail as unavailable, and the next read starts a new worker, after a 5 s backoff, and installs again. If three workers in a row fail before completing any install, the host disables itself and readers compile in-process.
- **Configuration.** `UNLINKED_PUBLIC_INDEX_WORKER=off` compiles in-process. `UNLINKED_PUBLIC_INDEX_WORKER_HEAP_MB` (≥ 256) caps the worker's old-generation heap. **It takes effect only when the process sets no `--max-old-space-size`.** A process-level flag (on the CLI or in `NODE_OPTIONS`) sets every isolate's old-space limit, the worker's included, and `resourceLimits.maxOldGenerationSizeMb` is then ignored in either direction. Measured on Node 22: with a 768 flag the worker died at ~729 MB under a 1024 cap; with a 1024 flag it died at ~957–967 MB under 512 or 768 caps. The host writes `unlinked_public_index_worker_heap_cap_ignored` once when both are set. With the flag, each thread gets its own heap of the flag's size. Both heaps count against the container limit, so size the flag for the larger need (the worker's) and check that main plus worker fit. An exceeded limit fails only the worker (`ERR_WORKER_OUT_OF_MEMORY`), and the worker is restarted.
- **Memory.** After compiling, the worker keeps only the compiled index and drops its copy of the raw rows. The main thread keeps the published snapshot, which it needed anyway, and no compiled index. `runtime_health` rows report `index_worker_heap_used_mb`, `index_worker_heap_limit_mb`, `index_worker_restarts` and `index_worker_installs`.
- **Process lifetime.** The worker is referenced only while a reply is pending, so an idle index never keeps the process alive. A worker never installs a host of its own.
- **Tests.** `npm run test:index-worker` runs the reader suites with the worker installed. `tests/public-index-worker.test.mjs` covers method-by-method equivalence with in-process results, revision pinning, worker loss and disablement.

Still on the main thread: assembling a changed member snapshot (`createMemberPublicIndex`) and its validation pass in each reader call.

## No-change rebuilds (2026-11-06)

`createMemberPublicIndex` rebuilds on its freshness interval: every 45 s through the warm keeper, and whenever a read comes after the fresh window. A rebuild used to reassemble the whole snapshot even when nothing had changed, which allocated about 120 MB per rebuild at the index caps.

Now a due rebuild first computes a fingerprint of everything the build reads:

- the legacy and enrichment revisions;
- the discovered imports, plus each import's live resource and legacy link;
- signups and connection-privacy choices, including how unresolved owners resolve to legacy profiles;
- invites, members, legacy members and decisions.

If this fingerprint equals the one read before the kept build, the kept snapshot is reused as the same object, with nothing assembled. The fingerprint is always read before the build it describes. A change that races a rebuild can therefore cause one extra rebuild, never a stale reuse.

A changed source still rebuilds, and the build reuses the legacy snapshot and import list the fingerprint read, so its read count is the same as before. The first due rebuild after a cold start still builds, because there is no fingerprint to compare yet. `invalidate()` drops the kept build, so a connection-privacy change still forces a full rebuild on the next read. A fingerprint read that fails falls back to a full build, which fails closed as before.

The fingerprint leaves out one input: `preferSurvivor`'s live handle state. It does not change the revision, and readers already pin compiled indexes to the revision.

### Steady-state dataset reads and recompile memory (2026-11-06, v0.6.92)

- **The leftover stalls.** After 0.6.91, `runtime_health` still showed a main-thread block of about 1 s nearly every minute, with no index recompiles in that time.
- **The cause.** The no-change rebuild check read whole datasets: the recovered legacy dataset (~40 MB of JSON at production shape) and the enrichment shards. A dataset above the 64 MiB retained-size estimate is never cached, so each check fetched, parsed, hashed and validated it again, every 20–45 s.
- **Fix: pointers only.** The fingerprint now uses each dataset's live published pointer (`revision` and `digest`, from `publicPeople.revisionOf`) and the legacy pointer (`readLegacyRevision`). A no-change check reads no dataset. A build still reads them when something changed.
- **Recompiling under memory pressure.** A worker whose heap is above 45% of its cap releases the old index for a source when a new revision's install begins, instead of holding two compiled indexes. Calls for the old revision then answer `stale`, and readers install the new one and retry. As after any revision change, a cursor from the old revision fails closed. Below 45%, the old index is kept as before.
- **Heap limit reporting (corrected in v0.6.93).** `index_worker_heap_limit_mb` is V8's own effective limit. 0.6.92 reported the smaller of that and the configured cap, on the mistaken belief that the cap applied.

### Cold-start slices (2026-11-06, v0.6.94)

After 0.6.93, the stall profiles showed what blocks the main thread in the cold window after a deploy or restart. The worst windows reached 3.1–3.8 s:

- **The company-facts cold read.** Per-chunk hashing and parsing, validation of every row, the full row JSON serialized twice, and then a second validation and the index build.
- **Member projection's `decide()`.** Identity references for every profile, `linkedinIdentityMerges`, two `applyProfileDecisions` passes over every profile and edge, the URL-identity passes in `readDecisions`, and `build()`'s own loops over every profile and edge.

These are now written once as generators (`src/utils/cooperative.mjs`). `runSync` drives a generator to completion for existing synchronous callers, such as the publisher and tests. `runAsync` gives the event loop a turn every ~15 ms on the cold paths. The steps, results and exceptions are the same either way.

Pure savings with the same results:

- the store computes the company digest once, incrementally (`hashRowsJson` equals `sha256(JSON.stringify(rows))`), instead of serializing all rows twice;
- rows the store already validated are not validated again by the facts lookup;
- the per-profile LinkedIn reference is not computed when there is no LinkedIn-keyed enrichment to match.

Bench on the M5 (`bench-cold.mjs`; 50k company rows; 100k profiles, 400k edges, 3,000 decisions, same-LinkedIn merging):

| Path | Longest main-thread block, before | After | Wall time, before | After |
|---|---|---|---|---|
| Company facts cold read | 350 ms | 26 ms | 355 ms | 234 ms |
| Member cold build | 686 ms | 31 ms | 691 ms | 581 ms |
