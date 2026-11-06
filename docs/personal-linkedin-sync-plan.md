# Personal LinkedIn sync in Unlinked

Assessment and proposed product contract, 2026-10-12. Planning ticket: `unlinked-4z4`; broader agent-control planning: `unlinked-but`. This document authorizes no implementation, account connection, provider configuration, spending, or deployment.

## Recommendation and distance

The app foundation is substantially present. The personal sync subsystem is not. This is a few focused agent sessions for a narrow beta, subject to real provider acceptance, rather than an app rebuild or a button-only change. Suggested slices: (1) durable account linkage and isolation; (2) restart-safe initial import and updates; (3) integrated UI and two-user acceptance. Genuine LinkedIn social sign-in is an additional identity-service slice and should not block the sync beta. These are sequencing estimates, not delivery commitments.

Start with **Sign in with Ideaflow → Connect LinkedIn → Search your network**. Ultimately **Continue with LinkedIn** may combine the entry journey visually, but login and permission to retain/sync connections remain distinct grants. Unipile Hosted Auth links a data source; it is not, by itself, our shared application identity provider.

Inigo, as identified by Jacob, remains the system source. Personal connection, reconnect, pause, unlink, and deletion must never change it. Its current provider health and deployed adapter internals were not inspected in this assessment.

## Evidence checked

Unlinked `origin/main` at `292ec6e` (v0.6.32); anonymous production homepage inspected at `https://www.unlinked.ai/`, which displayed v0.6.32. No authenticated user journey or live Unipile request was performed.

| Capability | Current evidence | Consequence |
| --- | --- | --- |
| Multiple application users | `docs/ideaflow-sign-in.md`, `mcp-server/private-browser.mjs`: Ideaflow issuer/subject identity, account creation, silent SSO, account switching | Do not rebuild user login just to connect personal sources |
| Persistent archive import and personal network | `docs/member-home.md`, `docs/durable-archive-import.md`, `src/utils/private-import/account-network.mjs` | Reuse the import/search backbone; add a durable provider-source writer |
| People deduplication | `docs/network-controls.md`, `mcp-server/connection-identity.mjs`: exact profile/LinkedIn evidence; names never join people | Add provider evidence and preserve source records |
| Agent access | `docs/agent-api.md`, `docs/agent-key-settings.md` | Existing authorized network reads should see new indexed contacts without a second setup |
| Signup LinkedIn lookup | `docs/signup-profile-lookup.md`, `mcp-server/signup-profile-lookup.mjs`: optional private host adapter, public-profile preview, self-asserted confirmation | A pasted address and successful public lookup do not authenticate the person's LinkedIn or import their connections |
| Historical Unipile lab | Preserved local main `d539eea`, `docs/unipile-lab.md`, `src/utils/unipile-provider.ts`, `src/utils/unipile-lab.ts` | v1 learning exists, but ten-row, ten-minute process-memory previews are not a production sync foundation; lab is absent from current main |
| Per-user persistent Unipile links and network sync | No mounted connector, durable link store, relations worker or provider webhooks in inspected current Unlinked source | This is the substantive missing feature; host-private code is outside this repository audit |

Current app sign-in is **Sign in with Ideaflow**. Google/email/signup are handled there. “Other accounts” already works when it means other Unlinked users; it does not yet mean each user's connected LinkedIn source.

## Product intent

Human: a founder or connector asking “Who do I already know who can help?” The app should feel dependable: their network is available when they need it, and freshness is understandable without managing integrations.

Domain: people, introductions, connection provenance, shared professional discovery, private relationship context, network freshness. Color world: the existing indigo action color, pale blue page, white surfaces, graphite text, gray source metadata; amber only for attention and green only for healthy status. Signature: **one person, multiple source observations, with a visible freshness receipt**. Avoid an integrations dashboard as the home screen, duplicate LinkedIn copies of people, and a “100% live” badge that hides partial data.

Keep Public Sans, current indigo `#4349c4`, tinted page `#f5f6fc`, 8px radii and the app's restrained controls. Home's focal point remains the network question. Connection setup is a supporting card. Use 4px spacing increments, 16–24px panel padding, native controls, readable source metadata, at least 44px primary touch targets, and no required animation. The accompanying prototype uses those existing product tokens; fictional accounts and counts are explicitly marked.

## App journey and user stories

