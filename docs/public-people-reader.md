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

Default maxima are20,000profiles,100,000directed public edges,16MiB accepted DTO text and3seconds per snapshot call.
The provider must bound its own fetch/serialization before returning; these maxima are not permission to read private operational rows.
All entity arrays must have their own data entries at every index. The factory validates all rows before computing counts/order, never truncates an oversized snapshot, and rejects duplicate IDs/edges or dangling endpoints.
Empty published snapshots are valid, distinguishable from unavailable publication.

Each published profile has `id`, `name`, optional `headline`, `location`, `about`, optional search-only `company`, and arrays `positions`, `education`, `skills`.
Position fields are `title`, `company`, optional `startDate`, `endDate`, `description`.
Education fields are `institution`, optional `degree`, `startDate`, `endDate`.
Only these DTO fields are copied; email, phone, raw imports, notes, auth metadata and search-only company are never returned as profile properties.
The publication provider must separately sanitize the contents of public biography/professional text, since a whitelist cannot prove free text contains no private information.
Connections are `{fromId,toId}` and remain directed; reciprocal relationships and mutual status are not inferred.

`reader.list({query,cursor,signal?})` returns `{profiles:[{id,name,headline?,location?}],nextCursor?}`.
`reader.profile({id,cursor,signal?})` returns `{profile:{...summary,about?,positions,education,skills,connections,nextConnectionsCursor?}}`, or null for an unknown/unpublished profile in an otherwise valid published snapshot.
The controller maps null to HTTP404; `PublicPeopleReaderError.status===503` maps to unavailable.
Requests must be plain data objects. Invalid request shapes, signals, queries, IDs and cursor structures/scopes return a data-free status400 error before backend access or unknown-profile handling.
No HTTP route is implemented by this module.

Search is plain normalized name/company term matching; AI search remains in the owner-scoped controller.
Profiles and connection pages sort by Unicode NFKC/lowercase name and binary ID as tie-breaker, independent of provider order and machine locale.
Pages contain at most100rows, default50.
Cursors bind offset to normalized query/profile scope and publication revision, and contain no profile names or emails.
A stale publication cursor returns503 so the caller can restart against the new revision; a cursor from another query/profile is invalid400.
The backend must supply one coherent complete snapshot for that revision; this module cannot make unrelated backend reads transactional.

Synthetic tests exercise unavailable/default behavior, whitelist output, deterministic pagination/search, directed connection pages, malformed/oversized snapshots, immutable viewer propagation, aborts/timeouts and invalid client input.
These fixtures are confined to tests and are never production fallback data.
Real Noos publication/readback and route integration remain the runtime owner's work.
