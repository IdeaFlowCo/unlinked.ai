# Network and list downloads

Jacob's November 10 direction: Unlinked should be at least as useful as querying an uploaded/downloaded spreadsheet. People and agents must be able to query the whole dataset and take the whole result in one operation, choosing a compact contact sheet or all available profile detail. Paging is an internal transport detail, not a user chore.

## Product contract

- A **Download** action sits beside the network and each owned list. It carries the current scope and filters into one consistent download form.
- **All matching people** is the default, including rows beyond the visible page. There is no 50/100/200-person export truncation. Optional selected IDs intersect the current filter.
- Formats: **CSV** for spreadsheets, **JSON** for structured reuse, **JSON Lines** for large streaming consumers. Detail: **Names & headlines**, **Contact sheet**, **Full profile**. Agents can also specify individual fields.
- Full profiles include only actually available biography, experience, education, skills, professional links and visible connections. An imported headline is never presented as a full enriched profile. Private lists retain their current people, private notes and source-row context; public matches use exact identities, never name-only joins.
- Own networks and own lists are downloadable by every signed-in owner. Verified and Enhanced access (approved) users may additionally download all published profiles/connections visible to them, or combine those with their own network. Verification never widens data visibility.
- One `unlinked_export_network` call returns browser and authenticated API download links. One HTTP request streams the complete selected result; agents do not need to walk cursors or insert an entire spreadsheet into model context. A link carries no credential and reads only the account that authenticates when downloading.
- The same service enforces filters, field presets, consent, active ownership, private-notes permission, publication fences and cancellation for browser, REST and MCP. No new public share capability or store.
- Large downloads stream with backpressure. JSON/JSONL carries a successful completion marker; an interrupted stream is not reported complete. CSV cells neutralize spreadsheet formulas without changing stored source data.

The homepage was checked live before work: its lead already mentions asking an AI agent, and its dedicated section says “Built for AI agents too”, with an MCP setup guide. The requested conditional rewrite is unnecessary. Its original HTML was saved; the available browser host timed out when asked for a screenshot, and no screenshot is claimed.

## Agent contract and real bounds

Catalog v10 adds the read-only `unlinked_export_network` tool within the account's existing data scopes. `inline:true` returns all matches in one response when the projected rows fit 768 KiB, leaving room within the MCP/REST 1 MiB response ceiling. Larger results return total, `complete:false`, `truncated:true`, `reason:response_size_limit`, a small preview and the full authenticated download descriptor. This is a response-size boundary, not a 50/100-row database selection cap. Ordinary key request budgets apply once to the bulk operation; trusted internal list reads use a process-only Symbol capability while still checking scope and ownership.

Manual entry is `/downloads`; the CSV/JSON attachment is `/downloads/file`. REST clients may POST `/api/agent/v1/exports` with the tool's JSON arguments or GET `/api/agent/v1/export` to stream directly. Browser download links use browser sign-in; API downloads use a direct Unlinked account bearer with the same permissions. A shared Ideaflow connector token remains a gateway token and is not a direct app API key. No credential is embedded in either URL.

Explicit selections are bounded by the real HTTP URL/header size (12,000 encoded parameter characters). A whole scope, list or filtered result is represented by its short query descriptor and has no such row-count bound. No selected ID is silently dropped. Full private-list CSVs add `source.<original column>` columns for retained import rows, while JSON preserves those rows and their source provenance structurally. Current list membership is checked again before completion; removed people are not resurrected from import history.

The contact sheet includes an email column when that data is actually permitted: browser owners can export their own archive contact fields, and private-list agents can export fields already authorized by `private_notes`. An agent's ordinary network permission continues to exclude raw LinkedIn archive email/phone fields; verification does not change that permission boundary.

Own-network exports use the same exact-reference grouping as the network UI: repeated observations of one LinkedIn/public identity are one person, while same-name people remain separate. Full browser exports retain every grouped source observation. Downloads never invoke a model or an external enrichment service.

