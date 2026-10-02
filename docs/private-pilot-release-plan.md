# Reviewable isolated private pilot target

No guest upload URL is verified. The synthetic rehearsal origin remains `https://m4-mini.tailb2a35c.ts.net:9367`; callback is `/auth/callback/ideaflow`.
The source browser is default-off and explicitly marks its default synthetic mode; synthetic mode requires an additional confirmation that the archive contains only test data.
Do not upload a real guest archive to that rehearsal.
The proposed real guest deployment packet is `deploy/private-pilot/`; it targets the rollback `https://private.unlinked.ai` origin only after its manifest gates are satisfied, with a separate canonical-host packet for `https://www.unlinked.ai` documented in `deploy/private-pilot/CANONICAL-HOST.md`.

## Source and approval dependencies

Unlinked stacks on preserved draft PR11; Noos stacks on preserved PR45 and includes only PR46's exact reviewed GCP source-CI workflow.
The Noos follow-up cannot land PR46's still-pending workflow by another merge route.
No merge or production deployment is authorized by these source changes.
The identity owner is preparing the separate PR7 provider rehearsal and exact confidential client registration manifest.
Provider runtime source, issuer, isolated database/admin, backup/restore and client metadata must be verified before the security-sensitive client registration decision.
Production issuer/client/cohort changes and live identity bindings remain separate approval gates.
Noos login/register routes and their deployed no-passwordHash guard are untouched; known main/deployed divergence must be reconciled before any release involving those routes.

## Proposed runtime and storage targets

A new operator-controlled mode-700 synthetic rehearsal root is proposed at `/Volumes/External_SSD/code-overflow/unlinked-private-pilot-20261001/`.
It has not been created or activated.
A dedicated Neo4j container would use `neo4j-data/` under this root, loopback-only Bolt port 9288, a 1 GiB memory cap and a dedicated database/admin credential.
The isolated operational HTTP service would bind only `127.0.0.1:9021`; the browser/MCP service binds `127.0.0.1:9367` and receives tailnet-only HTTPS through Tailscale Serve.
These ports were available at preparation; recheck immediately before launch.
The separate real guest packet fixes its root at `/srv/unlinked-private-guest-pilot-20261001`; in explicit isolated-container mode it keeps graph Bolt on internal service `graph:7687`, operations on runtime loopback 9022, browser on the unpublished runtime listener 9367 and HTTPS ingress on 443.
Inside the runtime container, that root parent is an ephemeral mode-700 tmpfs owned by the explicit operator UID/GID; only the `runtime/`, `assets/` and `audit/` child mounts are bound into the app, preserving their read-only/write boundaries and preventing a Docker-created root-owned 755 parent from bypassing the privacy guard.
Its helper runs as the private file-owning release operator and uses only the existing noninteractive `sudo -n docker` route for Docker operations, preserving only the manifest-derived origin, UID/GID and three image variables needed by Compose.
The graph service keeps the pinned Neo4j image startup path and `tini`, but sets `umask 077` before launch so newly created graph directories/files satisfy the private 700/600 recovery policy.
The operational service must use the dedicated driver/database and must never mount the legacy generic query API.
Private archive/source/oversized-observation bytes use `assets/`, with owner-hashed paths, immutable SHA-256 names and modes 700/600.
Paired quiesced backups use `backups/` and include graph resources, owner/identity bindings, every referenced blob, integrity manifest and tombstones; restore rehearsals must use a new canonical `backups/rehearsal-*` target under that operator-owned mode-700 backup root.
Existing storage backends remain replaceable; binary ZIP bytes are not graph properties.
The model bridge reads the existing M5 credential in place over SSH for the synthetic rehearsal, or a final test may opt into an explicit mode-600 key file outside all checkouts through `UNLINKED_PRIVATE_AI_TEST_KEY_FILE`.
Any new persistent credential copy or actual pilot resource creation must use its reviewed exact target/approval, not this proposal alone; the real guest packet proposes `runtime/runtime.env` as the OpenAI destination and keeps it blocked until explicitly confirmed.

## Identity and private runtime wiring

The client uses code flow, PKCE S256, state/nonce, issuer-discovered JWKS ID-token verification, `prompt=login` reauthentication and explicit post-callback account confirmation for invited owner creation, with scopes `openid profile email` and client_secret_basic.
The exact issuer comes from the verified isolated provider rehearsal, never a guessed production URL.
The identity owner's approved private registration output is consumed in place; do not print or copy client secrets into reports.
The callback calls only the read-only exact `(issuer,opaque subject)` resolver.
An offline administrative bind transaction is permitted for a fresh synthetic UUID/Noos user after a verified disposable callback; provenance, conflict checks, readback and rollback must be recorded.
No browser binding endpoint or email/profile/archive auto-link exists.
A real legacy owner requires independent supported legacy-owner proof in addition to verified Ideaflow identity and explicit live-bind approval.
The paused legacy Supabase route is not such proof.

`startPrivatePilot` needs reviewed `login`, `resolveOwner`, `getBackend`, `complete`, and `baseUrl` configuration plus either invited `claimInvitation` or open-account `signup` with an account-grant key. Invitation-capable `login` must expose the exact HTTPS authorization origin for the landing-page CSP.
`mcp-server/private-composition.mjs` supplies the real process-only factory for the deployment launcher. It loads only compiled Noos operational modules from the dedicated private checkout, waits for graph connectivity before provisioning, exposes callback-role invitation claiming and open-account signup, starts the singleton background import worker, and mints internal operations bearers only after owner/principal revalidation. It requires Noos pending-job and owner job-history methods and fails startup if those methods are absent.
`getBackend` rechecks the immutable owner UUID/Noos user binding and returns an owner-specific private operational adapter; arbitrary browser fields cannot select it.
MCP uses independent tool audiences and durable Noos grant records. Invited setup is scoped to exactly one import and short-lived; open-account setup is scoped to the owner network, same-owner sanitized recovered Connections observations and, for new shared People grants, the published professional index. It persists until revoked or signing-secret replacement, excludes recovered original files, and exposes `unlinked_search_network` plus `unlinked_search_everyone`; older single-tool grants remain owner-network only.
Noos operational tokens and provider tokens never enter the download.
Revocation/deletion is checked live, and ephemeral stage signing keys revoke all delegated grants on runtime restart.

