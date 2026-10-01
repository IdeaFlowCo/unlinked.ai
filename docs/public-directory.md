# Public directory reader integration

`/people` and `/people/[id]` are UI-ready public routes, deliberately absent from navigation until a real public reader is integrated.
They currently show an unavailable state, not an empty directory or fictional results.
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

The runtime owner agreed this DTO, but confirms no public reader/projection endpoint exists.
Publication eligibility must be verified before records, counts or ranking reach the UI.
The concrete service URL, publication enforcement, stable identifier and cursor semantics remain the integration handoff.
Once agreed and backed by real public data, wire the exported directory instance to that reader, verify actual public profiles and pagination, and only then add People to navigation.
The existing open-beta login, full-archive export guidance and agent setup bridge remain in place.

`node --test tests/public-directory.test.mjs` exercises the injectable read contract without a live graph.
Those synthetic test fixtures are not product data or proof of legacy migration.
