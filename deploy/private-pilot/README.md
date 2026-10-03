# Private pilot release packet

This packet prepares `unlinked-b3q`; it does not activate the proposed target or establish `unlinked-9a9` real acceptance.
`manifest.example.json` records proposed destinations and unapproved source heads, image digests, provider and DNS operations.
Its Unlinked source pin is the committed isolated-container implementation used for compatibility review, while `ready: false` and the missing final receipt keep the example inactive.
A real private release manifest must pin the final reviewed merge plus compatible exact artifacts and receipt digests, never a stale base checkout.
All-zero image digests are deliberately unusable proposals; replace them with individually reviewed dependency-complete images, never floating tags.
No dependencies are installed by this packet.

## ⚠ Two nginx variants — canonical rollouts MUST swap the config

`compose.yaml` mounts `./nginx.conf` from the release directory, and the
repo's `deploy/private-pilot/nginx.conf` is the **private.unlinked.ai
rollback-host variant** (its Host check answers every www request with
`return 444`: connections close with no response; `curl` shows TLS
established then exit code 000/35). `private.unlinked.ai` is NOT defunct —
DNS still points at the production address and it remains the documented
rollback/release-planning origin asserted by `topology-check.py` and
`tests/private-pilot-ingress.test.mjs` — so the private variant stays the
committed default and must not be deleted or renamed.

For every **canonical www.unlinked.ai release directory**, after copying the
packet files and before `start`:

```sh
cat $R/release/durable-<sha8>/nginx.canonical.conf > $R/release/durable-<sha8>/nginx.conf
```

If a canonical release is already live with the wrong config: overwrite the
file **in place** (keep the inode; single-file bind mounts do not propagate
replacements) and `sudo -n docker restart <project>-ingress`.
This omission caused a ~9 minute www outage on 2026-10-02 (release
`durable-ef1ea5b9`).

## Commands

```sh
python3 deploy/private-pilot/pilot.py plan
python3 deploy/private-pilot/checks.py
python3 deploy/private-pilot/topology-check.py
python3 deploy/private-pilot/root-mount-check.py
node --check deploy/private-pilot/runtime.mjs
# Later, on the exact approved GCP host, with a mode-600 reviewed manifest:
python3 /release/pilot.py preflight --manifest /private/release.json
python3 /release/pilot.py canonical-readiness --manifest /private/canonical-release.json --execute
python3 /release/pilot.py start --manifest /private/release.json --execute
python3 /release/pilot.py stop --manifest /private/release.json --execute
python3 /release/pilot.py backup --manifest /private/release.json --execute
python3 /release/pilot.py verify-backup --backup /private/cold-pair --checksum /private/cold-pair.sha256
python3 /release/pilot.py restore --backup /private/cold-pair --checksum /private/cold-pair.sha256 --rehearsal /srv/unlinked-private-guest-pilot-20261001/backups/rehearsal-restore1
python3 /release/pilot.py restore --backup /private/cold-pair --checksum /private/cold-pair.sha256 --rehearsal /srv/unlinked-private-guest-pilot-20261001/backups/rehearsal-restore1 --execute
python3 /release/pilot.py rollback --manifest /private/release.json --execute
```

Every command defaults to no mutation except verification, which only reads its explicit private snapshot.
`preflight` requires final source receipts, exact clean checkout heads, reviewed wiring digest, verified image artifacts, existing mode-700 roots/directories and mode-600 inputs.
There is no implicit directory creation during deployment and no command to obtain a certificate, alter DNS, register a client, create an invitation or copy credentials.
The start command fails on occupied owned ports; services must be explicitly checked after start before any claim of availability.
For the first canonical cutover only, `canonical-readiness` accepts exactly `https://www.unlinked.ai` before public DNS is switched, still requires the reviewed client/provider, source receipts, image artifacts, private inputs and certificate, starts only the same owned three-service composition, verifies owned labels, and probes `https://www.unlinked.ai` directly at `34.10.134.247` with www SNI/Host and normal TLS validation. It must observe anonymous 200, transactionless callback 400, Ideaflow auth-start redirect and the secure `__Host-ul-login` cookie attributes. Normal `start` keeps the live DNS guard.
HTTPS availability is checked without requiring the operator to bind port 443 directly; app, operations and graph ports are not published by the private container recipe.
Production client and identity operations remain with the identity owner.
Readiness booleans record verified source, image, isolation and input facts; they do not introduce routine human approval gates for reversible preparation.
The production identity operation and new persistent OpenAI secret destination retain their explicit authority requirements.