## Acceptance sequence and rollback

1. Complete Noos then Unlinked no-mistakes, preserve draft state, actual GCP CI checks and exact final head receipts.
2. Verify the approved isolated provider/client and callback against the reviewed synthetic identity; bind its new synthetic owner offline and test a second subject's denial.
3. Start the distinct reviewed synthetic operational/runtime/assets target; take a paired backup, restore to a new canonical `backups/rehearsal-*` target and revalidate all published rows, original bytes and tombstones.
4. Through the actual browser, verify Origin-preserving `strict-origin` navigation, provider-only invitation form CSP where invitation mode is used, sign-in/account confirmation or open signup, action-disclosed 1,001-contact archive upload, `/profile` redirect after durable staging, background continuation after browser close/restart, Settings receipts/progress, accepted=indexed parity, all-contact AI search and one-action search-only MCP setup.
5. Verify HTTPS from the M5 before sharing a URL. Report it explicitly as synthetic rehearsal unless a distinct isolated real-data target/live-bind decision has passed.
6. Only a separately reviewed real-data pilot may accept the guest's archive, with the guest's combined upload consent to private retention and bounded OpenAI processing. Do not switch the synthetic fixture into a real-data cohort implicitly.

Rollback stops the owned browser/operational services, removes only their Tailscale Serve port for the synthetic rehearsal, preserves private data/receipts/backups, and invalidates ephemeral grants.
The real guest packet rollback stops only its three labeled containers and preserves state, source receipts, invitation bundles and backups; provider client/grant revocation remains a separate owner operation.
Publication rollback is an irreversible tombstone for that publication; it retains private originals and denies tools.
A quiesced paired restore must restore journal rows before final publication fences and preserve owner mappings, source IDs, immutable receipt history and grant/publication tombstones.
The synthetic harness rehearses this pair; power-loss/directory-fsync durability, operational backup ownership/retention and historical live-writer fencing remain separate release evidence.

The private container recipe uses a frontend bridge for nginx/runtime and a separate internal runtime/graph bridge.
Only non-root nginx publishes 443 to container 8443; neither app nor graph has a published port, and operations remains container loopback.
The runtime's private parent tmpfs is part of that recipe; graph, backups and invitation trees are not broadly mounted into the app.
The process default remains host loopback; exact isolated-container mode and private service addresses must be explicitly selected.

## Recovered account confirmation

The canonical runtime may privately seed the hash-only manifest for all 81 recovered accounts after the exact recovered public profile revision is verified.
This creates no owner or subject binding.
On first matching authenticated Ideaflow sign-in, `/legacy-account` asks “This looks like your old Unlinked account. Continue?”
Only the server-held signed issuer/subject/email and current owner tuple authorize the CSRF-protected confirmation; typed or uploaded email has no authority.
For this prototype, signed Ideaflow email is treated as verified, including matches to the 29 legacy email-provider-only accounts.
A second subject cannot take an already-linked profile, and each owner/user can link only one legacy profile.
Confirmation receipts replay, while operator revocation permanently fences the link without deleting the existing owner, imports, or immutable recovered public source.
The linked own profile falls back to the recovered professional profile until an archive profile replaces its display; public member projection reuses the same legacy profile ID.
The original recovered publication is immutable, and overlays disappear after link/source revocation.

The legacy Storage recovery lane is separate from the hash-only account manifest: an offline operator publishes exact original-object coverage plus sanitized professional assets into a private immutable Noos manifest after all asset readbacks pass.
Only the active owner with this same confirmed recovered profile can list or download its original files under Settings; agent grants, public People, Everyone search and generic graph access cannot read them.
Sanitized recovered Connections observations join only that owner's network search with live owner/link/fence rechecks.

Operator preparation uses `createLegacyAccountManifest` with the exact mode-600 private inventory, then pipes its hash-only JSON to `node mcp-server/legacy-account-operator.mjs seed` in the owned isolated backend container.
The helper requires all 81 profile anchors in the published recovered source and reports only count/hash/time; never send the inventory or graph/provider credentials in argv or public logs.
Scoped rollback is `node mcp-server/legacy-account-operator.mjs revoke <profileId> <receiptId>` with the exact confirmed receipt.
No live seed/link or personal-browser confirmation is implied by source tests; exact-head Noos graph CI and guarded paired rollout remain required.

## Known connection paths

Signed GET `/api/my-connections?degree=1|2&q=&cursor=` and scoped `unlinked_search_network` with optional degree/cursor derive only recorded directed edges from the confirmed legacy profile.
The natural query "my second-degree connections" selects degree 2; ordinary owner-network AI queries retain their current behavior.
Both endpoints at both hops must exist in the current complete public professional snapshot.
Second-degree results exclude self/direct contacts, preserve a deterministic witnessed path/source revision, and paginate at 100.
No linked graph anchor returns an explicit unavailable state; uploaded names/email/URLs never invent a member binding or a second-degree edge.
Publication/link/grant revocation is rechecked before response.
Ideaflow cross-app subject delegation remains a separate auth adapter; unrelated service bearers are not forwarded.
