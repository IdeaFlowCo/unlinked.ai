# Private pilot release packet

This packet prepares `unlinked-b3q`; it does not activate the proposed target or establish `unlinked-9a9` real acceptance.
`manifest.example.json` records proposed destinations and unapproved source heads, image digests, provider and DNS operations.
All-zero image digests are deliberately unusable proposals; replace them with individually reviewed dependency-complete images, never floating tags.
No dependencies are installed by this packet.

## Commands

```sh
python3 deploy/private-pilot/pilot.py plan
python3 deploy/private-pilot/checks.py
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
`preflight` requires all approved final source receipts, exact clean checkout heads, reviewed wiring digest, image approvals, existing mode-700 roots/directories and mode-600 inputs.
There is no implicit directory creation during deployment and no command to obtain a certificate, alter DNS, register a client, create an invitation or copy credentials.
The start command fails on occupied owned ports; services must be explicitly checked after start before any claim of availability.
Production client and identity operations remain with the identity owner; actual security/data operation authority must be recorded before setting approval fields.
Reversible non-provider preparation does not introduce a per-PR human gate.

## Missing runtime capability

The inspected product exports `startPrivatePilot({baseUrl, login, resolveOwner, claimInvitation, getBackend, complete, port, host, dataMode})`; its real-data mode is exactly `private_live`.
The repository does not provide a production composition module, private env, client registration or built deployment image.
The sole application writer must provide reviewed `/srv/unlinked-private-guest-pilot-20261001/runtime/wiring.mjs`, exporting `createPrivatePilotDependencies(options)`.
It must start the isolated operational service only at `127.0.0.1:9022` and return `login`, `resolveOwner`, `claimInvitation`, `getBackend`, `complete` and `close` capabilities.
The login object must implement `begin` and `finish` using `createIdeaflowLogin` with the exact verified production issuer/client and callback.
The Noos integration uses `OperationalStore`, `StagingFileAssets` and callback-role `InvitedOwnerProvisioner`; `claimInvitation` is its guarded claim method and `resolveOwner` resolves the same verified issuer/subject mapping.
`getBackend` must revalidate active immutable owner/principal and publication access on every operation.
The operational API exposes only its scoped router, never the legacy generic graph query routes.
The returned `close` capability must stop its operational listener and graph driver on shutdown.
This adapter is a real remaining app-writer dependency, not a claimed runnable implementation in the release packet.
Read-only source mounts must contain locked dependencies supplied in the approved runtime image or exact checkouts; the packet does not download or install them.

## Private destinations and invitation recovery

Create the proposed root and each private state, runtime and backup directory with mode 700 only after target approval.
All private env, operator config, invitation bundle, audit receipts and snapshot files must use mode 600 under the operator UID/GID.
Container user IDs are set explicitly from the local operator and no bind source can be automatically created by Compose.
Neo4j graph files must satisfy the private recovery permission checks; verify the approved image's file ownership/modes before enabling guest data.
`runtime.env`, `graph.env` and `operator.json` are proposed destinations, not files to populate automatically.
The proposed persistent OpenAI destination is `runtime/runtime.env` and requires explicit destination confirmation before any key copy.
Synthetic testing can continue reading the existing M5 key in place; no model key belongs on a CI VM.
The Noos operator CLI owns invitation creation/replay/revocation and accepts a private config plus `NOOS_PROVISIONING_PASSWORD` without printing its secret.
Its `create --config PRIVATE.json --out NEW-PRIVATE.json` writes the mode-600, fsynced recovery bundle before the graph operation.
Retain that exact bundle under `invitations/operator-recovery.json`; never place its token or URL in a release receipt, shell history, CI output or proxy logs.
The offline operator capability never enters the browser runtime.

## Recovery and ingress

Compose owns only three distinctly named and labeled containers; graph publishes loopback Bolt 9289, runtime binds browser 9367 and operations 9022 to loopback, and ingress alone listens publicly on HTTPS 443.
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
