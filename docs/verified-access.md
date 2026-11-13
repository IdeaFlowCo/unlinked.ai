# Verified accounts

Verified is an operator-granted Unlinked access tier, separate from OIDC email verification, a profile claim, imported names, or agent permissions. The active OperationalOwner's exact owner/user pair holds `unlinkedVerified`. The resolver caches that decision for at most one second and never trusts client or grant tier claims. Entitlement read failure fails closed.

Verified users bypass the shared public-read queue and its capacity/minute budgets, autocomplete/card/photo browsing fuses, deterministic/AI/write API and MCP quotas (including shared AI admission), browser private-context and message-picker quotas, messaging request quotas, and the connection-send daily allowance. Ordinary users keep existing defaults. Existing grants pick up the tier without being reissued; consent, scopes, ownership checks and grant revocation still apply.

Priority means immediate admission ahead of quota-controlled pools. It cannot promise instantaneous execution or override third-party service capacity, separately funded external profile-lookup allowances, transport/body/parser bounds, operation deadlines, recipient blocks, connection resend cooldowns or graph consistency rules. No new backend, model or dependency is introduced.

## Download

Verified users see **Settings → Verified access → Download the visible network**, opening `/downloads?scope=all`. The [network and list download contract](bulk-exports.md) owns the browser and scoped-agent workflow.

The earlier browser-session-only `GET /network/export` remains supported. It accepts `scope=everyone|mine`, optional `q` (200 characters), and comma/whitespace-separated `ids` (10,000 characters). Empty filters export the full scope; a query and IDs intersect. IDs are public profile IDs for everyone, and contact/observation IDs or published target profile IDs for mine.

`everyone` pages the same sanitized published index as browsing, with the authenticated viewer's connection-privacy policy and server-resolved unlisted group. Both endpoints of each returned edge must be included in the selected export. It cannot read another owner's private imports, contact addresses or notes. `mine` includes that owner's visible imported/legacy/member-connection observations, with suspension filtering. Existing **Download everything (JSON)** remains available to every signed-in account for account records, private notes and source data.

Downloads stream JSON Lines with backpressure: `export` metadata, `profile`, directional `connection`, or owner `observation` records, then a `complete` footer with counts. No row count or page count truncation is applied by the download. A publication revision change, grant/tier removal, session expiry, upstream read error or disconnected client interrupts the attachment without a completion footer. Download results are never cacheable or publicly previewable. Anonymous requests must sign in; regular accounts receive 403. This route is excluded from agent bearer access because existing grants exclude raw private archive fields.

## Operator

Inside the existing private runtime container, with its normal confidential environment:

```
node mcp-server/verified-access-operator.mjs show OWNER_UUID USER_UUID
node mcp-server/verified-access-operator.mjs grant OWNER_UUID USER_UUID OPERATOR REASON
node mcp-server/verified-access-operator.mjs revoke OWNER_UUID USER_UUID OPERATOR REASON
```

The operator requires an active exact owner/user binding, writes an attributed UnlinkedVerificationEvent, and reads the resulting entitlement back. It exposes no self-service privilege change. Never choose the account from an imported contact's name alone: inspect the actual signed-in account and its own import receipts.

Recovery snapshots include `UnlinkedVerificationEvent` as well as the owner entitlement properties. Release packets must use the updated migration codec before the first entitlement write; older codecs deliberately refuse unknown private labels.