1. **New member:** “I want my people here without finding an export.” After existing sign-in, offer **Connect LinkedIn** as the primary route when the feature is actually ready, **Upload an export** as the alternative, and **Explore first**. Explain what is read, retained and published before connection. Hosted Auth handles provider authentication/challenges; return to an in-progress network screen, not a generic success page. Initial indexing continues if the user closes the tab.
2. **Returning archive user:** “Keep what I already imported current.” Home offers **Keep your LinkedIn connections up to date**. Matching contacts gain a new source observation rather than a duplicate profile. Historical archives and notes remain. Existing import reminders stop only once the product's eligibility rules recognize a usable linked network, not on browser redirect alone.
3. **Everyday use:** “Find founders I know in climate.” Search stays primary. Results show why the person matches, connection source and freshness when relevant. Existing People, company views and mutual-path readers should consume the same authorized network model; do not bolt on a separate LinkedIn directory. LinkedIn membership and native Unlinked acceptance remain distinguishable.
4. **Disconnected source:** “Let me keep working while I reconnect.” Retain the last usable network, mark it stale, show one **Reconnect LinkedIn** action in Home/Settings. Do not force logout from Unlinked. The account identity and agent grant survive a provider interruption.
5. **Account correction:** “I connected the wrong LinkedIn.” Name the connected profile and show its LinkedIn address. Reconnect must verify the same provider identity; a different identity uses explicit replace/add flow with a new source, never silently overwrites the previous binding. A conflict with an existing claimed Unlinked profile needs a reviewed linking/recovery flow rather than taking it over.
6. **User control:** “Pause updates or remove my source.” Settings → Connected accounts offers pause, reconnect, disconnect and explicit removal of this source's retained data. Disconnect stops future access and leaves already imported observations clearly dated; source-data removal separately explains which observations/derived memberships disappear. Preserve unrelated archives, manually added people, native connections and private notes. Account deletion revokes/removes only the owner's bindings and data.
7. **Agent user:** “Ask my existing agent about the updated network.” Existing granted read access covers the same private network. Add source status/provenance to whoami/list/search responses without leaking provider account identifiers. Connecting LinkedIn never silently grants LinkedIn send, invite, post or message access to agents.

Home: question/search, then compact **LinkedIn connected · checked … · N connections searchable** card; new/recent connections can join the current recent-people area. People: retain current network filters and source disclosures; define degree labels from actual proven paths. Settings: Connected accounts alongside existing imports and agent setup. Profile: original manual/member fields keep precedence; source details explain newer observations. Notifications: reconnection or meaningful completed first-sync status, not a notification per imported contact. Messaging remains current Unlinked/OpenChat behavior; future LinkedIn messages must be labeled by channel and sender account.

## Inigo isolation and ownership

Use two explicit source roles: `system` and `personal`. Inigo is reserved as `system`; maintain its existing adapter and explicit account ID. A system source has no ordinary member owner, is excluded from all personal-source pickers and bulk member cleanup, and cannot be reclassified through browser/API parameters. No “first LinkedIn account” or global default-account fallback is allowed in personal operations.

Persist a personal source binding with opaque source ID, exact internal owner, provider workspace/account identity, verified LinkedIn self identity, role, lifecycle state, consent version, timestamps and binding generation. Reserve provider-account ownership with a durable unique constraint; also detect conflicting self identities under the initial one-personal-LinkedIn-per-owner policy. Workspace credentials stay server-side and are referenced through existing secret handling, not stored in public projections. Provider IDs are not authorization credentials.

Every worker resolves its provider account from the durable source binding, then rechecks active owner, source role and generation before writes. Browser requests never supply an arbitrary provider account ID. Webhooks authenticate with a configured provider-supported secret, resolve the durable mapping, reject unknown/system IDs from the personal sync path, and deduplicate deliveries. Reconnect is restricted to the owned account and same verified provider self identity. Unlink/account deletion filter by owner plus personal role, invalidate outstanding generations, cancel jobs and revoke only the selected source.

Separate personal and system request queues/budgets. Reserve system capacity; a customer import cannot exhaust Inigo's queue. If Unipile imposes shared workspace-wide limits, measure and provision for that before broader release: application isolation alone cannot guarantee zero provider-wide contention.

## Sync contract

**Initial sync:** After authenticated callback verification and provider readiness/self check, enqueue a persistent paginated relations import. Save cursor, lease, attempt count, sync generation, checkpoint and typed failure. Upsert source observations idempotently. Index accepted observations through a provider-source adapter, not a fabricated uploaded archive; keep the original archive receipts immutable. Show processed and searchable counts separately, plus indexing backlog. Search can work over the indexed subset while the rest imports. Completion means end-of-pagination and all accepted observations accounted for; if no total is reliable, use “N imported; still syncing,” not an invented percentage.

**Ongoing new connections:** Consume version-specific new-relation notifications and schedule bounded catch-up checks for missed events/reconnects. v1 calls this `new_relation`, v2 `relation.new`; choose the deployed workspace contract explicitly. Do not blindly migrate APIs or dependencies just to implement this feature.

**Removals:** A new-relation webhook is not deletion coverage. Plan infrequent, bounded full reconciliation according to provider limits. Only a successfully completed and validated traversal may close missing LinkedIn-source memberships; a partial page, error, suspiciously empty result or expired cursor cannot erase a network. Preserve archive history and other-source/native relationships. Until this is verified, disclose removals as incomplete coverage.

