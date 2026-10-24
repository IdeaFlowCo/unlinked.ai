# Appearance

The canonical browser runtime follows the device’s color scheme by default,
including changes while a page is open. The quiet half-circle icon in every
page header opens **Appearance → System / Light / Dark**, before and after
sign-in. The native selector supports keyboard and voice control; Escape closes
the panel and returns focus to its trigger.

A Light or Dark override is stored only on this device/browser under
`unlinked.appearance.v1`. System removes the override. Other tabs update on a
storage change; no preference is written to the account or graph. If storage
is blocked, the choice works for the current page. With scripting disabled,
CSS still follows the system.

`mcp-server/appearance.mjs` owns the tokens, pre-paint initialization, control
and enhancement. Canonical journey and public discovery documents run it
under their existing response nonces. `private-onboarding-style.mjs` uses
semantic colors for surfaces, text, borders, messages and status states;
profile photos, colored initials, camera previews and QR canvases retain their
own colors. QR canvases remain white for scanning. Public Sans, existing
spacing and the indigo product accent are retained.

Checks: `node --test tests/appearance.test.mjs` covers default/saved/invalid and
blocked storage initialization, labelled controls and CSP nonce placement on
canonical and discovery pages. Existing onboarding, navigation, profile-card
and messaging tests cover shared consumers. Static fictional previews include
both appearance scripts for visual verification.