## First and second degree, with intermediaries

Jacob's November 16 direction (unlinked-flav): offer a download of first AND second-degree people, all available profile detail, and who connects the owner to each second-degree person.

`scope=extended` ("My network + 2nd-degree people, with who connects us") is one selection, one row per person:

- **First degree** is the owner's own network exactly as `scope=mine` produces it (same exact-identity grouping, same contact-field rules), marked `degree: 1`. An own contact with no published profile is still a first-degree row.
- **Second degree** is every listed published person reached by a *visible recorded connection* of one of the owner's first-degree people who is identified in the published network by exact evidence (the row's published id or LinkedIn address, merges followed; never a name). These rows are marked `degree: 2`.
- A person is never in both groups: anyone identified as first degree is excluded from the second-degree side, and the owner's own profile is excluded. A same-name contact without exact identity evidence stays a separate row; nothing is merged by name.

Path columns exist only in this scope, so every other download keeps its exact columns. Every preset adds `degree`, `viaCount`, `viaNames` (`; `-separated) and `viaUrls` (space-separated profile links); **Full profile** also adds `via` and `pathEvidence`. Agents may select any of them through `fields`; requesting them in another scope is `invalid_input`.

- `via[]`: `{ viaId, contactId, name, url, linkedinUrl, firstHop, path: { fromId, viaId, toId } }`. `viaId` is the intermediary's published profile id, `contactId` the owner's own connection row, `name` comes from the owner's own row first, `firstHop` is that row's provenance (`owner_import` or `recorded_public_path`), and `path` uses the same `fromId/viaId/toId` shape as the agent degree tools (`fromId` is the owner's published profile, or `null` when none is linked).
- All valid intermediaries are counted. At most **25** are named per person (`EXPORT_VIA_LIMIT`, by published id so a retry names the same ones); `viaCount` and `pathEvidence.total` give the real total and `pathEvidence.named` how many are listed. Nothing is silently dropped.
- `pathEvidence`: `{ type: "recorded_public_path", hops: 2, revision, named, total }` for second degree, `{ type: <row provenance>, hops: 1 }` for first degree.

Boundaries:

- **Evidence, not coverage.** A path is a connection recorded on Unlinked that the owner is allowed to see. It is not complete LinkedIn second-degree coverage, not relationship strength and not willingness to introduce. The form, the tool description and the manifest `guidance` say so.
- **Privacy.** The second hop obeys the same connection-list audience policy as browsing and the existing `degree` filter (`connectionDegrees`): a member's private connection list is never path evidence, unlisted profiles are not listed, and only the owner's own first-degree people are ever named as intermediaries. Agent downloads still exclude raw archive contact fields.
- **Entitlement is unchanged.** Second-degree rows are published profiles beyond the owner's own rows, so `extended` requires exactly what `everyone`/`all` require: Verified or Enhanced access, plus public scope for an agent grant. A Standard account gets `scope_not_granted` (the form does not offer the option); it is never silently downgraded to a first-degree-only file. Whether contributors or Standard accounts should get this selection is an open product decision, not decided here.
- **Filters.** Query, structured filters, selected IDs and presence apply to both sides. `degree=1` or `degree=2` narrows to one side; `degree=3` is `invalid_input`.
- **Completeness.** All internal pages stream with the same permission rechecks, cancellation, import/publication fences and completion marker as other downloads. A failed profile read, a path that cannot be confirmed, a changed publication, a revoked grant or a lost tier fails the download; it never yields a partial file marked complete.
- **Reconciliation with agent degree tools.** `unlinked_list_connections` degree 2 (docs/agent-api.md, "Degree semantics") anchors on the confirmed recovered profile's recorded public paths. This download instead uses the browser/export rule already used by the People `degree` filter: the first hop is the owner's own network row, the second hop a published visible connection. `via[].firstHop` and `pathEvidence` state which evidence each row rests on; the two contracts are not merged.

Downloads still never invoke a model, LinkedIn, Unipile or any enrichment provider.
