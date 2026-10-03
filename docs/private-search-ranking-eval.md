# Owner role-evidence ranking evaluation — 2026-10-02

Ticket: `unlinked-v7i.4`. Baseline: `60067d8`.

The node regressions use a deliberately bad stub client: it reverses the
candidates and supplies “Likely investing in gaming; possibly covering climate.”
Before the fix, domain-only gaming founders/CEOs survive and speculative reasons
are returned. After the fix, only four role-supported investment records survive;
the explicit gaming title ranks first, and every reason quotes the supplied
position/company and states when gaming sector focus is not evidenced.
Engineer/gaming and recruiter/climate requests use the same role guard. An
investor-relations manager, principal engineer at a capital-named company and
founder/CEO at a venture-named company are excluded; a founder with explicit
angel-investor title evidence remains eligible.

Run `node scripts/eval-private-search-ranking.mjs [baseline-ref]` for an opt-in
real-model comparison using only `tests/fixtures/private-search-people.mjs`.
It uses the existing M5 credential bridge without copying/logging credentials;
no personal archive, owner names or production data are sent or persisted.
Responses uses `store: false`. The script requires the baseline git object and
configured M5 bridge; it is outside CI because live model selections vary.

One before/after sample per scenario, using `gpt-4.1-mini-2025-04-14`:

| Fictional scenario | Before | After | Tokens before → after | Elapsed before → after |
| --- | --- | --- | --- | --- |
| Explicit gaming investor (11 records) | One explicit gaming investor | Explicit gaming investor first; one general investor with unknown gaming focus stated | 938 → 666 | 1.916 s → 2.243 s |
| Unknown sector focus (10 records) | Four results, including an investor-relations manager; gaming evidence absent from reasons | One evidenced investor; gaming focus explicitly not evidenced; investor relations omitted | 1007 → 568 | 2.787 s → 1.530 s |

The fictional live baseline did not reproduce the original gaming-founder/CEO
false positives; the adversarial executable stub reproduces and pins those.
Live selections vary (including how many unknown-sector investors the model
returns). These small timing samples include SSH and are **not** a production
p95 or a 3,153-person latency claim.

The deterministic 3,153-record scenario has one investor and 3,152 gaming
founders. Every record is counted as considered, while initial provider calls
drop from 16 batches to one. No new calls or ranking rounds are introduced;
concurrency remains bounded at four, reasons are generated locally (the model
returns empty reason strings for guarded requests), and the final live
consistency read still rejects a changed/deleted publication even when no
role-supported records remain. The separate `unlinked-5oc` aggregate-read and
rate-limit optimization work remains open.

The versioned grant/tool lists and response keys are unchanged. The discovery
inventory and `docs/agent-api.md` document role-evidence requirements and the
conservative guard's limits, including semantic handling of other roles and
compound/exclusion queries.
