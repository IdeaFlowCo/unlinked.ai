# Real guest pilot delta - exact proposed operation, not activation

The default source runtime and :9367 provider fixture are synthetic only.
No guest archive may enter either fixture and no guest upload URL is verified.

## Dedicated stable target

Proposed origin: https://private.unlinked.ai (HTTPS443).
Exact callback: https://private.unlinked.ai/auth/callback/ideaflow.
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
Subdirectories: runtime/ (reviewed source SHAs), neo4j-data/ (dedicated database), assets/ (700/600 private blobs), backups/ (paired private snapshots), and audit/ (non-token consent/identity provenance).
A dedicated1GiB Neo4j container uses loopback Bolt9289; operational API binds loopback9022; browser/MCP binds loopback9367 behind the new443 ingress.
No generic graph-query route, raw asset route or operational token is public.
One invited guest/new owner is the initial cohort; its exact verified production subject is allowlisted before upload can be enabled.
Every import/index/source/receipt/grant is keyed to that immutable owner UUID in the dedicated graph.
Prior legacy IDs/data remain unchanged and unlinked; no prior owner or data is imported implicitly.
Storage retains immutable originals and receipts for recovery. No automatic physical deletion is promised.
At pilot closure/guest withdrawal ingress and grants are disabled; any physical purge is a separately consented, owner-verified operation, including backups.
No new cloud instance, paid provider activation or credential purchase is proposed.
A durable private database/admin secret and registered OAuth client credentials require exact reviewed mode600 destinations; no files/resources are created by this plan.
The existing approved M5 model credential can be read in place over SSH for an isolated pilot; any persistent deployment copy requires its own exact destination confirmation.

## NEW guest account/owner creation route

The production Id provider's supported existing Google sign-in is the candidate identity route.
If the invited guest has no Ideaflow ID account, Google-based creation/cohort invitation requires the explicit production account decision; native signup/reset must not be advertised while deployment/mail gates remain unresolved.
The app uses confidential code+PKCE/state/nonce/signed ID tokens and account choice.
Its read-only resolver returns only an established exact issuer/subject mapping.
An unknown subject cannot upload and receives the setup/recovery gate; it never auto-claims an email, archive, LinkedIn slug, legacy UUID or existing Noos account.
For a NEW private account, the reviewed offline operation generates a fresh Unlinked UUID, obtains/provisions its independently verified Noos principal through the approved identity adapter, and binds the verified production tuple in one transaction with a provenance receipt.
The existing Noos auth/main/deployed no-passwordHash divergence must not be used as an auto-claim or invented Noos-principal proof.
The captain's new-owner/bind decision and the guest's explicit new-account intent must be recorded before this operation.
No browser-callable binding endpoint or automatic legacy merge is added.
An actual existing legacy account still needs independent supported legacy-owner proof and a separate live-bind decision.

## Access, consent and delegation

Public ingress exposes only sign-in/account setup; all receipts/uploads/search are session/CSRF/same-origin and exact invited-owner gated.
Secure HttpOnly SameSite cookies contain random fifteen-minute session IDs, not identity/access tokens.
Upload requires guest consent to private archive retention; AI search separately requires consent to send bounded observed name/company/position/date fields to OpenAI.
Agent setup is a separate explicit owner action, exactly one import and only search, with distinct tool audience, fifteen-minute expiry, durable grant record and live revocation/publication checks.
Operational/provider tokens and raw recovery APIs are never delegated to the agent.
Actual real-user delegation must receive its own reviewed approval; synthetic stage issuer behavior is not production provider delegated consent.

## Proof and activation order

1. Finish reviewed Noos/Unlinked source/draft CI at exact heads; retain PR45/46 pending approval dependencies.
2. Complete the production provider owner's revision/schema/admin/client preflight and reviewed exact confidential client manifest for this443 origin.
3. Present DNS/TLS/private runtime/data/secret destinations plus production client/account/bind/guest-data/delegation operations and rollback together to Firstmate for the actual approval decisions.
4. After approval only, create the separate target and verify anonymous/cross-owner denial, public443/callback Host/Origin behavior, privacy boundaries and the M5 browser route.
5. Complete a signed-in disposable end-to-end browser rehearsal on the SAME reviewed runtime/code; paired graph/blob restore must preserve all1,001 rows, original bytes, source IDs and tombstones.
6. Verify the invited guest's actual production sign-in/intended account and approved NEW ownership/principal proof; bind offline, read back both sides, snapshot ACLs and backups.
7. Enable only this owner, obtain guest archive/AI consent, upload the real archive, verify accepted/indexed counts/replay, search and scoped MCP parity.

Rollback disables only the new ingress/runtime, revokes its grants/client as specifically approved, and preserves private originals/owner UUID/backups.
Do not blindly delete or rebind live identity/owner data.
Restore is a quiesced paired graph/blob operation with integrity manifest, bindings, journal rows before final publication fences, and preserved tombstones.
Synthetic paired restore has been proven; operational backup scheduling/ownership, durable directory fsync, real identity/principal proof,443 route and actual browser acceptance remain unproven release gates.
