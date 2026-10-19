# Universal links and passkeys for the iOS app

The Unlinked iOS app (`ai.unlinked.app`, team `JESMXK96LG`) is entitled for
`applinks:www.unlinked.ai`, `applinks:unlinked.ai` and
`webcredentials:www.unlinked.ai`. iOS reads the association file from each host
through Apple's CDN, without cookies, and **never follows a redirect** for it.

The file is `public/.well-known/apple-app-site-association` (JSON, no extension).
It opens contact cards (`/c/*`), profiles, company pages, Meet and Scan in the
app, and every other page except sign-in and machine traffic: `/auth/*`,
`/login*`, `/mcp*`, `/oauth/*` and `/api/*` are excluded, so an OAuth callback
or a connector authorization never lands in the app. Inside the app's own web
view links never trigger universal links, so in-app navigation is unchanged.

| Host | Served by | How |
|---|---|---|
| `www.unlinked.ai` | standalone runtime (GCP ingress) | exact asset in `mcp-server/public-discovery.mjs`, before any session step; `application/json`; also at `/apple-app-site-association` |
| `unlinked.ai` (apex) | Vercel project `unlinked` (IdeaFlowCo team) | static file from `public/`; `vercel.json` sets `application/json`, rewrites `/apple-app-site-association`, and redirects everything else to `https://www.unlinked.ai/…` (308) |

The apex used to redirect at Vercel's *domain* level (`unlinked.ai` → `www`,
308), which applies to every path, including this file. That domain redirect
is replaced by the two host-conditioned rules in `vercel.json`. Changing the
domain setting is a one-time operator step after the `vercel.json` change is
live in production (see the release notes for the exact API call and
rollback). The Next.js middleware skips the file, so it never waits on the
legacy database.

Check: `curl -sI https://www.unlinked.ai/.well-known/apple-app-site-association`
and `curl -sI https://unlinked.ai/.well-known/apple-app-site-association` both
answer `200` with `content-type: application/json` and no `location`; Apple's
view is `https://app-site-association.cdn-apple.com/a/v1/www.unlinked.ai`
(it can lag by up to a day). Tests: `tests/ios-universal-links.test.mjs`.
