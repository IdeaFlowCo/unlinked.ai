# Isolated private Noos pilot source

These default-off factories stack on draft PR11 and require the separately isolated Noos follow-up stacked on PR45.
They are never mounted by production Next.js or production Noos.
The public import entry still shows its availability gate.

## Publication and scale

Owner/archive/parser/path/hash/row IDs and original bytes retain PR11 provenance.
Uploaded/parsing updates each add an immutable revision receipt.
Immutable batches hold at most 200 rows and one ordinal chunk manifest.
Each accepted row is indexed by its owner-derived resource ID in the isolated Noos observation index (`observation-v1`), not a vector index.
Graph resources remain bounded to 64 KiB and transactions to 600 resources/32 MiB.
Oversized observations use digest-verified private assets plus graph provenance metadata.
Source receipts store accurate rejection counts; original bytes and parser version retain the exact rejected records for recovery.
One final CAS-fenced transaction publishes the current job, immutable receipt, source receipts and all ordered chunk references together.
Tools require this live terminal fence and never enumerate provisional rows.
Exact chunk replay is immutable; interrupted writers reconstruct the deterministic journal.
Lost final responses return the terminal receipt; concurrent publishers may receive a revision conflict and retry.
A tombstoned publication cannot be reopened by a delayed writer.
Indexed counts appear only at final publication and equal all accepted observations.
Rejected/malformed records remain reported and may make an import partial.

There is no 500-row truncation or rejection gate.
The parser retains 100,000-record, 20 MiB archive, 8 MiB file, 40 MiB expanded and 200-file bounds.
The final manifest references bounded source/chunk IDs rather than every row.
Older failed support-limit receipts remain immutable; restaging them needs an explicit publication-version migration.

## Scoped search and browser

AI search uses the same live owner-scoped publication as MCP.
Every connection is considered in contexts of at most 200 bounded name/company/position/date observations, followed by bounded reduction of ranked IDs.
OpenAI requests use store:false, strict ID-only structured results and a 30-second per-call timeout.
Returned identity, fields and provenance come from stored rows.
Publication checks after delayed model work deny deleted/changed imports.
This is query-time AI ranking over a private observation index, with no shared people database or embedding completeness claim.
At the parser maximum many model calls/resource reads are required; the 1,001-contact receipt is the acceptance target, not a 100,000-record latency/cost claim.

The isolated OIDC browser factory uses confidential code flow, client_secret_basic, PKCE S256, nonce/state, signed ID tokens and account choice.
Only verified issuer plus opaque subject enters the trusted immutable existing/new owner mapping.
Archive email/profile fields never select or rebind ownership.
Unknown/conflicting ownership fails closed before upload.
Bounded random sessions use Secure/HttpOnly/SameSite cookies and disappear on restart.
Same-origin requests and CSRF protect mutations; guest storage consent is required at upload and separate OpenAI data consent at search.
Receipt/replay and one-action scoped setup forms are implemented.
Setup downloads a fifteen-minute search-only grant for exactly one import; raw archive access is excluded.
The separate signed tool audience uses a durable owner-private Noos grant record, live expiry/publication/revocation checks, and ephemeral signing keys that invalidate grants on restart.
Operational bearers and provider ID tokens never become agent credentials.

The explicit standalone runtime binds loopback only.
Reserved tailnet origin is https://m4-mini.tailb2a35c.ts.net:9367 and callback /auth/callback/ideaflow.
This reservation is not a running or verified upload URL.
Actual provider client/redirect acceptance and immutable legacy/new-owner provisioning remain release gates.
Production provider granular delegation is not assumed or enabled.

## Assets, recovery and credentials

ZIP bytes remain private assets behind a replaceable Noos storage interface, not graph properties.
The explicit operator-controlled filesystem root uses modes 700/600, owner-hashed directories, hash-addressed immutable writes, digest verification and no-follow reads.
Raw recovery authorizes the historical owner before fetching one bounded blob, without graph fan-out.
Publication rollback retains private originals/receipts and denies agent tools.
Physical retention/deletion, paired graph/blob backups, directory-fsync durability, restore rehearsal and historical writer fencing remain release/cutover gates.
No production graph or historical personal data is used in tests.

Existing OpenAI credential reuse was explicitly approved.
The staging remote completion bridge reads the verified M5 credential in place over authenticated SSH, never copies/persists it locally or exposes it in logs.
A bounded synthetic Responses request returned HTTP 200.
Any new persistent secret destination requires confirmation before copying; none is configured here.

## Verification

Install locked MCP dependencies and run the private AI/browser/grant/hosted/scope test files with node --test.
Signed disposable OIDC responses prove client validation, not an actual provider login.
Set UNLINKED_NOOS_TEST_CHECKOUT, NOOS_OPERATIONAL_EXTRA_TEST, UNLINKED_NOOS_RECEIPT and NOOS_SIGNED_TEST_EVIDENCE to isolated external-SSD paths, then run the Noos checkout's node scripts/test-operational.mjs.
Only explicitly authorized UNLINKED_PRIVATE_AI_REMOTE=1 enables existing-key synthetic model calls; ordinary CI has no provider call.
The runner owns one capped 1 GiB disposable Neo4j and cleans it in finally.
The real 1,001-contact ZIP harness requires accepted=indexed=MCP-readable count and, with the model enabled, considers every connection including the last contact.
Do not claim a live pilot until real provider/browser, storage/recovery and review gates pass.
