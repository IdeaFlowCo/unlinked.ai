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
