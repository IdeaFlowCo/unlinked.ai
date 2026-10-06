# Sign in with Ideaflow

The standalone runtime has exactly one sign-in control, **Sign in with Ideaflow**,
which goes to `GET /login` and then to Ideaflow ID. Google, email/password,
sign-up and password reset all happen on Ideaflow ID, not in Unlinked. Signed
out, the page header carries one "Sign in" button; the Join and "Sign in to
continue" pages carry the body button instead. There is no other sign-in path
and no operator fallback switch.

## The `prompt` parameter

`createIdeaflowLogin().begin()` (`mcp-server/private-browser.mjs`) builds the
only authorization URL. It accepts no `prompt`, `select_account` or `none`
(automatic sign-in only), and rejects every other value.

| Flow | `prompt` |
| --- | --- |
| Ordinary sign-in, including the OAuth connector's sign-in and `/i/<token>` invitation links | none: with an Ideaflow ID session the provider returns at once (silent SSO) |
| First sign-in after an explicit Unlinked sign-out, Switch account or account deletion | `select_account` |
| Invited-owner binding (`/invite`, and "Use another account" on its confirmation) | `select_account`, then Unlinked's own confirmation of the returned account |
| Automatic sign-in on a signed-out page view (below) | `none`: never a provider page |

Unlinked never sends `prompt=login`. A forced password would add no
protection to the connector grant: a browser that already has an Unlinked
session goes to consent without visiting Ideaflow ID. The consent page names the
signed-in account and offers "Not you? Switch account"; the consent decision is
the grant's confirmation.

## Sign-out marker

`POST /logout`, `POST /switch-account` and account deletion set
`__Host-ul-signed-out=1` (Secure, HttpOnly, SameSite=Lax, one hour). While it
is present, `/login` sends `prompt=select_account`. A successful sign-in clears
it. The cookie carries no URL or identity, and only the exact value `1` counts.

## Switch account

The Me menu (and the connector consent page) posts `POST /switch-account` with
the session CSRF token. It ends the session exactly like Sign out, sets the
marker and redirects to `/login`. An optional `next` field is kept only if it
is one of `returnPath`'s fixed local pages (or a validated
`/oauth/authorize?` request when the connector is configured); anything else,
including an absolute or protocol-relative URL, falls back to `/login`, so it
cannot become an open redirect.

That form's redirect chain ends at Ideaflow ID. Browsers apply `form-action`
to every hop, so the page CSP allows `form-action 'self'` plus the configured
issuer origin (`login.authorizationOrigin`), and nothing else.

## Automatic sign-in

Someone already signed in to another Ideaflow app arrives on Unlinked signed in
(shared spec: automatic cross-app sign-in, code-xbh.21). When a signed-out
browser opens an ordinary page, the HTML handler answers with one `302` to
Ideaflow ID with `prompt=none` before rendering anything. State, nonce and S256
PKCE are exactly as for `/login`, and the pending record remembers that the
attempt is silent and the page's path and query. The `Location` has no
fragment, so browsers carry the page's `#hash` across every hop.

- **Provider session, existing Unlinked account** with nothing to confirm: the
  normal callback signs in and returns to the same path and query.
- **`login_required`** (or any other provider error, or no code): back to the
  same page, signed out, no error copy and no query added.
- **No Unlinked app record yet** for that verified Ideaflow identity: create the
  private app record and sign in on the same page. OpenChat and Unlinked share
  one account; this does not publish a public profile, claim an imported person,
  import contacts or open `/find-me`. The explicit sign-in may still offer the
  optional profile setup.
- **An unconfirmed old-account match** (`/legacy-account`), a failed code
  exchange or any other app-level failure: back to the page signed out, no
  error page. The explicit sign-in keeps its full flow and errors.
- A `prompt=none` error answer whose attempt is gone (expired, runtime
  restarted mid-hop) goes to `/`. A concurrent tab whose `__Host-ul-login`
  cookie another attempt replaced returns to its own page without exchanging
  its code; the cookie binding stays the login-CSRF defence.

Each outcome after a returned code is recorded as audit event
`auth_silent_signin` with `outcome` (`signed_in`, `no_account`,
`needs_confirmation`, `failed`) and no identity.

**When it never runs**

- Once per browser session: the hop sets `__Host-ideaflow_auto_signin=1` (a
  session cookie: Secure, HttpOnly, SameSite=Lax, no Max-Age). A failed attempt
  never clears it.
- After an explicit sign-out, Switch account or account deletion: those set the
  same session marker plus the one-hour `__Host-ul-signed-out` cookie, and
  either one stops the hop.
- Only `GET` with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and an
  `Accept` containing `text/html`. Missing Sec-Fetch headers mean no attempt.
  `Sec-Purpose`/`Purpose` prefetch or prerender never trigger it.
- Not for crawlers, link unfurlers or scripted clients (the shared User-Agent
  list in `AUTO_SIGNIN_BOTS`), nor in embedded webviews, in-app browsers or
  Electron shells (`AUTO_SIGNIN_EMBEDDED` plus `inAppBrowser()`). HeadlessChrome
  is not excluded.
- Only on ordinary pages (`autoSignInPage`): `/`, `/people`, `/people/<id>`,
  `/companies/<name>`, `/network`, `/profile`, `/card`, `/settings`, `/import`,
  `/invites`, `/invitations`, `/notifications`, `/people/add`, `/scan`,
  `/meet`, `/agents`, `/import-linkedin`. Never `/login`, the callback,
  `/logout`, `/join`, invitation links (`/i/…`, `/invite…`), contact-card links
  (`/c/…`, a hand-off opened from a QR code whose token should not travel through
  more redirects), `/legacy-account`, `/find-me`, `/claim-me`, unsubscribe,
  `/mcp`, `/oauth/*`, `/.well-known/*`, robots/sitemap, assets, photos or APIs.
- Only on open-account runtimes (`signup` configured), and never while more
  than 50 sign-ins are pending, so explicit sign-ins keep their headroom.

**Kill switch:** set `UNLINKED_AUTO_SIGNIN=off` (also `false`, `0`, `no`) in
`runtime/runtime.env` and restart the runtime. Unset means on.

## Deployment

`UNLINKED_AUTO_SIGNIN` is the only environment variable (optional, default on).
Sessions are durable (`docs/durable-sessions.md`), so a runtime restart does not
sign anyone out.
