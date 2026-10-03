# Sign in with Ideaflow

The standalone runtime has exactly one sign-in control, **Sign in with Ideaflow**,
which goes to `GET /login` and then to Ideaflow ID. Google, email/password,
sign-up and password reset all happen on Ideaflow ID, not in Unlinked. Signed
out, the page header carries one "Sign in" button; the Join and "Sign in to
continue" pages carry the body button instead. There is no other sign-in path
and no operator fallback switch.

## The `prompt` parameter

`createIdeaflowLogin().begin()` (`mcp-server/private-browser.mjs`) builds the
only authorization URL. It accepts no `prompt` or `select_account`, and
rejects every other value.

| Flow | `prompt` |
| --- | --- |
| Ordinary sign-in, including the OAuth connector's sign-in and `/i/<token>` invitation links | none: with an Ideaflow ID session the provider returns at once (silent SSO) |
| First sign-in after an explicit Unlinked sign-out, Switch account or account deletion | `select_account` |
| Invited-owner binding (`/invite`, and "Use another account" on its confirmation) | `select_account`, then Unlinked's own confirmation of the returned account |

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

## Deployment

There are no new environment variables. Sessions are durable
(`docs/durable-sessions.md`), so a runtime restart does not sign anyone out.
