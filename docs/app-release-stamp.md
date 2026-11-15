# Standalone app release stamp and system theme

The canonical beta is the standalone runtime. This follow-up is based on the
actual deployed d8237036df86cfdfebc45d49ffb1d4536f7bf512 /0.6.122 on
release/card-prepared-20261115; default main/0.6.110 is older and must not be
used as a deployment predecessor.

The existing shared footer retains the app's package-derived version and adds
a muted relative Updated time. The approved dependency-free app-stamp kit uses
the per-release /version.json, refreshes per minute/visibility, and offers exact
local time/zone/commit through focus, Enter and tap. Both public and signed-in
renderers give the same-origin script the existing per-request nonce. Public
discovery adds exactly the metadata and kit asset paths; no arbitrary file route,
owner data, credential, account or API scope becomes public. Metadata is no-store
and the service worker's fixed public-shell cache list is unchanged.

Run npm run stamp:release once in the clean reviewed checkout, then include the
generated public/version.json in the retained release artifact. It records the
real Git committer time. Dirty/no-git source uses build time and event build;
the script never substitutes visit time, mtime or a typed release date. A release
preflight must require the expected version/commit/event and re-read it live.
Tests generate metadata automatically; do not hand-edit the file.

The existing indigo branding/light palette remains. System dark overrides the
existing tokens and white surfaces; there is no new preference or dependency.
This does not enable, migrate or modify private diagnostics, queries, accounts,
keys, providers, graph stores, imports, assets or operational workers.

Meet uses the camera, so APP-PRINCIPLES§2 requires tap-only hosted feedback. The
page now emits inert nonce-bearing widget configuration. An explicit Me/footer
Send feedback click loads the hosted script, waits for ready and opens it. The
existing unlinked-feedback board, headless trigger, iOS/web labels, session token
getter and server exchange remain. A blocked core gives visible retry/direct
board access without reloading the person's app state. No external WIT request
occurs on an ordinary visit; existing independent analytics are unchanged. The
historical SSR fallback URL unlinked-ai is not the active widget board identity.

Deployment is not authorized by this document. Use the canonical release
owner's guarded single-writer route with warm readiness and exact retained
rollback; legacy pilot.py base start is not a shared-graph deployment route.
Preserve the active source/runtime/ingress configuration and private state. A
genuine signed-in browser test remains separate from synthetic UI fixtures.
