# Private Noos staging receipt

This is an unmounted, synthetic-only adapter slice stacked on draft PR11.
It requires a separately isolated Noos follow-up stacked on draft PR45.
Neither production authentication nor private import is activated by importing these factories.
The public archive entry continues to show its availability gate.

`src/utils/private-import/noos-adapter.mjs` sends real parsed jobs, immutable per-revision receipts, source observations and assertions to Noos operational HTTP APIs.
The trusted caller supplies the verified legacy Unlinked owner ID and an audience-bound operational access token.
Archive URLs, email fields and contact subjects never identify the principal.
The identity seam remains verified issuer + opaque subject -> established account -> historical owner mapping, with account choice and historical provider unknowns preserved.

The Noos follow-up verifies RS256 access tokens with exact issuer and single audience, `at+jwt`/access purpose, at most fifteen-minute lifetime, namespace/operation scopes, trusted subject mapping and revocation callback.
Those factories remain unmounted; no provider registration, production cookie adapter, anonymous identity header or default secret is added.
Disposable signed identities prove cryptographic verification and authorization, not a real Ideaflow login or delegated provider consent.

## Publication and capacity

Original archive/source bytes upload through a separately authenticated private asset API.
Uploaded/parsing job updates each atomically add an immutable revision receipt.
Final publication atomically commits the current job, its receipt, source receipts and assertions.
Source/assertion IDs retain the PR11 owner/archive/path/hash/row derivation and always write revision one with exact replay.
A failed transaction creates no assertions or final publication.
A lost successful commit response is resolved by reading the exact terminal job on retry.
Local duplicate calls serialize; cross-process contention is fenced by Noos revision CAS and may require a caller retry.

This first adapter supports **500 assertions**, at most 600 publication resources, 64 KiB per resource, and 32 MiB per Noos batch.
The parser still accepts its larger 100,000-record bounded input.
Larger or oversized publication manifests return a durable `failed` / `unsupported_private_publication` receipt before committing observations.
The archive remains retained for recovery; no subset is falsely published as a successful import.
Support-limit failures need a later publication-version/retry policy before a higher capacity adapter can restage them.
Indexed count stays zero and `indexGate` is `ai_search_not_connected`; parsed observations are not an AI index.

A larger-archive follow-up must journal bounded immutable assertion batches, fence the active writer, verify every batch digest and count, and atomically publish one final manifest referencing the complete journal.
Tests must interrupt every boundary, replay lost responses, race duplicate writers and tombstones, and prove tools never read an incomplete or deleted journal.
Receipt history remains immutable even when a new publication version is staged.

## Private asset decision

The archive limit is 20 MiB; source files are at most 8 MiB and total decoded ZIP members at most 40 MiB.
No ZIP paths are extracted to disk.
No binary archive chunks are stored as graph properties.
The Noos `PrivateAssets` interface permits private object storage later; only an explicit disposable filesystem staging backend exists now.
It uses private owner-hashed directories and hash-named immutable blobs, modes 700/600, no-follow reads, atomic exclusive writes and digest verification.
Asset reads first verify the immutable historical owner binding, then read one bounded blob; they do not fan out over graph nodes.
The configured root and its ancestors must be controlled by the isolated service operator.

Publication rollback is a Noos tombstone; original assets, receipt history, sources and assertions remain private for recovery.
Tools deny tombstoned publications before and after loading rows.
Raw archive recovery is a separate owner-only audience and never an agent grant.
Physical deletion/retention, object storage, fsync/backup durability, coordinated blob/graph backup and restore rehearsal remain production cutover gates.
The staging proof cleans up only its owned disposable root/container; it does not exercise a production backup or historical migration rollback.

## Hosted read tool and setup

`mcp-server/private-hosted.mjs` exposes an opt-in Streamable HTTP MCP factory with only `unlinked_read_import`.
A trusted grant resolver must verify a **separate tool audience**, owner binding, explicit import allowlist, tool allowlist, expiry and current revocation.
An operational `unlinked:read` bearer is never handed to the hosted agent.
Every invocation checks the live publication and rechecks it after row reads; credentials, raw archive APIs and arbitrary assertion IDs are absent from the tool interface.
Host/Origin validation and no-store responses protect the staging surface.

The separate authenticated setup factory returns a downloadable client configuration for exactly one live owner-approved import in one POST action.
It places a short-lived scoped bearer only in the configuration body, never a query string or shareable setup URL.
It requires a trusted issuer callback; production setup remains unavailable until granular consent, audience registration, client binding, revocation and the verified account session adapter are proven.
The disposable test uses real signed synthetic tokens and an actual MCP SDK client over loopback; it does not expose a hosted production link.

## Executable evidence

Run focused parser/scope checks with `node --test tests/private-import.test.mjs tests/private-scoped-reader.test.mjs` after locked dependency installation in the web app and `mcp-server`.
For the cross-repo receipt, set `UNLINKED_NOOS_TEST_CHECKOUT` to the isolated Noos follow-up checkout, `NOOS_OPERATIONAL_EXTRA_TEST` to this repo's absolute `tests/private-noos-integration.test.mjs` path, and invoke that checkout's `node scripts/test-operational.mjs`.
Use external SSD paths for `UNLINKED_NOOS_RECEIPT`, `NOOS_SIGNED_TEST_EVIDENCE` and temporary storage.
The Noos runner provisions one owned 1 GiB capped disposable Neo4j container, serializes tests, and removes it in `finally`.
Do not supply production Neo4j URLs or user data.

The receipt proves actual ZIP parsing, private Noos/assets persistence, signed mapped-owner authorization, two-owner denial, publication/replay/interruption, explicit 501-row rejection, setup download and an actual scoped MCP invocation with revoked/tombstoned/raw-audience denial.
It does not prove real provider login/consent, production routing, AI search, large-archive migration, historical provider completeness, paid activation or restore/cutover readiness.
OpenAI/provider-unspecified AI API code and credential inspection remain held pending the credential choice.