## Trusted runtime capability

The inspected product exports `startPrivatePilot({baseUrl, login, resolveOwner, claimInvitation, signup, legacyAccount, accountGrantKey, getBackend, complete, backgroundImports, audit, port, host, networkMode, dataMode})`; its real-data mode is exactly `private_live`.
`mcp-server/private-composition.mjs` provides the process-only `createPrivatePilotDependencies(options)` implementation.
Install this packet's `wiring.mjs` as mode 600 at `/srv/unlinked-private-guest-pilot-20261001/runtime/wiring.mjs`; its relative export resolves the exact private Unlinked checkout.
The factory loads only compiled Noos operational modules from the private Noos checkout, never its legacy auth or generic query application.
It validates the dedicated root, exact approved live origin and ports, initializes callback-only invitation provisioning plus open-account signup, starts the singleton background import worker, and mints internal ephemeral operations credentials only after active owner/principal authorization. The approved live origin is either the rollback private host or the canonical `https://www.unlinked.ai` cutover host.
Before provisioning or exposing HTTP readiness, it waits for the dedicated Bolt driver to report graph connectivity with the same bounded driver timeouts.
The server-side operations key never leaves the runtime; hosted MCP uses separate account grants and live publication fences (permissions: [agent API contract](../../docs/agent-api.md)).
The private env, production client, TLS/DNS, dependency-complete source artifacts and built deployment images remain activation inputs.
It must start the isolated operational service only at container `127.0.0.1:9022` and return `login`, `resolveOwner`, `signup`, `accountGrantKey`, `getBackend`, `complete`, `backgroundImports`, `audit` and `close` capabilities; invitation-capable deployments may also return `claimInvitation`, and recovered-account deployments may return `legacyAccount`.
The login object must implement `begin`, `finish` and the exact HTTPS `authorizationOrigin` using `createIdeaflowLogin` with the verified production issuer/client and callback.
The invitation authorization request uses `prompt=select_account` (ordinary sign-in sends no `prompt`; see `docs/ideaflow-sign-in.md`); Unlinked confirms the returned verified account before an invited owner claim, rather than silently binding by email.
The Noos integration uses `OperationalStore`, `StagingFileAssets` and callback-role `InvitedOwnerProvisioner`; `signup` is its guarded open-account method, `claimInvitation` remains its guarded invitation method, and `resolveOwner` resolves the same verified issuer/subject mapping. The operational store must expose `listPendingImportJobs` and owner-scoped `listImportJobIds`; older Noos artifacts fail startup instead of falling back to synchronous import.
When `legacyAccount` is present, it is backed by Noos `UnlinkedLegacyLinks`; candidate lookup uses only server-held signed Ideaflow email evidence after owner resolution, and confirmation writes a private association receipt without creating a new owner or duplicating the recovered public profile.
When the paired Noos artifact also exposes `UnlinkedLegacyStorageStore`, the composition may add browser-only recovered-original listing/downloads and sanitized recovered Connections observations for that same confirmed owner; those originals are not account-grant resources.
`getBackend` must revalidate active immutable owner/principal and publication access on every operation.
The operational API exposes only its scoped router, never the legacy generic graph query routes.
The returned `close` capability must stop the background worker, operational listener and graph driver on shutdown.
Scoped readers fetch at most eight observations concurrently, preserve every manifest ordinal and recheck the final live publication after all rows; they do not extend the existing 30-second per-request bound.
Archive asset staging waits for the original blob and `uploaded` receipt before browser redirect; publication then proceeds through the server worker, profile-first chunks and one final fence. Asset publication waits for file and directory fsync; a paired cold restore rehearsal remains required before real data.
Read-only source mounts must contain locked dependencies supplied in the approved runtime image or exact checkouts; the packet does not download or install them.

