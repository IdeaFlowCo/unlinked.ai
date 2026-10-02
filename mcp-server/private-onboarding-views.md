# Lightweight onboarding views

`private-onboarding-views.mjs` is the renderer module used by the default-off private browser, not a released public onboarding flow.
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
Signed-out Join shows only the logo and outbound Meet link in its header. Member
navigation uses the same session CSRF presence as header search and sign-out.
People has one search input, in the shared header: POST `/search-account` with
`csrf` and `query`. It retains the escaped current query; there is no separate
in-page search or GET `/network?q` filter form. Empty `contacts` shows the import
prompt regardless of query. Nonempty `contacts` with a query and empty results
shows the no-match message; callers retain existing contacts alongside searchResults
to distinguish those states. No renderer props or server actions were added.
Every signed renderer accepts optional `importJob` containing `id`, `status`, `profileReady`, `processed`, `total`, `statusUrl`, and optional `errorMessage`.
Statuses are `uploaded`, `parsing`, `indexing`, `indexed`, `partial`, and `failed`.
Processed counts and import accepted/indexed totals include Profile and Skills rows
as well as connections. They represent records, not a connection count; processed
counts represent durably staged records, not globally searchable rows.
The header renders server-provided progress across routes; this module does not poll an absent API.
With a positive safe-integer `total` and `processed` between zero and total, progress
uses those exact values and a rounded percentage. Missing, zero or inconsistent totals
are indeterminate, with no invented counts or timers. `indexed` displays the provided
`total` as the final record count. Header counts and Settings accepted/indexed
totals use records wording without changing props. A future explicit connection-count
prop could restore connections wording; the current totals cannot supply that count.
The background private browser path implements durable job continuation, authenticated same-owner status, and early own-profile staging when `backgroundImports` is enabled; any other runtime must supply equivalent behavior before enabling those states.
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
Signed-out Join and Bring-export show a quiet LinkedIn export request link under
their buttons, with the Connections/complete-archive wait-time line. Bring-export
retains its expandable instructions and includes that outbound link only once.
Route destinations and post-upload profile navigation are wired by the default-off private browser handler when open-account signup is enabled. Other hosts must keep the same owner/session boundaries if they reuse the renderers.

`renderOwnProfile` also accepts optional `linkedinLookup: {action: '/find-me'}` and
`lookupResult: {status: 'none' | 'found', profileName, headline, listedBy, claimAction}`.
These controls remain unwired until the runtime supplies the routes and props; no
lookup or claim UI appears when both props are absent. A valid lookup action adds
a separate optional form below the profile panel, posting `csrf` and one
`linkedinUrl` field. A `found` result with a valid claim action adds the “Is this
you?” card, escaped name/headline, integer member count, and a separate native
POST confirmation with `csrf`; Not me returns to `/profile`. `none` adds no card.
Actions must be root-relative routes on the current host; external/protocol-relative
URLs, backslashes, whitespace/control characters and fragments are rejected, and
valid actions are HTML escaped. No extra JavaScript or auto-claim behavior is added.
The runtime must authorize the lookup result and validate CSRF/confirmation and
ownership before any claim. A supplied LinkedIn address is a lookup hint, never
proof of ownership or a LinkedIn import. No runtime/auth/job handlers change here.

Generate fictional, static preview pages with
`node mcp-server/private-onboarding-preview.mjs /tmp/unlinked-ui-previews`.
`buildPreviews(outDir)` writes the same minimal title/content wrapper as the server,
without a network connection or server. Preview generation does not install scripts;
both optional enhancements remain separate for controller CSP integration.
