# Human and agent access

## Choose public browsing or an account connection

The [public agent brief](../public/AGENTS.md#choose-public-browsing-or-an-account-connection) owns public comparison guidance, indexed search setup, Muse/custom-connector fallback, verified signup and consent, and setup verification. The canonical browser setup is rendered by `renderAgents` in `mcp-server/private-onboarding-views.mjs`.

## Capacity and abuse policy

Verified browser viewers have 240 public directory reads per owner per minute. Anonymous reads retain the existing shared 120/minute fuse, at most six concurrent reads; all directory lanes share an eight-read ceiling. Two slots remain available to viewers while anonymous work is active. Viewers may wait up to 1.5 seconds in a maximum 16-entry queue; disconnects cancel the wait. This is a bounded admission improvement, not proof of fair CPU scheduling or sufficient production capacity. New accounts use the same bounded policy; signing in never gives unlimited access.

Account search and deterministic tool budgets, including hosted launch-tool compatibility, are owned by [the API rate-limit contract](agent-api.md#rate-limits-and-latency). Keys and grants share the owner budget; rotating or creating keys does not reset it. Runtime budgets are process-local and reset on restart, so they are not durable signup-fraud prevention.

Keep normal sign-in and explicit consent low friction. Prefer targeted velocity controls and progressive challenges for demonstrated signup abuse over a challenge on every human visit. Future anonymous client/IP fairness requires a trusted edge identity and origin restriction; current forwarding is not sufficient. Do not blindly trust X-Forwarded-For or bot user-agent names.

The first slice does not change crawler policy, signup APIs, permission defaults, OAuth callback allowlists or publication rules. Search-engine discovery versus bulk AI crawling needs a distinct enforced edge policy and corrected current-path robots directives. Robots alone is advisory. Public caching must preserve immediate suppression/revocation and never share member chrome. Anonymous readers can still hit their shared fuse; do not describe this as complete anonymous fairness or DDoS protection.

## Evidence and validation

Source: Jacob's 2026-10-24 Hesham exchange, Fable advisor `7b4974fd-433f-4e24-bfb2-fb86afae50eb`, implementation ticket `unlinked-k3r8`. The Hesham chat's statement that signed-in browser traffic bypassed the old shared limit was incorrect; it did not. Its ten-second-spacing advice was a workaround, not a reliable quota contract. Few successful HTTP probes do not prove host-specific reader/connector compatibility.

Muse product capability checked against [Meta's connector documentation](https://www.meta.com/help/superintelligence/1687253048996149/) on 2026-10-24. This establishes the custom-connector path, not a completed Unlinked-in-Muse end-to-end test.
