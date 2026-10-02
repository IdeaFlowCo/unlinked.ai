# Shared People beta

Everyone browsing uses only the published professional Noos projection, never private owner resources or synthetic fallbacks.
Anonymous GET `/network`, `/people`, `/people/:id`, `/api/people?q=&cursor=`, and `/api/people/:id` expose only safe profile DTOs and provenanced directed connection edges.
Public reads are bounded to two concurrent requests and 120 requests per process per 60 seconds; invalid input is 400, unavailable/incomplete publication is 503, and a missing profile in a complete publication is 404.

The offline publisher accepts only the checksummed recovered DB backup (16,296 profiles and 16,603 directed edges), retains a private provenance manifest, and never creates an account binding.
Original auth/storage backup and 81-account email evidence remain separate; the recovered-account operator seeds only a hash-only 81-row manifest after the exact public source is published.
Signed Ideaflow email evidence can produce a one-time browser confirmation for the matching legacy profile, but typed/uploaded email and profile URLs never bind a member.

A member with no imports can POST `/search-account` with query, CSRF and `scope=everyone`; owner-private search remains `scope=own`.
Everyone retrieval evaluates all public profiles lexically and passes at most 200 matching professional candidates to OpenAI for ranking.
The response reports total considered/candidate counts; it is retrieval plus AI ranking, with no claim that all profiles were sent to the model.
Model input excludes emails, phones, raw source archives and private notes.
Owner-network matches also omit contact emails and phones from returned fields; retained originals remain private recovery data.
A changed/revoked public publication is rechecked after model processing and denies the result.

New production upload actions record `public-professional-archive-openai-v2` alongside existing retention/AI consent.
Old private-v1 imports and explicit synthetic mode remain excluded from shared publication.
The trusted process discovers only active bound owner publications, then reads each new source through the existing owner-authorized immutable reader before publishing a separate professional projection.
Every shared read rejoins the live source/active owner, so deleted or revoked imports cannot remain discoverable through retained public chunks.
No public route exposes generic graph access.
When a confirmed member also has a recovered legacy profile, shared publication reuses that existing legacy profile ID and overlays the member's uploaded professional profile only while the link and source are still live.
Legacy-directed source edges are canonicalized with member upload edges so revoking the link removes the overlay and returns the recovered public profile.

New account grants include `unlinked_search_everyone` and `unlinked_search_network`; `unlinked_search_network` degree/cursor mode and signed `GET /api/my-connections` read recorded one/two-hop paths from the current complete public snapshot only after an explicitly confirmed recovered-profile anchor. Old single-tool grants keep their exact original scope.
Stored grant and owner binding are checked before and after model work; revocation remains durable.
No grant exposes raw archives, recovered original files or identity/provider credentials.

The first complete shared-snapshot bound is 20,000 profiles/100,000 edges; the recovered seed uses 16,296 profiles.
Exceeding the bound fails explicitly rather than truncating; this is a real scaling limit for subsequent member additions, separate from the owner-private parser/import limit of 100,000 records.
The private source ZIP and all accepted owner observations remain intact.
A scalable paged public projection is a follow-up before larger shared unions can be claimed complete.

Source proof uses HTTP anonymous/no-import sessions, exact-owner CSRF and MCP clients, private-field exclusion, tombstone/owner revocation, and the Noos51 real graph CI publication fence.
Live migration/search readiness requires guarded app+Noos source rollout, the actual recovered backup publication/readback and real API/model/MCP receipts.
