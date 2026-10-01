# Lightweight onboarding views

`private-onboarding-views.mjs` is an unwired renderer module, not a released onboarding flow.
Its indigo styling and journey follow the accepted onboarding and app storyboards.
The runtime owner must integrate it without changing authorization boundaries.

Each renderer returns `{title, content}` for the server page wrapper.
The wrapper may keep `<main><h1>{title}</h1>{content}</main>`; scoped styles visually
place its single title after the shared header. There is no duplicate renderer title.
Content contains scoped styles; the wrapper must apply its actual style CSP policy.
All raw DTO values are HTML escaped, and contact links allow only HTTPS LinkedIn URLs.
Contacts and profiles must already be authorized by the caller.
No private contact is presented as a public member or mutual connection.

Production upload uses native multipart `/upload` with `csrf` and `archive` only.
The server must record upload consent itself before accepting this renderer.
Synthetic rehearsal mode explicitly adds the required `syntheticConsent` field.
`uploadProgressScript()` is an optional enhancement; wire it separately with the actual CSP nonce.
It preserves native form submission and has no simulated completion timer.
It describes the initial upload separately: the member must keep that page open until
the upload finishes, before the durable import can continue away from the page.
`agentSetupCopyScript()` is a new optional enhancement; install it separately with the
actual CSP nonce on Settings. It copies the configuration, selects it when clipboard
access fails, and leaves a readonly, selectable textarea and instructions without JS.

`renderJoin` forwards session props only when `signedIn` is true; every signed renderer accepts `accountLabel` and `csrf` for header search and sign-out.
Every signed renderer accepts optional `importJob` containing `id`, `status`, `profileReady`, `processed`, `total`, `statusUrl`, and optional `errorMessage`.
Statuses are `uploaded`, `parsing`, `indexing`, `indexed`, `partial`, and `failed`.
Processed counts represent durably staged records, not globally searchable rows.
The header renders server-provided progress across routes; this module does not poll an absent API.
With a positive safe-integer `total` and `processed` between zero and total, progress
uses those exact values and a rounded percentage. Missing, zero or inconsistent totals
are indeterminate, with no invented counts or timers. `indexed` displays the provided
`total` as the final connection count; the controller must supply an accurate count.
The runtime owner must implement durable job continuation, authenticated same-owner status, and early own-profile staging before enabling those states.
`total` may remain null until parsing knows the count.
Only final `indexed` status reports ready. The importing screen uses terminal status for its title and body, without pending progress or continuation promises.
The upload notice says profile and connections join the member's own network and are
searchable by them and any connected agent; contact details stay private. Settings
explains private retention and bounded OpenAI query-time processing in plain words.

Profile editing, shared-member discovery, friends, permanent removal, and data export remain explicitly unavailable.
Agent setup and revocation use the existing `/setup-account` and `/revoke-account` server actions.
Technical import details remain under Settings.
Each optional import `sha256` value is escaped and shown only inside its `<details>`,
alongside the existing `accepted`, `indexed`, `filename`, `status` and `id` fields.
Join offers Google and email buttons, both forwarding to `/login`. Skip goes to
`/profile`; Looks good goes to `/network`. My profile navigation also uses `/profile`.
Route destinations and post-upload profile navigation must be wired by the runtime owner; no handler is changed by this slice.

Generate fictional, static preview pages with
`node mcp-server/private-onboarding-preview.mjs /tmp/unlinked-ui-previews`.
`buildPreviews(outDir)` writes the same minimal title/content wrapper as the server,
without a network connection or server. Preview generation does not install scripts;
both optional enhancements remain separate for controller CSP integration.