**Profile changes:** Relations membership and profile enrichment are separate. A person's new title/role/company requires a paced refresh policy, such as refresh of high-value/recently viewed contacts plus a budgeted rotating queue. Expose `connectionsCheckedAt` and `profileObservedAt` separately. A new connection does not prove every contact's career details are current. Include this policy in the MVP's copy even if broad enrichment is later.

**Merge precedence:** Group only by verified exact identity evidence. Preserve each source's observation/time and manual member edits, private notes and archived evidence. A fresh provider observation can update a derived professional display according to explicit field precedence; it cannot overwrite hand-edited fields or implicitly publish personal relationship edges. Distinguish profile publication from sharing connection lists. New provider imports should remain owner-scoped until the user has received and accepted the applicable publication disclosure; preserve existing archive-publication behavior for earlier consented archives. Adding LinkedIn sync does not grant arbitrary access to private notes/contact details.

**Errors and controls:** Handle provider challenge, offline/disconnected, rate limit, timeout, empty network, partial import and indexing failure distinctly. Back off with jitter, respect provider retry instructions, cap retries and keep an operator-visible typed error/audit without raw provider bodies. Resume across app/worker restarts. An ordinary page view does not call Unipile. Disconnect and pause must win over an in-flight request or late webhook. Source removal invalidates jobs before data cleanup. Rollback disables the personal connector, stops its writers and preserves source observations for controlled recovery; existing imports and Inigo continue.

## Login placement

For MVP, use shared Ideaflow account login and show **Connect LinkedIn**. A source connection alone must not create a second Unlinked account or sign the user into another member's account. Never match identities using only equal email, a public URL, or a browser success query parameter.

If **Continue with LinkedIn** is required, add a verified supported LinkedIn identity-provider flow to Ideaflow ID and link it to an authenticated existing identity using the gateway's account-linking policy. Verify exact product/client availability there before selecting the auth approach. Retain an independent login/recovery path so provider disconnection does not lock a user out. Return to the intended Unlinked route and request the separate source-sync permission in context. This audit verified Unlinked's identity client, not the gateway's current LinkedIn-provider configuration.

## Delivery and acceptance

1. **Linkage slice:** Two test owners can create durable personal source links through Hosted Auth; callback replay, owner conflict, forged callbacks and arbitrary provider IDs fail. Restart does not lose pending state. Inigo's role/account/config remain unchanged. A provider challenge may require the human account owner to complete it; no need to ask for routine design permission first.
2. **Sync slice:** One consented nonempty account completes all relations pages; duplicates and restart checkpoints preserve counts. Indexing failures are resumable. Deliver a fresh connection event, reconnect catch-up, pause/unlink during in-flight import, duplicate/late webhook, and conservative full-reconciliation receipt. Verify the explicitly supported freshness scope.
3. **App slice:** Returning archive user gets one person per identity with intact notes. New user reaches a useful network search; disconnected user can still search dated data. Desktop/mobile/keyboard states work. Existing agent read access sees the indexed network while unrelated owners see none of its private edges. Account deletion cannot touch Inigo or the other test owner's source.
4. **Identity slice, if needed:** Genuine LinkedIn app login and existing-account linking are verified at Ideaflow ID; no accidental duplicates or lockout on source disconnect. This is independent of Unipile account linking.

Before public rollout, verify current workspace contract, account entitlements and incremental connected-account cost; document supported limits. Do not attach new paid accounts based solely on a design estimate. Keep implementation tickets under `unlinked-but` distinct from this completed planning deliverable.

## Provider evidence

Official documentation checked 2026-10-12:

- [Hosted Auth](https://developer.unipile.com/docs/hosted-auth): user-side account linkage and reconnection; account notification is distinct from browser redirect.
- [List all relations, v1](https://developer.unipile.com/reference/userscontroller_getrelations): account-scoped paginated connections retrieval.
- [New relation notifications](https://developer.unipile.com/docs/detecting-accepted-invitations): notifications include new connections; provider polling can delay them by up to eight hours. They are not a real-time freshness promise.
- [Provider limits, v1](https://developer.unipile.com/docs/provider-limits-and-restrictions): initial sync allowed; avoid fixed-frequency relationship polling; use restrained randomly spaced checks and webhook updates.
- [Provider limits, v2](https://developer.unipile.com/v2.0/docs/provider-limits-and-restrictions): separate version-specific relations guidance. Confirm workspace version before choosing batching policy.
- [Account lifecycle, v1](https://developer.unipile.com/docs/account-lifecycle): disconnect/readiness handling.
- [Webhook authentication, v1](https://developer.unipile.com/docs/webhooks-2): configured secret header supported.

No pricing figure, existing-account entitlement, full-network live result, universal profile-change notification or removed-connection webhook is claimed by this assessment.
