# Planned restart notices

Open Unlinked pages subscribe to the read-only `/api/runtime-events` SSE endpoint.
The standard private-pilot launcher handles SIGTERM/SIGINT by calling
`pilot.announceRestart()`, waiting five seconds with HTTP still available, then
closing event streams and the runtime. Allow at least 35 seconds in Docker stop
commands; force kills, crashes and whole-host outages cannot announce in advance.

A polite status banner explains the interruption, remains during reconnect, and
confirms recovery when a new runtime instance answers. It never reloads the page
or clears drafts. No browser notification permission or device push is required.
Existing pages must load the new client once before they can receive notices.

Release packets must copy the candidate `deploy/private-pilot/runtime.mjs` into
`runtime.mjs` in the new packet (do not retain a predecessor's launcher). Ingress
must pass SSE without buffering; the endpoint sends `X-Accel-Buffering: no` and
20-second heartbeats. It exposes only an opaque boot ID and restart timestamp,
with 2,000 concurrent streams maximum; it cannot trigger maintenance.

Validate with `node --test tests/restart-notice.test.mjs` and the browser suites.
