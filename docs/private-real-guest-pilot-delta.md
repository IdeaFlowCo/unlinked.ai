# Real guest pilot delta - exact proposed operation, not activation

The default source runtime and :9367 provider fixture are synthetic only.
No guest archive may enter either fixture and no guest upload URL is verified.

## Dedicated stable target

Proposed rollback origin: https://private.unlinked.ai (HTTPS443).
Exact rollback callback: https://private.unlinked.ai/auth/callback/ideaflow. A separate canonical cutover packet may use `https://www.unlinked.ai` with callback `https://www.unlinked.ai/auth/callback/ideaflow` after provider, TLS and readiness gates.
Issuer: https://id.ideaflow.app/api/auth; a staged subject is never promoted/relabelled.
Read-only preflight found no DNS answer for private.unlinked.ai; unlinked.ai uses Name.com nameservers.
The proposed A record points only this new subdomain to the existing Noos GCP VM34.10.134.247, project lightsail-migration, us-central1-a, e2-standard-2.
The host has7936MiB RAM,5519MiB available,44GiB free disk and no swap in the observed preflight.
Existing HTTP routing is Docker noos_nginx on80; no listener on443 and no installed/active Caddy was observed.
Do not alter existing port80/nginx, Noos API or shared Neo4j containers.
A new dedicated TLS ingress on443 for this hostname is proposed, with exact Host validation and no catch-all proxy to existing services.
DNS/TLS/routing and runtime installation are approval operations; no change has been made.

## Runtime/data separation

Proposed new private owner-controlled root: /srv/unlinked-private-guest-pilot-20261001 (mode700).
It is separate from every synthetic staging root and existing Noos graph/data volume.
Subdirectories: runtime/ (reviewed source SHAs), neo4j-data/ (dedicated database), assets/ (700/600 private blobs), identity-state/ (separately persisted identity adapter state), invitations/ (operator recovery bundles), backups/ (paired private snapshots), and audit/ (non-token consent/identity provenance).
A dedicated1GiB Neo4j container uses only the internal backend bridge at `graph:7687`; the operational API binds runtime loopback9022, and browser/MCP binds only the unpublished runtime listener 9367 behind the new443 ingress.
The runtime container overlays only the root parent as an operator-owned mode700 tmpfs so Docker cannot synthesize a root-owned 755 parent; durable state remains in the explicit child binds for runtime, assets and audit, with graph, backups and invitations excluded from app mounts.
The graph entrypoint preserves `tini` and the pinned image startup script while applying `umask 077`, so newly created graph state uses private 700/600 modes; it does not chmod existing graph data.
No generic graph-query route, raw asset route or operational token is public.
The checked-in release packet is `deploy/private-pilot/`; `pilot.py` plans/preflights/starts/stops/backs up/restores only that exact root and labeled three-service composition, restores only to new canonical `backups/rehearsal-*` targets under the operator-owned mode-700 backup root, uses only the existing noninteractive `sudo -n docker` route for Docker operations, and preserves only the validated origin, UID/GID plus the three approved image variables for Compose.
`runtime.mjs` refuses to launch without reviewed mode600 wiring.
Open account signup is the proposed initial cohort path. The exact verified production issuer/subject resolves an existing active private owner or atomically creates one through the reviewed private signup capability before upload is enabled. The runtime must include the reviewed background import worker and Noos pending-job/job-history discovery before accepting real archives.
Every import/index/source/receipt/grant is keyed to that immutable owner UUID in the dedicated graph.
Prior legacy IDs/data remain unchanged and unlinked; no prior owner or data is imported implicitly.
Storage retains immutable originals and receipts for recovery. No automatic physical deletion is promised.
At pilot closure/guest withdrawal ingress and grants are disabled; any physical purge is a separately consented, owner-verified operation, including backups.
No new cloud instance, paid provider activation or credential purchase is proposed.
A durable private database/admin secret and registered OAuth client credentials require exact reviewed mode600 destinations; no files/resources are created by this plan.
The existing approved M5 model credential can be read in place over SSH for an isolated pilot, and final source testing can use an explicit mode600 non-symlink key file outside any checkout through `UNLINKED_PRIVATE_AI_TEST_KEY_FILE`.
Any persistent deployment copy requires its own exact destination confirmation; the proposed packet records `runtime/runtime.env` as the destination but blocks activation until that confirmation exists.

## Open account/owner creation route

