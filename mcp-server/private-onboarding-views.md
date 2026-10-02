# Lightweight onboarding views

`private-onboarding-views.mjs` is the renderer module used by the default-off private browser, not a released public onboarding flow.
Its indigo styling and journey follow the accepted onboarding and app storyboards.
The runtime owner must integrate it without changing authorization boundaries.

Each renderer returns `{title, content}`. `content` is the whole page body: the shared
header (logo, search, navigation), the page's own `<h1>` inside `<main class="journey">`,
and the shared footer. The wrapper adds only the document head; it must not add a second title.
The stylesheet requests the Public Sans webfont, so the wrapper links `ONBOARDING_FONT_HREF`
and its CSP allows `https://fonts.googleapis.com` styles and `https://fonts.gstatic.com` fonts;
without them the pages fall back to the system font.
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

`renderJoin` forwards session props only when `signedIn` is true; every signed renderer accepts
`accountLabel`, optional `displayName` and `csrf`. A `csrf` value is what marks a page as signed in.

Every page has one search input, in the shared header: a native GET to `/network` with `q`.
It carries no CSRF token and works without a session; the controller serves the public list to
visitors and the member view to members on the same path. The escaped current query is kept.
Signed-out navigation is Explore (`/people`), For agents, Sign in (`/login`) and Join (`/join`).
Signed-in navigation is People, My profile, For agents and an account chip that leads to
Settings; the chip shows `displayName`, a mailbox name for an address, or "Settings" for an
opaque identifier. An active import adds a header pill linking to `/profile`. The footer holds
Meet, For agents, `llms.txt` and, for members, the account label and the sign-out form.

`renderLanding()` is the signed-out home: headline, Create my profile (`/join`), explore link
(`/people`), LinkedIn export panel, a labelled fictional sample profile and the agent band.
`renderSignInRequired({next})` is shown for a member page opened without a session; a valid
root-relative `next` becomes `/login?next=…`, anything else is dropped.
`renderPerson({profile, ...session})` renders any published profile for visitors and members:
banner, headline, location, About, Experience, Education, Skills and that person's connections,
each linking to `/people/{id}`, with a Show more link when `nextConnectionsCursor` is present.
It renders only those DTO fields. `renderAgents`, `renderImportGuide` and `renderMeet` are the
public guides in the same shell; Meet keeps the element ids its scanner script binds to.

The People contract is: `everyone: [{id, name, headline?, company?, location?}]`, optional `own`
containing the existing own-contact DTOs (including reason), optional string `nextCursor`, and
`state: 'ready' | 'unavailable'` plus existing welcome/error. With a query the title becomes
“Results for …” with Best match / Exact words links (`mode`, default `best`) and a Clear search link;
`mode: 'exact'` adds a hidden `mode` field to the header search and to Show more, and `match: 'some'`
shows a line saying nobody has every word. Defined `own` renders People you know before Everyone
on Unlinked. AI ranking is not a second search box: when a signed-in member has a query, the
results show a small POST `/search-account` form carrying `csrf` and the hidden `query`, with one
submit button per available scope (`everyone` when public search is on, `own` when `own` is
defined). Defined empty `own` with a query is a no-match result; without a query it shows the
import prompt, which links to `/import`.
`anonymousAi: true` with a query and no session shows one Ask AI button posting the hidden `query`
to `/ask`. `aiMatches` renders an AI picks group above the lists, each row with its escaped `reason`,
followed by `aiNote` and a sentence saying what OpenAI received; `aiError` replaces the picks with an alert.
Plain list rows never show a reason.

For the current controller, legacy `contacts` and `searchResults` remain supported.
When `own` is undefined and either legacy prop is supplied, own rows come from
`searchResults` when defined, otherwise `contacts`; even an empty array enables
the own group. An explicit `own` takes precedence over both.
Legacy empty-result copy preserves PR35: a nonempty `contacts` array with a query
shows no match, while no contacts shows the import prompt regardless of query.
The new explicit `own: []` with a query keeps its no-match rule. Omitted `everyone`
renders no Everyone group; a supplied array, including an empty array, enables it
and the existing availability/empty-result states. No membership is inferred from
legacy contact rows.

Everyone rows show only initials, linked name (`/people/{encodeURIComponent(id)}`),
headline/company and optional location. No LinkedIn link, listed-by/member flags,
reason or mutual counts appear in that group. Unavailable shows “Member search is
on its way.” and no rows; ready empty lists distinguish no query from no match.
Error retains the existing failure alert rather than claiming either list is empty.
`nextCursor` supplies a native Show more GET link to `/network?cursor=...`, with
encoded `q` before cursor when query is nonempty. No scope or other fields are
added to that pagination URL. Friends remain unavailable (“Friends come soon.”).
The controller owner integrates this contract and routes; no runtime changes occur here.
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
The upload notice says profile and connections join the member's Unlinked network and can be used for search; in the global runtime, the public-search notice and Settings copy also explain that new imports make professional profiles and connections findable by members and visitors. Contact details stay private. Settings explains private retention and bounded OpenAI query-time processing in plain words.

Profile editing, friends, permanent removal, and data export remain explicitly unavailable.
The Everyone group renders only the member availability and DTOs supplied by the runtime.
Agent setup and revocation use the existing `/setup-account` and `/revoke-account` server actions.
Technical import details remain under Settings.
Each optional import `sha256` value is escaped and shown only inside its `<details>`,
alongside the existing `accepted`, `indexed`, `filename`, `status` and `id` fields.
Join offers Google and email buttons, both forwarding to `/login`. Skip goes to
`/profile`; Looks good goes to `/network`. My profile navigation also uses `/profile`.
The own profile uses the same layout as `renderPerson`, with optional `contacts` and
`connectionCount` filling the My connections card and links to `/import` and `/settings`.
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
`buildPreviews(outDir)` writes the same document as the server (head plus the view as body),
without a network connection or server. Preview generation does not install scripts;
both optional enhancements remain separate for controller CSP integration.

Global runtime integration renders People without session props for visitors; `publicProfessionalSearch` controls the NEW upload action notice and Settings public/private explanation. Individual import summaries carry `visibility: public|private`; older private imports retain private wording. No renderer prop itself grants authority or publishes data.
