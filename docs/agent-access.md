# Human and agent access

## Choose public browsing or an account connection

The [public agent brief](../public/AGENTS.md#choose-public-browsing-or-an-account-connection) owns public comparison guidance, indexed search setup, Muse/custom-connector fallback, verified signup and consent, and setup verification. The canonical browser setup is rendered by `renderAgents` in `mcp-server/private-onboarding-views.mjs`.

## Capacity and abuse policy

Verified browser viewers have 240 public directory reads per owner per minute. Anonymous visitors are told apart by an in-memory key: the `CF-Connecting-IP` visitor address when the ingress peer is a published Cloudflare edge, otherwise the peer itself (IPv6 per /64; never stored or logged, see `mcp-server/client-address.mjs`). Self-declared crawlers and non-browser clients (user agent; `declaredAutomation`) are never keyed and never prioritised: per address they read too slowly to tell apart from people, so the first release of this change let them crowd the arrival slots. Each other visitor's first 10 reads a minute are *arrivals*, and so is any profile opened from a card QR (`?via=card`, which only the QR carries): arrivals skip the shared fuse and may use the viewer slots and queue. Reads beyond that, and keyless traffic, draw on the shared 120/minute fuse with at most six concurrent reads; no visitor exceeds 60 reads a minute. All directory lanes share an eight-read ceiling, and two slots remain available to viewers and arrivals while anonymous work is active. Before this (2026-11-01) crawlers such as ShapBot exhausted the single shared fuse in about half of all minutes, so people who had just scanned a card saw “Unlinked is busy”. Viewers may wait up to 1.5 seconds in a maximum 16-entry queue; disconnects cancel the wait. Known link unfurlers (iMessage, Slack, WhatsApp, …) opening a profile get a separate small meta-only lane before this fuse and fall back to it when that lane is full: [docs/link-previews.md](link-previews.md). This is a bounded admission improvement, not proof of fair CPU scheduling or sufficient production capacity. New accounts use the same bounded policy; signing in never gives unlimited access.

Account search and deterministic tool budgets, including hosted launch-tool compatibility, are owned by [the API rate-limit contract](agent-api.md#rate-limits-and-latency). Keys and grants share the owner budget; rotating or creating keys does not reset it. Runtime budgets are process-local and reset on restart, so they are not durable signup-fraud prevention.

Keep normal sign-in and explicit consent low friction. Prefer targeted velocity controls and progressive challenges for demonstrated signup abuse over a challenge on every human visit. Future anonymous client/IP fairness requires a trusted edge identity and origin restriction; current forwarding is not sufficient. Do not blindly trust X-Forwarded-For or bot user-agent names.

The first slice does not change crawler policy, signup APIs, permission defaults, OAuth callback allowlists or publication rules. Search-engine discovery versus bulk AI crawling needs a distinct enforced edge policy and corrected current-path robots directives. Robots alone is advisory. Public caching must preserve immediate suppression/revocation and never share member chrome. Heavy anonymous readers still share one fuse, and a crawler spread over many addresses is only bounded by it and the concurrency ceiling; do not describe this as complete anonymous fairness or DDoS protection.

## Evidence and validation

Source: Jacob's 2026-10-24 Hesham exchange, Fable advisor `7b4974fd-433f-4e24-bfb2-fb86afae50eb`, implementation ticket `unlinked-k3r8`. The Hesham chat's statement that signed-in browser traffic bypassed the old shared limit was incorrect; it did not. Its ten-second-spacing advice was a workaround, not a reliable quota contract. Few successful HTTP probes do not prove host-specific reader/connector compatibility.

Muse product capability checked against [Meta's connector documentation](https://www.meta.com/help/superintelligence/1687253048996149/) on 2026-10-24. This establishes the custom-connector path, not a completed Unlinked-in-Muse end-to-end test.

## Instructions to paste into an agent (unlinked-40dg)

`/agents` (public) and Settings → Your agent start with **Paste this into your agent**: plain text from `agentInstructionsText()` in `mcp-server/private-onboarding-views.mjs`. It is complete on its own: the MCP URL, sign-in setup for Claude, Claude Code, ChatGPT and config-file clients, and the first calls (whoami, then a small search). It says the agent does not need to open any page, and it contains no key or token, so it is safe in chat. Before this, the only copy was the raw JSON with a Bearer key ("Copy agent setup"). An agent given that, or a link, asked to read the web page first.

