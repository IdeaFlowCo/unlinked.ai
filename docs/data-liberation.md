# Data liberation

`/data-liberation` is a public reference page: where to request a copy of
your data from LinkedIn, Facebook, Instagram (and Threads), Google, X, Apple,
TikTok, Amazon and Microsoft, plus WhatsApp's in-app steps. It also covers what
to do when a service has no export button (GDPR/CCPA requests) and how to bring a
LinkedIn export into Unlinked.

- Every link is the service's own export page (`DATA_EXPORTS` in
  `mcp-server/private-onboarding-views.mjs`). Unlinked never receives those
  files. Blurbs say what you get and roughly how long it takes; keep them short
  and recheck them when a vendor changes its flow.
- Served by `servePublicDiscovery` like `/support`: no session needed, its own
  CSP, no owner reads, and not an auto sign-in page. `/export-your-data` and
  `/data-export` redirect to it. (`/export` is the member's own JSON download.)
- Linked from every footer ("Data liberation"), from Settings → Your data, and
  from the LinkedIn import guide. Those are quiet text links, not banners.
- In the iOS app (`iosAppView`) every export link becomes `x-safari-https://…`
  so it opens in Safari, where people are signed in. LinkedIn keeps its
  existing hand-off help (see [ios-app-web.md](ios-app-web.md)).