The production Id provider's supported existing Google sign-in is the candidate identity route.
If a guest has no Ideaflow ID account, Google-based creation requires the explicit production account decision; native password signup/reset must not be advertised while deployment/mail gates remain unresolved.
The app uses confidential code+PKCE/state/nonce/signed ID tokens, `prompt=login` reauthentication and an Unlinked confirmation screen for the returned verified account.
Its resolver returns only an established exact issuer/subject mapping; if none exists, the trusted signup capability creates a fresh Unlinked UUID, obtains/provisions its independently verified Noos principal through the approved identity adapter, and binds the verified production tuple in one transaction with a provenance receipt.
An unknown subject cannot select an owner from email, archive, LinkedIn slug, legacy UUID or existing Noos account.
The runtime composition uses the Noos callback-role `InvitedOwnerProvisioner` for browser signup and exact issuer/subject readback; no operator invitation capability is exposed over HTTP.
The existing Noos auth/main/deployed no-passwordHash divergence must not be used as an auto-claim or invented Noos-principal proof.
No browser-callable binding endpoint or automatic legacy merge is added.
An actual existing legacy account still needs independent supported legacy-owner proof and a separate live-bind decision.

## Access, consent and delegation

Public ingress exposes only sign-in/account setup; all receipts/uploads/search are session/CSRF/same-origin and exact owner gated.
Ingress uses `Referrer-Policy: strict-origin` so provider navigation keeps the Origin header without sending sensitive paths in referrers. Invitation mode, when used, permits only the exact HTTPS identity provider in CSP `form-action`; subsequent private forms remain self-only.
Secure HttpOnly SameSite cookies contain random fifteen-minute session IDs, not identity/access tokens.
One combined upload disclosure/action authorizes private archive retention and bounded OpenAI processing of queries and observed name/company/position/date fields for browser and search-only scoped agent searches; no separate production consent checkbox is required. Immutable import/source receipts retain versioned consent. Older imports without this disclosure fail closed for search and grants; replay never upgrades prior consent.
Agent setup is a separate explicit owner action for `unlinked_search_network` across all current and future owner imports until revoked, with a distinct tool audience, durable grant record and live revocation/publication checks.
Operational/provider tokens and raw recovery APIs are never delegated to the agent.
Scoped publication reads fetch at most eight observations concurrently, preserve manifest order and recheck the live publication fence after all rows so a deletion/revocation race wins.
Actual real-user delegation must receive its own reviewed approval; synthetic stage issuer behavior is not production provider delegated consent.

## Proof and activation order

1. Finish reviewed Noos/Unlinked source/draft CI at exact heads; retain PR45/46 pending approval dependencies.
2. Complete the production provider owner's revision/schema/admin/client preflight and reviewed exact confidential client manifest for this443 origin.
3. Present DNS/TLS/private runtime/data/secret destinations plus production client/account/bind/guest-data/delegation operations and rollback together to Firstmate for the actual approval decisions.
4. After approval only, create the separate target and verify anonymous/cross-owner denial, public443/callback Host/Origin behavior, privacy boundaries and the M5 browser route.
5. Complete a signed-in disposable end-to-end browser rehearsal on the SAME reviewed runtime/code; paired graph/blob restore must preserve all1,001 rows, original bytes, source IDs and tombstones.
6. Verify the guest's actual production sign-in/intended account and approved NEW ownership/principal proof; read back both sides, snapshot ACLs and backups.
7. Enable only this owner, obtain the guest's upload action disclosure, upload the real archive, verify prompt `/profile` return, background continuation after navigation/close, profile-first display, Settings receipts, accepted/indexed counts/replay, owner-wide search and account MCP parity.

Rollback stops only the three labeled new ingress/runtime/graph containers, preserves private originals/owner UUID/backups, and leaves durable grant/client revocation to the separately approved identity-owner operation.
Do not blindly delete or rebind live identity/owner data.
Restore is a quiesced paired graph/blob operation with integrity manifest, bindings, journal rows before final publication fences, and preserved tombstones; rehearsal targets are new canonical `backups/rehearsal-*` directories and are never pilot or legacy storage.
Synthetic paired restore has been proven; operational backup scheduling/ownership, durable directory fsync, real identity/principal proof,443 route and actual browser acceptance remain unproven release gates.

Private container activation publishes only non-root ingress 443:8443.
The browser wildcard listener is confined to the dedicated frontend bridge with no published app port, and the graph is confined to a separate internal backend bridge with no published Bolt port.
`root-mount-check.py` is the bounded Docker proof for the runtime parent tmpfs; it uses generated fixtures only and does not start the graph, expose ports or read provider credentials.
Operational/raw asset services remain runtime loopback; the owner and delegated tool checks continue to apply before every read/write.
