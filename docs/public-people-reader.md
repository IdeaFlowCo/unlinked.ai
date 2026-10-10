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

Default maxima are 20,000 profiles, 100,000 directed public edges, 16 MiB accepted DTO text and 8 seconds per snapshot call.
The standalone runtime warms the process-local public index before opening its HTTP listener only when the source sets `revisionIdentifiesContent: true`; absent or non-content-addressed sources are skipped. It uses an anonymous reader with the default size limits and an eight-second snapshot-read timeout, moving cold compilation to startup without a synthetic viewer or model call. Warmup is best effort: unavailable publication does not prevent account routes from starting. Every subsequent request still reads the live source and validates publication and owner visibility; warmup never authorizes stale rows. Startup ordering and compilation reuse are covered by `tests/public-people-warmup.test.mjs`.
The provider must bound its own fetch/serialization before returning; these maxima are not permission to read private operational rows.
All entity arrays must have their own data entries at every index. On compilation, the factory validates all rows before computing counts/order, never truncates an oversized snapshot, and rejects duplicate IDs/edges or dangling endpoints. Reusing a compiled index relies on the trusted source's content-addressed revision guarantee below.
Empty published snapshots are valid, distinguishable from unavailable publication.

Each published profile has `id`, `name`, optional `headline`, `location`, `about`, optional search-only `company`, and arrays `positions`, `education`, `skills`.
Position fields are `title`, `company`, optional `startDate`, `endDate`, `description`.
Education fields are `institution`, optional `degree`, `startDate`, `endDate`.
Only these DTO fields are copied; email, phone, raw imports, notes, auth metadata and search-only company are never returned as profile properties.
The publication provider must separately sanitize the contents of public biography/professional text, since a whitelist cannot prove free text contains no private information.
Connections are `{fromId,toId}` and remain directed; reciprocal relationships and mutual status are not inferred.

`reader.list({query?,mode?,presence?,sort?,includeTotal?,cursor?,signal?})` returns `{profiles:[{id,name,headline?,location?}],nextCursor?}` with `match` and `total` for a nonempty query, and `total` for a presence filter or explicit `includeTotal: true`. `exclude` (array of published ids, merged ids resolved) leaves those people out after ranking and before paging and totals; the exclusion set is bound into the cursor scope.
`reader.profile({id,cursor,signal?})` returns `{profile:{...summary,about?,positions,education,skills,connections,nextConnectionsCursor?}}`, or null for an unknown/unpublished profile in an otherwise valid published snapshot.
A profile's connections are its edges from both ends: an edge is stored only from the person whose export listed it, and an edge recorded by both people appears once.
When the snapshot carries `members` (profile IDs supplied by the shared index), every summary and detail adds `presence: 'member'|'shadow'` and `connectionCount` (both directions). See [signup source precedence](signup-profile-lookup.md#public-projection-and-export-precedence) for member identity sources. Snapshots without `members` add neither field. A member ID missing from the profiles is a malformed snapshot (503).
The list accepts `presence: 'member'|'shadow'`; the filter is part of the cursor scope, so a cursor never pages a different filter. A snapshot without `members` matches neither filter; any other value is a 400. List `sort` accepts `best` (default), `name` and `name-desc`; other values are a 400. Nondefault sorts also bind into cursor scope. The `/api/people` route keeps default ordering and does not opt into unfiltered totals; existing agent defaults are unchanged. Browser use is owned by [People filtering and ordering](network-controls.md).
`reader.lookup({ids,signal?})` takes at most 1000 IDs and returns a `Map` of the summaries that are published, in request order; unknown IDs are omitted.
Overlapping reads without their own signal share one snapshot build. A request-scoped reader may use `reuse: true` to keep one coherent snapshot for that request. Across requests, compiled public indexes are reused only when the trusted source sets `revisionIdentifiesContent: true` and the revision and configured limits match; every request still reads the source and validates its publication envelope. Signed-in viewer-scoped sources never use the shared cache. Returned cached rows are frozen.

The standalone composition wraps immutable public datasets with `cachePublicPeopleReads`: every read checks the current published revision and digest in Neo4j, reusing validated chunks only while both match. Changed, revoked, failed or racing pointers trigger a full store read. The member projection checks current owner/source authorization and includes every content input in its revision. No member page or browser response is cached.

The member projection additionally keeps its last successful build for a bounded freshness window (`UNLINKED_PUBLIC_INDEX_FRESH_MS`, default 20000, 0–300000; 0 disables keeping). A page view inside the window is served from the kept build without reading any source, so a publication, revocation, decision or claim becomes visible to anonymous and member pages within the window plus one build rather than on the very next request. An expired window triggers a full build with every live owner/source check above; a failed build serves nothing stale, and a build that finds no legacy publication drops the kept index immediately.

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

Synthetic tests exercise unavailable/default behavior, whitelist output, deterministic pagination/search, connection pages from both ends, member/shadow presence, malformed/oversized snapshots, immutable viewer propagation, aborts/timeouts and invalid client input.
These fixtures are confined to tests and are never production fallback data.
Real Noos publication/readback and standalone route integration are covered by the shared People beta work; Next.js route injection remains separate.
