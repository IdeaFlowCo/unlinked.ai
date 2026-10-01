# Lightweight onboarding views

`private-onboarding-views.mjs` is an unwired renderer module, not a released onboarding flow.
Its indigo styling and journey follow the accepted onboarding and app storyboards.
The runtime owner must integrate it without changing authorization boundaries.

Each renderer returns `{title, content}` for the server page wrapper.
The wrapper should place its title inside the journey region after the shared header.
Content contains scoped styles; the wrapper must apply its actual style CSP policy.
All raw DTO values are HTML escaped, and contact links allow only HTTPS LinkedIn URLs.
Contacts and profiles must already be authorized by the caller.
No private contact is presented as a public member or mutual connection.

Production upload uses native multipart `/upload` with `csrf` and `archive` only.
The server must record upload consent itself before accepting this renderer.
Synthetic rehearsal mode explicitly adds the required `syntheticConsent` field.
`uploadProgressScript()` is an optional enhancement; wire it separately with the actual CSP nonce.
It preserves native form submission and has no simulated completion timer.

Every signed renderer accepts optional `importJob` containing `id`, `status`, `profileReady`, `processed`, `total`, `statusUrl`, and optional `errorMessage`.
Statuses are `uploaded`, `parsing`, `indexing`, `indexed`, `partial`, and `failed`.
Processed counts represent durably staged records, not globally searchable rows.
The header renders server-provided progress across routes; this module does not poll an absent API.
The runtime owner must implement durable job continuation, authenticated same-owner status, and early own-profile staging before enabling those states.
`total` may remain null until parsing knows the count.
Only final `indexed` status reports ready.

Profile editing, shared-member discovery, friends, permanent removal, and data export remain explicitly unavailable.
Agent setup and revocation use the existing `/setup-account` and `/revoke-account` server actions.
Technical import details remain under Settings.
Route destinations and post-upload profile navigation must be wired by the runtime owner; no handler is changed by this slice.
