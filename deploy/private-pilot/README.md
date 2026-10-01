# Private pilot release packet

This packet prepares `unlinked-b3q`; it does not activate the proposed target or establish `unlinked-9a9` real acceptance.
`manifest.example.json` records proposed destinations and unapproved source heads, image digests, provider and DNS operations.
All-zero image digests are deliberately unusable proposals; replace them with individually reviewed dependency-complete images, never floating tags.
No dependencies are installed by this packet.

## Commands

```sh
python3 deploy/private-pilot/pilot.py plan
python3 deploy/private-pilot/checks.py
python3 deploy/private-pilot/topology-check.py
node --check deploy/private-pilot/runtime.mjs
# Later, on the exact approved GCP host, with a mode-600 reviewed manifest:
python3 /release/pilot.py preflight --manifest /private/release.json
python3 /release/pilot.py start --manifest /private/release.json --execute
python3 /release/pilot.py stop --manifest /private/release.json --execute
python3 /release/pilot.py backup --manifest /private/release.json --execute
python3 /release/pilot.py verify-backup --backup /private/cold-pair --checksum /private/cold-pair.sha256
python3 /release/pilot.py restore --backup /private/cold-pair --checksum /private/cold-pair.sha256 --rehearsal /srv/unlinked-private-guest-pilot-20261001-rehearsal-restore1
python3 /release/pilot.py restore --backup /private/cold-pair --checksum /private/cold-pair.sha256 --rehearsal /srv/unlinked-private-guest-pilot-20261001-rehearsal-restore1 --execute
python3 /release/pilot.py rollback --manifest /private/release.json --execute
```

Every command defaults to no mutation except verification, which only reads its explicit private snapshot.
`preflight` requires final source receipts, exact clean checkout heads, reviewed wiring digest, verified image artifacts, existing mode-700 roots/directories and mode-600 inputs.
There is no implicit directory creation during deployment and no command to obtain a certificate, alter DNS, register a client, create an invitation or copy credentials.
The start command fails on occupied owned ports; services must be explicitly checked after start before any claim of availability.
HTTPS availability is checked without requiring the operator to bind port 443 directly; app, operations and graph ports are not published by the private container recipe.
Production client and identity operations remain with the identity owner.
Readiness booleans record verified source, image, isolation and input facts; they do not introduce routine human approval gates for reversible preparation.
The production identity operation and new persistent OpenAI secret destination retain their explicit authority requirements.

## Trusted runtime capability

The inspected product exports `startPrivatePilot({baseUrl, login, resolveOwner, claimInvitation, getBackend, complete, port, host, dataMode})`; its real-data mode is exactly `private_live`.
`mcp-server/private-composition.mjs` provides the process-only `createPrivatePilotDependencies(options)` implementation.
Install this packet's `wiring.mjs` as mode 600 at `/srv/unlinked-private-guest-pilot-20261001/runtime/wiring.mjs`; its relative export resolves the exact private Unlinked checkout.
The factory loads only compiled Noos operational modules from the private Noos checkout, never its legacy auth or generic query application.
It validates the dedicated root and exact live origin/ports, initializes callback-only invitation provisioning, and mints internal ephemeral operations credentials only after active owner/principal authorization.
Before provisioning or exposing HTTP readiness, it waits for the dedicated Bolt driver to report graph connectivity with the same bounded driver timeouts.
The server-side operations key never leaves the runtime; hosted MCP uses its separate search-only grants and live publication fences.
The private env, production client, TLS/DNS, dependency-complete source artifacts and built deployment images remain activation inputs.
It must start the isolated operational service only at container `127.0.0.1:9022` and return `login`, `resolveOwner`, `claimInvitation`, `getBackend`, `complete` and `close` capabilities.
The login object must implement `begin` and `finish` using `createIdeaflowLogin` with the exact verified production issuer/client and callback.
The Noos integration uses `OperationalStore`, `StagingFileAssets` and callback-role `InvitedOwnerProvisioner`; `claimInvitation` is its guarded claim method and `resolveOwner` resolves the same verified issuer/subject mapping.
`getBackend` must revalidate active immutable owner/principal and publication access on every operation.
The operational API exposes only its scoped router, never the legacy generic graph query routes.
The returned `close` capability must stop its operational listener and graph driver on shutdown.
Scoped readers fetch at most eight observations concurrently, preserve every manifest ordinal and recheck the final live publication after all rows; they do not extend the existing 30-second per-request bound.
Archive asset publication waits for file and directory fsync; a paired cold restore rehearsal remains required before real data.
Read-only source mounts must contain locked dependencies supplied in the approved runtime image or exact checkouts; the packet does not download or install them.

## Private destinations and invitation recovery

