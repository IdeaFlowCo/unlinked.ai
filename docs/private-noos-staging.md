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
Parser limits remain unchanged; the authoritative bounds are `LIMITS` in `src/utils/private-import/archive.mjs`, as described in the [parser contract](private-archive-import.md#parser-and-receipts).
The final manifest references bounded source/chunk IDs rather than every row.
Older failed support-limit receipts remain immutable; restaging them needs an explicit publication-version migration.

## Scoped search and browser

AI search uses the same live owner-scoped publication as MCP.
Every connection is considered in contexts of at most 200 bounded name/company/position/date observations, followed by bounded reduction of ranked IDs.
OpenAI requests use store:false, strict known-ID structured results and a 30-second provider timeout. Incomplete/refused responses and invalid results fail closed. Caller cancellation propagates through row reads and completion; the SSH completion bridge also bounds the local operation to 45 seconds.
Returned identity, fields and provenance come from stored rows.
Publication checks after delayed model work deny deleted/changed imports.
This is query-time AI ranking over a private observation index, with no shared people database or embedding completeness claim.
At the parser maximum many model calls/resource reads are required; the 1,001-contact receipt is the acceptance target, not a 100,000-record latency/cost claim.

The isolated OIDC browser factory uses confidential code flow, client_secret_basic, PKCE S256, nonce/state and signed ID tokens. Invited-owner mode uses fresh-provider authentication with `prompt=login` and explicit in-browser account confirmation before invitation claim. Open-account mode resolves the exact issuer/subject to an existing owner or calls the trusted signup capability to create one; authenticated email is display-only and never merges owners.
Only verified issuer plus opaque subject enters the trusted immutable existing/new owner mapping.
Archive email/profile fields never select or rebind ownership.
Unknown/conflicting ownership fails closed before upload.
Bounded random sessions use Secure/HttpOnly/SameSite cookies and disappear on restart.
Same-origin requests and CSRF protect mutations; one combined upload disclosure/action authorizes private retention and bounded OpenAI processing for browser and search-only scoped agent searches. Versioned consent persists in immutable import/source receipts; search and grant issuance/verification fail closed for older imports lacking it. Replays reuse the original consent without changing prior receipts.
Receipt/replay and one-action scoped setup forms are implemented.
Browser responses use `Referrer-Policy: strict-origin`; invited landing pages additionally allow the exact HTTPS provider origin in CSP `form-action`, while all other forms stay self-only.
Invited setup downloads a fifteen-minute search-only grant for exactly one import; raw archive access is excluded.
Open-account setup issues a durable account-scoped bearer for `unlinked_search_network`, covering all current and future owner imports until revoked, with no raw archive, global graph or caller-selected owner access.
The separate signed tool audiences use durable owner-private Noos grant records and live publication/revocation checks. Invited grants use ephemeral signing keys that invalidate grants on restart; account grants derive a domain-separated key from the approved private graph secret, so unchanged secrets preserve grants and secret replacement revokes them.
Operational bearers and provider ID tokens never become agent credentials.

The synthetic standalone runtime binds loopback only.
Reserved tailnet origin is https://m4-mini.tailb2a35c.ts.net:9367 and callback /auth/callback/ideaflow.
This reservation is not a running or verified upload URL.
The proposed real guest packet uses the separate `https://private.unlinked.ai` origin and the process-only composition in `mcp-server/private-composition.mjs`; see [Private pilot release packet](../deploy/private-pilot/README.md).
Actual provider client/redirect acceptance and immutable legacy/new-owner provisioning remain release gates. The optional trusted invited-owner callback and exact owner/principal readback are documented in [Private invited-owner browser](private-invited-browser.md); the open account launch is summarized in [Open account launch](../deploy/private-pilot/ACCOUNT-LAUNCH.md).
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
Final test execution may instead use `UNLINKED_PRIVATE_AI_TEST_KEY_FILE` only when the operator supplies an explicit mode-600 regular non-symlink env file outside the Unlinked and Noos checkouts; the file is read directly into the existing Responses completion path and the receipt records status/model/usage without printing the key.
A bounded synthetic Responses request returned HTTP 200.
Any new persistent secret destination requires confirmation before copying; none is configured here.

## Verification

Install locked MCP dependencies and run the private AI/browser/grant/hosted/scope/account test files with node --test.
Signed disposable OIDC responses prove client validation, not an actual provider login.
Set UNLINKED_NOOS_TEST_CHECKOUT, NOOS_OPERATIONAL_EXTRA_TEST, UNLINKED_NOOS_RECEIPT and NOOS_SIGNED_TEST_EVIDENCE to isolated external-SSD paths, then run the Noos checkout's node scripts/test-operational.mjs.
Only explicitly authorized UNLINKED_PRIVATE_AI_REMOTE=1 enables synthetic model calls through the existing M5 bridge or the explicit private key-file fallback; ordinary CI has no provider call.
The runner owns one capped 1 GiB disposable Neo4j and cleans it in finally.
The real 1,001-contact ZIP harness requires accepted=indexed=MCP-readable count and, with the model enabled, considers every connection including the last contact; account-launch tests additionally cover Connections-only/full-ZIP parsing, returning import discovery, revoke/replay and whole-owner MCP search.
Do not claim a live pilot until real provider/browser, storage/recovery and review gates pass.
