# Verified accounts and Enhanced access

Verified is an operator-granted Unlinked access tier, separate from OIDC email verification, a profile claim, imported names, or agent permissions. The active OperationalOwner's exact owner/user pair holds `unlinkedVerified`. The resolver caches that decision for at most one second and never trusts client or grant tier claims. Entitlement read failure fails closed.

Verified users bypass the shared public-read queue and its capacity/minute budgets, autocomplete/card/photo browsing fuses, deterministic/AI/write API and MCP quotas (including shared AI admission), browser private-context and message-picker quotas, messaging request quotas, and the connection-send daily allowance. Ordinary users keep existing defaults. Existing grants pick up the tier without being reissued; consent, scopes, ownership checks and grant revocation still apply.

Priority means immediate admission ahead of quota-controlled pools. It cannot promise instantaneous execution or override third-party service capacity, separately funded external profile-lookup allowances, transport/body/parser bounds, operation deadlines, recipient blocks, connection resend cooldowns or graph consistency rules. No new backend, model or dependency is introduced.

## Enhanced access (approved accounts)

Jacob's November 14 direction: recognized people he knows who have signed up get more room for bulk downloads and agent requests; everyone else keeps the standard limits. The tier is called **approved** in code and **Enhanced access** in the product. It is held on the same active OperationalOwner as `unlinkedApproved` (with `unlinkedApprovedChangedAt`/`By`), resolved together with `unlinkedVerified` by `createAccessTier` (`mcp-server/verified-access.mjs`) under the same one-second cache and fail-closed read. Verified outranks approved.

| Per-owner allowance | Standard | Enhanced access |
|---|---|---|
| Deterministic API/MCP tools | 120/min | 600/min |
| AI API/MCP tools | 20/min, 2000/day, 2 in flight | 60/min, 6000/day, 4 in flight |
| Grant provisioning by an app client (OpenChat, Vision) | 30/min | 150/min |
| Browser private context / message people picker | 60/min / 20/min | 300/min / 100/min |
| Downloads of everyone visible (`scope=everyone|all`) | no | yes |

Limits and factors live in `mcp-server/access-tiers.mjs`. Deterministic reads are cheap in-memory graph reads, so 5x (about 10/s) suits agent bulk work; AI calls are paid and share the runtime-wide ceiling of 8 concurrent calls, which does not change, so they get 3x. Connection-write budgets and the 50/day connection-request allowance are unchanged: they limit unsolicited requests, not downloads. An approved account's shared-network download uses the same permission-aware export as verified (published, viewer-visible rows only, never other owners' private imports). Settings shows one quiet line, **Enhanced access**, under Your data; standard accounts see nothing.

The reviewed seed and its selection rule are in `deploy/private-pilot/approved-access-seed.json` (names and public profile IDs only).

## Download

Verified users see **Settings → Verified access → Download network**. The browser-session-only `GET /network/export` accepts `scope=everyone|mine`, optional `q` (200 characters), and comma/whitespace-separated `ids` (10,000 characters). Empty filters export the full scope; a query and IDs intersect. IDs are public profile IDs for everyone, and contact/observation IDs or published target profile IDs for mine.

`everyone` pages the same sanitized published index as browsing, with the authenticated viewer's connection-privacy policy and server-resolved unlisted group. Both endpoints of each returned edge must be included in the selected export. It cannot read another owner's private imports, contact addresses or notes. `mine` includes that owner's visible imported/legacy/member-connection observations, with suspension filtering. Existing **Download everything (JSON)** remains available to every signed-in account for account records, private notes and source data.

Downloads stream JSON Lines with backpressure: `export` metadata, `profile`, directional `connection`, or owner `observation` records, then a `complete` footer with counts. No row count or page count truncation is applied by the download. A publication revision change, grant/tier removal, session expiry, upstream read error or disconnected client interrupts the attachment without a completion footer. Download results are never cacheable or publicly previewable. Anonymous requests must sign in; regular accounts receive 403. This route is excluded from agent bearer access because existing grants exclude raw private archive fields.

## Operator

Inside the existing private runtime container, with its normal confidential environment:

```
node mcp-server/verified-access-operator.mjs show OWNER_UUID USER_UUID
node mcp-server/verified-access-operator.mjs grant OWNER_UUID USER_UUID OPERATOR REASON
node mcp-server/verified-access-operator.mjs revoke OWNER_UUID USER_UUID OPERATOR REASON
node mcp-server/verified-access-operator.mjs approve OWNER_UUID USER_UUID OPERATOR REASON
node mcp-server/verified-access-operator.mjs unapprove OWNER_UUID USER_UUID OPERATOR REASON
node mcp-server/verified-access-operator.mjs resolve PUBLISHED_PROFILE_ID
node mcp-server/verified-access-operator.mjs approve-profiles SEED.json OPERATOR REASON
```

`resolve` maps a published member profile ID to its one active account from live source ownership (signup source, public archive import or confirmed claim); it never matches names or email. `approve-profiles` resolves every profile in a reviewed seed first and writes nothing if any is unresolved. Approval changes write an `UnlinkedVerificationEvent` with `tier: 'approved'` and `approved: true|false` (verified changes keep their original shape), so no new graph label or migration codec change is needed.

The operator requires an active exact owner/user binding, writes an attributed UnlinkedVerificationEvent, and reads the resulting entitlement back. It exposes no self-service privilege change. Never choose the account from an imported contact's name alone: inspect the actual signed-in account and its own import receipts.

Recovery snapshots include `UnlinkedVerificationEvent` as well as the owner entitlement properties. Release packets must use the updated migration codec before the first entitlement write; older codecs deliberately refuse unknown private labels.
