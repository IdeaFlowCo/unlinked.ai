# Shared People beta

Everyone browsing uses only the published professional Noos projection, never private owner resources or synthetic fallbacks.
Anonymous GET `/network`, `/people`, `/people/:id`, `/api/people?q=&cursor=`, and `/api/people/:id` expose only safe profile DTOs and provenanced directed connection edges.
Public reads are bounded to two concurrent requests and120 requests per process per60 seconds; invalid input is400, unavailable/incomplete publication is503, and a missing profile in a complete publication is404.

The offline publisher accepts only the checksummed recovered DB backup (16,296 profiles and16,603 directed edges), retains a private provenance manifest, and never creates an account binding.
Original auth/storage backup and81-account email evidence remain separate; verified provider email linking requires a later explicit guarded identity operation.

A member with no imports can POST `/search-account` with query, CSRF and `scope=everyone`; owner-private search remains `scope=own`.
Everyone retrieval evaluates all public profiles lexically and passes at most200 matching professional candidates to OpenAI for ranking.
The response reports total considered/candidate counts; it is retrieval plus AI ranking, with no claim that all profiles were sent to the model.
Model input excludes emails, phones, raw source archives and private notes.
A changed/revoked public publication is rechecked after model processing and denies the result.

New production upload actions record `public-professional-archive-openai-v2` alongside existing retention/AI consent.
Old private-v1 imports and explicit synthetic mode remain excluded from shared publication.
The trusted process discovers only active bound owner publications, then reads each new source through the existing owner-authorized immutable reader before publishing a separate professional projection.
Every shared read rejoins the live source/active owner, so deleted or revoked imports cannot remain discoverable through retained public chunks.
No public route exposes generic graph access.

New account grants include `unlinked_search_everyone` and `unlinked_search_network`; old single-tool grants keep their exact original scope.
Stored grant and owner binding are checked before and after model work; revocation remains durable.
No grant exposes raw archives or identity/provider credentials.

The first complete shared-snapshot bound is20,000 profiles/100,000 edges; the recovered seed uses16,296 profiles.
Exceeding the bound fails explicitly rather than truncating; this is a real scaling limit for subsequent member additions, separate from the owner-private parser/import limit of100,000 records.
The private source ZIP and all accepted owner observations remain intact.
A scalable paged public projection is a follow-up before larger shared unions can be claimed complete.

Source proof uses HTTP anonymous/no-import sessions, exact-owner CSRF and MCP clients, private-field exclusion, tombstone/owner revocation, and the Noos51 real graph CI publication fence.
Live migration/search readiness requires guarded app+Noos source rollout, the actual recovered backup publication/readback and real API/model/MCP receipts.