## Private destinations and invitation recovery

Create the proposed root and each private state, runtime and backup directory with mode 700 only after target approval.
All private env, operator config, invitation bundle, audit receipts and snapshot files must use mode 600 under the operator UID/GID. Browser callback success/denial and worker retry events append to `audit/browser-events.jsonl` with bounded sanitized fields only; no tokens, identity subjects, email addresses, cookies, authorization URLs, queries or archive content belong there.
Run the helper as the private file-owning release operator, not as root.
The existing Noos operator's read-only `sudo -n docker info` route was verified; direct socket access is denied.
The helper uses noninteractive sudo only for Docker commands and preserves exactly `PILOT_ORIGIN`, `PILOT_UID`, `PILOT_GID`, `PILOT_NEO4J_IMAGE`, `PILOT_RUNTIME_IMAGE` and `PILOT_NGINX_IMAGE` for Compose, with `PILOT_ORIGIN` derived from the validated manifest rather than the ambient shell.
It verifies daemon access before launching or stopping owned services; secret values remain in explicit private env files and never enter command arguments or the preserved environment allowlist.
Container user IDs are set explicitly from the local operator and no bind source can be automatically created by Compose.
Neo4j graph files must satisfy the private recovery permission checks; verify the approved image's file ownership/modes before enabling guest data.
The graph entrypoint retains `tini` and the pinned image's startup script with `umask 077`, so newly created graph directories/files use private 700/600 modes.
This does not repair earlier files; preserve those synthetic rehearsal receipts and use a fresh private pilot root, or a separately reviewed recovery operation for any existing data.
Readiness probes run through a separate bounded Node driver, rather than adding a second JVM inside the graph's 2 GiB memory limit.
`runtime.env`, `graph.env` and `operator.json` are proposed destinations, not files to populate automatically.
The recipe uses explicit `isolated-container` mode.
A dedicated frontend bridge contains only nginx and runtime; a separate internal backend bridge contains only runtime and graph.
Only nginx publishes host 443 to its unprivileged container port 8443, as the file-owning operator with all capabilities dropped.
The browser listens on 0.0.0.0:9367 inside its container with no published app port; operations stays on container loopback 9022 and Bolt uses exactly graph:7687 on the internal backend.
The default process mode remains host loopback; an arbitrary public browser/graph address is rejected.
The proposed persistent OpenAI destination is `runtime/runtime.env` and requires explicit destination confirmation before any key copy.
Synthetic testing can continue reading the existing M5 key in place; no model key belongs on a CI VM.
The runtime reads `IDEAFLOW_ISSUER`, `IDEAFLOW_CLIENT_ID`, `IDEAFLOW_CLIENT_SECRET`, `NOOS_PRIVATE_PASSWORD` and `OPENAI_API_KEY` from its explicit `runtime.env` only.
Email delivery reads `RESEND_API_KEY`, `UNLINKED_EMAIL_SECRET` (required, at least 32 bytes after hex/base64 decoding, e.g. `openssl rand -hex 32`; never reuse another credential), and optional `UNLINKED_EMAIL_FROM`, `UNLINKED_INVITE_EMAILS_PER_DAY` and `UNLINKED_EMAIL_ENABLED` from the same `runtime.env` (Compose's `env_file`, so no compose change is needed). Without the key nothing is sent; without a valid secret email is disabled and the runtime logs one non-secret line; `UNLINKED_EMAIL_ENABLED=false` turns sending off. See `docs/email.md`.
For the optional signup profile lookup, follow the [host setup contract](../../docs/signup-profile-lookup.md#host-setup).
The proposed production issuer is `https://id.ideaflow.app/api/auth`; client registration and confidential secret delivery belong to the identity owner.
The callback is exactly the manifest origin plus `/auth/callback/ideaflow`: `https://private.unlinked.ai/auth/callback/ideaflow` for the rollback private packet, or `https://www.unlinked.ai/auth/callback/ideaflow` for the canonical cutover packet. The isolated container recipe uses browser 9367, operations on its own loopback 9022, and the dedicated internal graph at graph:7687.
Run it as the explicitly provisioned private host operator UID/GID recorded in the release manifest; no root database or operator invitation capability is passed through HTTP.
The Noos operator CLI owns invitation creation/replay/revocation and accepts a private config plus `NOOS_PROVISIONING_PASSWORD` without printing its secret.
Its `create --config PRIVATE.json --out NEW-PRIVATE.json` writes the mode-600, fsynced recovery bundle before the graph operation.
Retain that exact bundle under `invitations/operator-recovery.json`; never place its token or URL in a release receipt, shell history, CI output or proxy logs.
The recovered-account operator helper seeds only the exact 81-row hash-only manifest against the published recovered public source, and revokes by exact profile/receipt; raw inventory, email addresses and graph/provider credentials must never enter argv or logs.
The legacy Storage operator helper publishes/revokes only from the owned isolated runtime with exact pinned backup and ZIP sources, verifies asset readback before the immutable manifest fence and has no browser or agent route.
The offline operator capability never enters the browser runtime.

## Recovery and ingress

Compose owns only three distinctly named and labeled containers and two dedicated bridges; only ingress publishes HTTPS 443.
Graph and runtime have no published ports; nginx cannot join the internal graph bridge or access runtime loopback operations.
The runtime parent path is a mode-700 tmpfs owned by that same UID/GID; Docker would otherwise create the unmounted parent as root-owned mode 755 and the factory correctly refuses it.
Only this directory shell is ephemeral; the explicit runtime, assets and audit child bind mounts preserve their existing read-only/write boundaries and durable host files.
The graph, backups and invitation trees are not broadly mounted into the app.
`python3 deploy/private-pilot/root-mount-check.py` proves the before/after ownership using a bounded, network-none Node container and persistent generated child files; no credentials, graph or provider are used.
All services run as the private operator with all capabilities dropped; nginx temp paths and tmpfs ownership permit non-root startup with read-only TLS mounts.
If a separately owned maintenance-only ingress occupies 443, verify its exact saved ID/root/maintenance labels and stop it before starting the full recipe; retain its config/certificates for rollback.
Existing port-80 nginx, legacy Noos containers, shared graph, existing assets and synthetic fixture roots are not mounted or stopped.
Proxy request/error logging is disabled, so `/invite/<token>` and query strings cannot leak there.
Ingress sends `Referrer-Policy: strict-origin`; the browser app's invited landing page allows only self plus the configured HTTPS identity origin in CSP `form-action`, and later private forms remain self-only.
Wrong Host headers and raw operations/asset/query paths are rejected; application session/CSRF/owner authorization remains the trusted product's responsibility.
`backup` requires all three owned containers stopped, pairs `neo4j-data`, `assets`, `identity-state`, `invitations` and `audit`, and captures the complete graph including bindings/principals/revocation fences.
`identity-state` stores any separately persisted identity adapter state; it must exist even when empty because identities are entirely in the graph.
Manifest and file digests, private modes and fsync are checked; retain the adjacent checksum in operator-controlled storage because a checksum is integrity evidence rather than an external signature.
Restore only creates a NEW uniquely named `backups/rehearsal-*` directory under the existing operator-owned mode-700 backup root, verifies every copied byte and never starts a graph, mounts the restored graph live or overwrites pilot/legacy storage.
The target must be canonical, absent and without symlinks; parent ownership/mode are checked and atomic creation refuses competing writers. No sudo or /srv write permission is needed.
The application writer must verify graph queries, source/owner/principal readback, receipts, blob references, counts and tombstones on that separately approved rehearsal before accepting recovery.
Rollback stops only labeled owned services and preserves all state, invitation bundles, source receipts and backups.
It invalidates ephemeral browser sessions and MCP signing keys through runtime stop; durable invitation/grant or provider-client revocation is a separate owner operation using the retained recovery bundle.
