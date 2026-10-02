# PWA Audit & Changes (2026-10-02)

## Audit Findings (Live Site)
- **Manifest**: Present at `/manifest.webmanifest`. Contains `name`, `short_name`, `display: "standalone"`, `theme_color`, `background_color`, `scope: "/"`, `start_url: "/"`.
  - *Passes*: Icons are present, including `192x192`, `512x512` and `maskable` icon.
  - *Fails*: Missing `shortcuts` array for quick actions like "My card" and "Scan".
- **iOS Support**: 
  - *Passes*: `apple-touch-icon` is present.
  - *Fails*: Missing `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style`.
- **Service Worker**:
  - *Passes*: Present at `/sw.js`. It caches only public shell assets (offline.html, manifest, icons). Doesn't cache member content. Offline fallback `offline.html` is returned correctly on navigation failures.
- **Start URL & Signed-out Experience**:
  - *Passes*: `start_url` is `/`. When a signed-in member opens the PWA, `/` redirects them directly to `/network` (if they have an imported profile) or `/import`. If they are signed out, they see the landing page.
- **Install Hint**:
  - *Fails*: No dismissible "Add to Home Screen" hint on the `/card` page to encourage installation.

## Changes Made
1. **Manifest Shortcuts**: Added `shortcuts` to `public/manifest.webmanifest` for `My card` (`/card`) and `Scan` (`/scan`).
2. **iOS Meta Tags**: Added `apple-mobile-web-app-capable="yes"` and `apple-mobile-web-app-status-bar-style="default"` to the page template in `mcp-server/private-browser.mjs`.
3. **PWA Hint**: Added a dismissible "Add to Home Screen" hint (`#pwa-hint`) on the `/card` view (`renderCard` in `mcp-server/private-onboarding-views.mjs`). The logic to show/dismiss it is placed in `TOP_BAR_SCRIPT` to comply with the page's strict CSP (no inline event handlers). It appears only on touch devices, when the page is not already running as the installed app, and stays dismissed per browser.
   `viewport-fit=cover` was considered and left out: the stylesheet defines no safe-area padding, so the page would slide under the notch.
4. **Tests**: Verified that the changes do not break existing `tests/pwa-assets.test.mjs` and the application remains compliant with the `default-src 'none'` CSP.

## Unverified
- The visual rendering of the "Add to Home Screen" hint and the exact iOS status bar appearance (`default` vs `black-translucent`) could not be verified without a real device/simulator. The prompt for installation behavior across different mobile browsers was not fully observable via CLI.