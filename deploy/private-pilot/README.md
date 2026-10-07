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
Before provisioning or exposing HTTP readiness, it waits for the configured Bolt driver to report graph connectivity with the same bounded driver timeouts; shared mode also requires the checkpoint described below.
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
The base recipe uses explicit `isolated-container` mode; the [shared graph cutover](#verified-shared-noos-graph-cutover) owns its opt-in alternative.
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

The base Compose recipe owns only three distinctly named and labeled containers and two dedicated bridges; only ingress publishes HTTPS 443.
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
In isolated-container mode, `backup` requires all three owned containers stopped, pairs `neo4j-data`, `assets`, `identity-state`, `invitations` and `audit`, and captures the complete graph including bindings/principals/revocation fences.
`identity-state` stores any separately persisted identity adapter state; it must exist even when empty because identities are entirely in the graph.
Manifest and file digests, private modes and fsync are checked; retain the adjacent checksum in operator-controlled storage because a checksum is integrity evidence rather than an external signature.
Restore only creates a NEW uniquely named `backups/rehearsal-*` directory under the existing operator-owned mode-700 backup root, verifies every copied byte and never starts a graph, mounts the restored graph live or overwrites pilot/legacy storage.
The target must be canonical, absent and without symlinks; parent ownership/mode are checked and atomic creation refuses competing writers. No sudo or /srv write permission is needed.
The application writer must verify graph queries, source/owner/principal readback, receipts, blob references, counts and tombstones on that separately approved rehearsal before accepting recovery.
Rollback stops only labeled owned services and preserves all state, invitation bundles, source receipts and backups.
Runtime stop invalidates in-memory login transactions and ephemeral invited MCP signing keys. Session persistence is owned by [Durable Sessions](../../docs/durable-sessions.md); account grant signing-secret requirements are owned by [the account launch contract](ACCOUNT-LAUNCH.md). Durable invitation/grant or provider-client revocation is a separate owner operation using the retained recovery bundle.

## Verified shared Noos graph cutover

`shared-noos.yaml` is an explicit opt-in override (Docker Compose >=2.24.4), applied after lossless graph migration and verification. The runtime alone joins the existing external `noos_default` network and uses exactly `bolt://noos_neo4j:7687`; ingress keeps its frontend network, ports and private host rules. Base loopback/isolated-container modes are unchanged. `pilot.py` still accepts only isolated-container manifests and uses only the base Compose file; it does not launch the shared override or back up the active shared database. Its cold-pair backup of retained `neo4j-data` is not a current shared-graph backup. Use the scoped export/recovery commands below with retained assets for shared recovery, and never use the base `start` command to restart an old writer after cutover.

Set `PILOT_SHARED_GRAPH_MIGRATION_ID` and `PILOT_SHARED_GRAPH_MANIFEST_SHA256` to the reviewed migration receipt. Before initializing any source store/schema, composition requires exactly one `UnlinkedGraphMigration` node with matching `id`, `manifestHash`, and `status: verified`. Missing, mismatched or unverified receipts fail startup and close the graph driver. The verified checkpoint is locked and its first `activatedAt` is durably recorded before any initialization; pre-activation destructive rollback then refuses this receipt, including on subsequent restarts. The runtime's protected `NOOS_PRIVATE_PASSWORD` must authenticate the shared target; no credentials are sent to browsers. Before changing runtime credentials or origin, check the [account grant signing requirements](ACCOUNT-LAUNCH.md) to preserve existing grants. Keep generic Cypher access on the target operators-only and closed by default; the composition does not configure the main Noos HTTP server.

```sh
docker compose -f compose.yaml -f shared-noos.yaml config --no-env-resolution
docker compose -f compose.yaml -f shared-noos.yaml up -d runtime ingress
```

Pause Unlinked writes and its background workers before the stable export; keep the source graph as retained read-only rollback data. The override makes `graph` profile-only (`rollback-graph`) rather than automatically launching it. It does not stop an already running source graph. Do not run old and shared application writers simultaneously. Do not use `--remove-orphans` or delete the old graph/data during this cutover.

Verify owner/identity/resource/asset parity and negative generic Noos exposure before reopening writes; resume background dispatch once. A rollback after target-side writes requires reconciling those writes before switching back. A verified migration receipt proves import integrity, not blanket authorization to expose private profiles through generic Noos routes.

The operator-only `graph-migration-cli.mjs` supports a bounded source export, import, verification, pre-activation rollback, and post-activation reverse recovery. Its authoritative `LABELS` allowlist in `graph-migration.mjs` covers the reviewed populated domains and the currently empty email/invitation schema domains. Only single-label records and NODE UNIQUENESS/RANGE schema are supported; native property types and empty-domain constraints are preserved. Initial export rejects unknown labels, unsupported schema and all relationships; shared export applies the scoped rules below. Import rejects existing domain records outside its own retry ledger and conflicting domain schema or schema names; this tool does not flatten relationships or silently drop empty-domain constraints.

Supply `MIGRATION_NEO4J_MODULE_ROOT` as an absolute path to an existing reviewed dependency checkout containing `neo4j-driver` (the cross-version fixture uses 5.28.3), and `MIGRATION_NEO4J_URI`, `MIGRATION_NEO4J_USER`, and `MIGRATION_NEO4J_PASSWORD` through the protected operator environment. The CLI never accepts or prints credentials in arguments. Export creates a new mode-600 file exclusively; snapshots contain private data and must stay outside git and release logs. Review the count/hash-only output and retain the original source and assets.

```sh
node deploy/private-pilot/graph-migration-cli.mjs export /private/original-source.json
# Change the protected connection environment to the shared target.
node deploy/private-pilot/graph-migration-cli.mjs import /private/original-source.json reviewed-cutover-id
node deploy/private-pilot/graph-migration-cli.mjs verify /private/original-source.json reviewed-cutover-id
# Only before runtime activation:
node deploy/private-pilot/graph-migration-cli.mjs rollback /private/original-source.json reviewed-cutover-id
```

For recovery after activation, stop Unlinked application writers and workers first. Keep them stopped throughout the shared export, restore, verification and connection switch. Use `export-shared` against the shared graph, with the original verified receipt ID. It exports every current approved domain record, including later additions, edits, tombstones and the effect of deletions. It excludes unrelated Noos nodes/schema and migration metadata. It ignores only valid `UNLINKED_IMPORTED_RECORD` edges from a single-label migration record belonging to that receipt into an approved single-label record; all other relationships touching the domain fail closed.

```sh
node deploy/private-pilot/graph-migration-cli.mjs export-shared /private/postactivation-recovery.json reviewed-cutover-id
# Change the protected connection environment to a NEW isolated graph.
node deploy/private-pilot/graph-migration-cli.mjs restore-isolated /private/postactivation-recovery.json reviewed-recovery-id
node deploy/private-pilot/graph-migration-cli.mjs verify /private/postactivation-recovery.json reviewed-recovery-id
```

`restore-isolated` refuses unrelated graph records or relationships, and allows a retry only for that recovery run's ledger/domain. Recovery receipts are protected from destructive rollback before any copy writes, including partial retries, because the normal isolated launcher does not activate shared checkpoints. It does not overwrite the retained original source. Keep the existing asset roots unchanged, verify owner/session/identity/resource and asset parity, then switch the single application writer to the fresh isolated graph. Never replay the old pre-cutover snapshot over a graph containing later writes. Neither reverse export nor restore deletes or mutates the shared source; retain both graphs until independent recovery verification is complete.

The `graph-migration` GitHub Actions job runs the actual Neo4j 5.26→5.15 fixture, including activation and reverse recovery, on disposable hosted services. The regular source test command skips those destructive fixtures unless `UNLINKED_MIGRATION_TEST=isolated-fixture` and the explicit driver checkout are supplied. The fixture verifies both server versions before resetting data; never point the fixture ports at real stores.

For worktree-local disposable databases, set `MIGRATION_TEST_SOURCE_URI` and `MIGRATION_TEST_TARGET_URI` to their Bolt endpoints (defaults: ports 8967 and 8968). The CLI check uses the same target override. Keep database data and logs inside the worktree when an active workspace boundary requires it; version checks alone do not prove a database is disposable.

Standalone `verify` requires the exact single-label checkpoint ID, manifest hash and `verified` status. Internal import verification permits its locked `copying` checkpoint only before final publication. Verification checks complete record-ledger ownership and hashes as well as node properties/counts, scoped schema and every relationship touching the imported domain, owned ledger or checkpoint; unexpected edges cannot be certified by a retry. Shared export also rejects unreviewed `Unlinked*`/`Operational*` node labels and empty-domain schema rather than silently excluding future private writes. The two explicit migration metadata labels remain excluded from recovery payloads.