Create the proposed root and each private state, runtime and backup directory with mode 700 only after target approval.
All private env, operator config, invitation bundle, audit receipts and snapshot files must use mode 600 under the operator UID/GID.
Run the helper as the private file-owning release operator, not as root.
The existing Noos operator's read-only `sudo -n docker info` route was verified; direct socket access is denied.
The helper uses noninteractive sudo only for Docker commands and preserves exactly `PILOT_UID`, `PILOT_GID`, `PILOT_NEO4J_IMAGE`, `PILOT_RUNTIME_IMAGE` and `PILOT_NGINX_IMAGE` for Compose.
It verifies daemon access before launching or stopping owned services; secret values remain in explicit private env files and never enter command arguments or the preserved environment allowlist.
Container user IDs are set explicitly from the local operator and no bind source can be automatically created by Compose.
Neo4j graph files must satisfy the private recovery permission checks; verify the approved image's file ownership/modes before enabling guest data.
`runtime.env`, `graph.env` and `operator.json` are proposed destinations, not files to populate automatically.
The recipe uses explicit `isolated-container` mode.
A dedicated frontend bridge contains only nginx and runtime; a separate internal backend bridge contains only runtime and graph.
Only nginx publishes host 443 to its unprivileged container port 8443, as the file-owning operator with all capabilities dropped.
The browser listens on 0.0.0.0:9367 inside its container with no published app port; operations stays on container loopback 9022 and Bolt uses exactly graph:7687 on the internal backend.
The default process mode remains host loopback; an arbitrary public browser/graph address is rejected.
The proposed persistent OpenAI destination is `runtime/runtime.env` and requires explicit destination confirmation before any key copy.
Synthetic testing can continue reading the existing M5 key in place; no model key belongs on a CI VM.
The runtime reads `IDEAFLOW_ISSUER`, `IDEAFLOW_CLIENT_ID`, `IDEAFLOW_CLIENT_SECRET`, `NOOS_PRIVATE_PASSWORD` and `OPENAI_API_KEY` from its explicit `runtime.env` only.
The proposed production issuer is `https://id.ideaflow.app/api/auth`; client registration and confidential secret delivery belong to the identity owner.
The callback is exactly `https://private.unlinked.ai/auth/callback/ideaflow`; the isolated container recipe uses browser 9367, operations on its own loopback 9022, and the dedicated internal graph at graph:7687.
Run it as the explicitly provisioned private host operator UID/GID recorded in the release manifest; no root database or operator invitation capability is passed through HTTP.
The Noos operator CLI owns invitation creation/replay/revocation and accepts a private config plus `NOOS_PROVISIONING_PASSWORD` without printing its secret.
Its `create --config PRIVATE.json --out NEW-PRIVATE.json` writes the mode-600, fsynced recovery bundle before the graph operation.
Retain that exact bundle under `invitations/operator-recovery.json`; never place its token or URL in a release receipt, shell history, CI output or proxy logs.
The offline operator capability never enters the browser runtime.

## Recovery and ingress

Compose owns only three distinctly named and labeled containers and two dedicated bridges; only ingress publishes HTTPS 443.
Graph and runtime have no published ports; nginx cannot join the internal graph bridge or access runtime loopback operations.
All services run as the private operator with all capabilities dropped; nginx temp paths and tmpfs ownership permit non-root startup with read-only TLS mounts.
If a separately owned maintenance-only ingress occupies 443, verify its exact saved ID/root/maintenance labels and stop it before starting the full recipe; retain its config/certificates for rollback.
Existing port-80 nginx, legacy Noos containers, shared graph, existing assets and synthetic fixture roots are not mounted or stopped.
Proxy request/error logging is disabled, so `/invite/<token>` and query strings cannot leak there.
Wrong Host headers and raw operations/asset/query paths are rejected; application session/CSRF/owner authorization remains the trusted product's responsibility.
`backup` requires all three owned containers stopped, pairs `neo4j-data`, `assets`, `identity-state`, `invitations` and `audit`, and captures the complete graph including bindings/principals/revocation fences.
`identity-state` stores any separately persisted identity adapter state; it must exist even when empty because identities are entirely in the graph.
Manifest and file digests, private modes and fsync are checked; retain the adjacent checksum in operator-controlled storage because a checksum is integrity evidence rather than an external signature.
Restore only creates a NEW sibling `-rehearsal-*` root, verifies every copied byte and never starts a graph, mounts the restored graph live or overwrites pilot/legacy storage.
The application writer must verify graph queries, source/owner/principal readback, receipts, blob references, counts and tombstones on that separately approved rehearsal before accepting recovery.
Rollback stops only labeled owned services and preserves all state, invitation bundles, source receipts and backups.
It invalidates ephemeral browser sessions and MCP signing keys through runtime stop; durable invitation/grant or provider-client revocation is a separate owner operation using the retained recovery bundle.
