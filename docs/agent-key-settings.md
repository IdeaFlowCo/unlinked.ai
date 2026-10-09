# Settings: connect an agent or use an API key

For Claude and ChatGPT, keep the existing **Connect with sign-in** instructions and
`https://www.unlinked.ai/mcp`. Discovery, client registration, exact callback
allowlist, PKCE and consent are unchanged. OAuth apps remain separate from manual
keys and can still be disconnected individually. The shared Ideaflow hub is a
separate account connection at `https://id.ideaflow.app/agents`; direct keys belong
only to Unlinked. Legacy Supabase `ul_` keys are not this runtime's key manager.

The **For agents** page (`/agents`) leads with **Set up your agent**. Signed-in
readers see **Open API keys in Settings**, which navigates to `/settings#api-keys`;
anonymous readers see **Sign in to open API keys**, returning to Settings after
sign-in. **Connect Claude or ChatGPT** jumps to the sign-in connector instructions.
The guide restores existing sessions and is served with `Cache-Control: no-store`.
Visiting it does not read, create or reveal an API key; copy controls remain in
Settings. The guide link itself never claims to copy anything.

## Manual setup, including Muse

1. Sign in to Unlinked and open **Settings → API keys**.
2. Use the prepared key, or **Create API key**, name it **Muse**, and create it.
   Read access is the default; connection-request actions require explicit opt-in.
3. **Copy API key** copies only the credential. In Muse, ask for a custom API
   connector with `https://www.unlinked.ai/openapi.json`; paste the key into its
   API-key/access-token field. Do not paste JSON or add a Bearer prefix there.
   A *full Authorization header value* is `Bearer ` followed by the key instead.
4. Ask the app to check your Unlinked identity, then make a small search. A copied
   key alone is not evidence that the app saved or used a connection.

**Show/Hide** and **Copy API key** work repeatedly, including after returning to
Settings or signing in again. No one-time display, copy-triggered issuance,
forced regeneration, forced expiry or additional authentication solely to copy.
**Copy agent setup** still copies the same valid MCP URL/headers JSON (Cursor and
compatible clients). **Setup instructions and advanced formats** retains Claude
Desktop's valid stdio `mcp-remote` configuration, Claude Code and header examples.
Muse custom OAuth/redirect compatibility is unverified; no callbacks were added.

## Permissions and connector choice

API key selection, **Show/Hide**, **Copy API key** and **Copy agent setup** appear
above client-specific sign-in/config instructions. Under the selected key,
**Send and manage connection requests** is an accessible switch; select its state
and **Save permissions**. Turn it on/off anytime without replacing or reconnecting
that key. It covers send, accept, ignore and withdraw only. Other manual keys and
OAuth apps are unaffected. Existing owner-only keys retain owner-only reads.

Use the shared [Ideaflow connector setup](https://id.ideaflow.app/agents) for
compatible hosts wanting several apps or messages; consent to each app's read/write
permissions there. Messages require **OpenChat** write access, separate from
Unlinked connection requests. Existing direct Claude/ChatGPT Unlinked OAuth
connections keep working; there is no forced migration. New OAuth permissions
require consent/reconsent, not this manual-key switch. Muse's observed manual form
uses the direct Unlinked key/OpenAPI instructions above; Muse OAuth remains untested.

“X knows Y” private relationship assertions are not connection requests. Existing
OpenChat private-link capability is a separately reviewed adapter/surface follow-up
(`unlinked-47t` design gate); this release creates no relationship backend or toggle.
Legacy Thoughtstream/Ideaflow and NoteStream destinations remain distinct.

## Independent lifecycle

Select a named row, then **Manage [name]** to **Save name**, **Replace this key** or
**Revoke this key**. Replacement stops clients using only that key, preserves its
name and enabled permissions, and leaves other keys and OAuth intact.
New tools within enabled permissions work with the same key. Refresh the agent’s
cached tool list instead of replacing a key. Names are display-only,
1–80 trimmed characters, without controls. Existing unnamed keys remain valid and
appear as Default key or Existing key with a date and short identifier. Revoked
automatic grants stay revoked; visiting Settings does not undo that choice.

When the automatic Default key has connection actions enabled and no read-only
manual key exists, authorized server-to-server provisioning creates one separate
**Read-only provisioning key**. It retains the default key's owner-only or public
read boundary and does not change that key's secret or permissions. Show/Copy
never issues this fallback. Its fixed per-account identity makes concurrent and
repeated provisioning reuse the same grant. It is an independent Settings key:
replacement is reused, revocation remains a tombstone, and enabling writes on it
blocks further automatic fallback issuance. No additional fallback identities are
created. Create an explicit read-only key in Settings to resume provisioning.
An already revoked automatic default does not authorize fallback creation.

The grant service stores optional name and generation metadata in existing owner
resources. Tokens remain deterministically re-derived, not stored in plaintext.
Replacement uses one compare-and-set to change a random generation; failed writes
leave the prior token valid, and concurrent revoke wins without resurrection.
Browser-session, same-origin, CSRF and durable owner checks protect management.
OAuth grants cannot be revealed, renamed or replaced by manual-key operations.
The old `/setup-account` form creates an additional manual grant; it no longer
revokes other manual grants. Neither tokens nor names are written to audit logs.
Last-use telemetry and expiry are intentionally not prerequisites for this UX.

## Release and rollback

This is source behavior until the canonical standalone runtime is released;
Vercel's Next.js preview alone does not deploy these Settings controls. Preserve
issuer, signing key, graph and old grants. No schema migration, dependency or
identity-provider change is required. Before enabling replacement, all direct
REST/MCP validators and provisioning must run the generation-aware grant service.
Do not roll back authentication to a pre-generation validator after any key is
replaced: old code would ignore generation and accept a replaced token. Rollback
must retain the generation comparison and generation-aware re-derivation (a
forward corrective release is preferred). V5 permission edits also require a
v5-capable validator; older runtimes reject those records. Preserve v5 catalogs
and normalization when rolling back UI, or use a forward corrective release.
Revoke tombstones remain compatible.

PR114 and identity34 own shared discovery/host guides and their coordinated
release. This change does not merge or replace those PRs or claim Muse support.
When merging their documentation changes, retain this page's final button names,
repeatable-copy semantics and service-specific credential distinction. PR118's
request diagnostics remain independent and are not enabled by this work.

Focused validation: `node --test tests/manual-api-keys.test.mjs
 tests/agent-setup-auto.test.mjs tests/agent-client-setup.test.mjs
 tests/account-launch.test.mjs tests/account-grant-provisioning.test.mjs
 tests/mcp-oauth.test.mjs` (as one command). Browser QA uses synthetic grants only.
