# The website inside the iOS app

The Unlinked iOS app is a WKWebView shell whose user agent ends in
`UnlinkediOS/<version>` (`iosAppUserAgent`, `src/utils/public-people/members-only.mjs`).
Web changes reach it immediately; nothing here needs a new app build. Besides
the members-only directory ([ios-app-directory.md](ios-app-directory.md)),
pages are adjusted on the server after rendering (`iosAppView` in
`mcp-server/private-onboarding-views.mjs`, applied by `journey` and by the
public discovery pages):

- **LinkedIn export hand-off.** LinkedIn's data-export page is linked as
  `x-safari-https://www.linkedin.com/mypreferences/d/download-my-data`. The
  shell hands non-http schemes to iOS, which opens Safari directly: not the
  LinkedIn app (it has no export) and not the in-app web view (not signed in
  to LinkedIn). Under the link: "It opens in Safari. When the file is ready,
  come back here and choose it from Files → Downloads", and **Copy link** as a
  fallback. Ordinary browsers keep the plain `https` link (in-app browsers such
  as Instagram keep their own escape links, `escapeHref`).
- **No "Add to Home Screen" hint** on My card (it is for browsers), and the
  client script never shows it under that user agent either.
- **No floating feedback button.** Feedback stays in the footer and on Help &
  support. On phone browsers the page keeps 96 px of room at the bottom so the
  button never covers the last actions.

Scanner fallbacks apply everywhere: when the camera is declined or missing,
the paste box opens and the status names where to allow it (in the app:
Settings → Unlinked → Camera), and **Scan from photo** reads a QR code from a
picture or screenshot (`decodeImageFile`, jsQR, in the browser only).

Tests: `tests/scan-onboarding.test.mjs`.
