# Public directory reader integration

`/people` and `/people/[id]` are UI-ready public routes. In the standalone runtime, they are backed by the published professional People reader; in the historical Next.js source app they still show an unavailable state rather than fictional results.
The paused legacy Supabase `/profiles` routes are unchanged.

`src/components/public-directory/contract.ts` owns the runtime-validated DTO and injectable `PublicDirectoryReader` interface.
`createDirectory(reader)` exposes bounded list and profile reads; its default instance has no reader.
The runtime/legacy owner must supply the public data reader and enforce publication eligibility before this interface receives any records.
Private imported contact rows must not become public merely because this UI exists.
No endpoint, access token, graph mutation or legacy migration is configured by this slice.

The list receives `{query,cursor?}` and returns `{profiles,nextCursor?}`.
Each summary has `id`, `name`, optional `headline` and optional `location`.
The profile receives `{id,cursor?}` and returns `{profile}` or `null` for an unknown or unpublished profile.
The detail fields and bounds are defined by `detailSchema` in `src/components/public-directory/contract.ts`; professional link sourcing and privacy are owned by [profile details](profile-details.md).
Unknown fields are stripped and malformed output is unavailable; transport failure is never displayed as an empty network.

The runtime owner agreed this DTO and wires it through the standalone public People projection.
Publication eligibility must be verified before records, counts or ranking reach the UI.
The Next.js exported directory instance remains a historical/local reference until a live reader is injected there.
The existing open-beta login, full-archive export guidance and agent setup bridge remain in place.

`node --test tests/public-directory.test.mjs` exercises the injectable read contract without a live graph.
Those synthetic test fixtures are not product data or proof of legacy migration.

## Search links for web assistants

The [README search-link instructions](../README.md#agent--mcp-surface) cover common usage. `/search-public` renders compact HTML from the published professional People index, with ordinary profile links and next-page cursors. It requires no sign-in, connector, JavaScript or external reader service, and never calls a model or searches a private network. ChatGPT web-fetch availability must be verified separately; a successful HTTP request alone does not prove ChatGPT can read it.

Query parameters, bounds and page size are defined by `/search-public` in [the OpenAPI schema](../public/openapi.json). Matching semantics are owned by [Shared People beta](shared-people-beta.md). Queries, names, headlines and profile URLs are HTML-escaped. No private account chrome or contact details enter the document, even for signed-in visitors. Status codes and shared public-read capacity are owned by [Shared People beta](shared-people-beta.md). Every request revalidates publication; responses remain no-store.

GET and HEAD are supported for `/search-public`, `/people`, `/people/:id`, `/people/:id/connections`, `/api/people`, `/api/people/:id`, `/companies/:name`, `/api/companies/:name`, and anonymous `/network`. HEAD preserves the public route status and content type without a body; the landing-page HEAD returns 200 without rendering or starting sign-in. Private routes, sign-in and state-changing actions are not added to HEAD support. Regression coverage: `tests/public-web-search.test.mjs`.

### Alternate public transport

The Next.js app exposes GET/HEAD `/search-public` at `https://unlinked-ideaflowco.vercel.app/search-public`. This is an experimental alternate transport, not proof of ordinary ChatGPT access. It fetches only the fixed canonical `/search-public` endpoint anonymously on every request; it never uses the historical Supabase backend, forwards caller cookies or authorization, follows upstream redirects, calls a model, or stores a second publication. Canonical profile links remain on `www.unlinked.ai`; search and pagination stay on the alternate transport.

`src/utils/public-search-relay.mjs` limits requests to the query parameters and bounds in [the OpenAPI schema](../public/openapi.json), rejects unknown or repeated parameters, and requires a nonempty base64url cursor when supplied. It caps upstream HTML bodies at 256 KiB with a 10-second upstream deadline. Client cancellation also aborts the fetch. All responses disable browser/CDN caching. Unavailable, revoked, non-HTML and oversized responses fail closed; upstream cookies, private error bodies and redirect locations are never relayed. Upstream 400, 429 and 503 statuses are preserved; other upstream failures become 503. A 429 preserves Retry-After only when it is a safe nonnegative integer or a canonical HTTP date. Tests execute the relay and middleware gate: `tests/public-search-relay.test.mjs` and `tests/middleware-gate.test.mjs`.

The October 5 investigation observed no inbound origin HTTPS packets during failed reader calls, followed by a successful separate HTTP control. Existing Vercel-hosted discovery also returned HTTP 200 but was rejected by the reader. These observations suggest a rejection before the origin; they do not establish a permanent domain ban or its cause. The original ordinary-chat request remains the acceptance test, and neither an HTTP 200 nor a green CI check establishes it.
