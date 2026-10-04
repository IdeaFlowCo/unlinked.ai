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
Detail includes optional about text, experience, education, skills, public connection summaries and an optional next-connections cursor.
See the schema for exact field names and bounds.
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
