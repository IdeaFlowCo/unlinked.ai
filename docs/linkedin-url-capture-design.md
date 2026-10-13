# Design recommendations: pasted LinkedIn URLs and a connection queue

Status: recommendations only (unlinked-8dm companion). Nothing here is
implemented; `/scan`, `/meet`, `src/utils/meet-scan.js` and the search surfaces
are owned by the integrating session. The connection-queue section is a plan,
not a build order. Agentbook is tracked, not designed here.

## 1. Paste a LinkedIn URL on /scan and /meet

**Goal.** A member who has someone's LinkedIn address (pasted text today, QR
later) lands on the right Unlinked person — or a useful preview — without ever
claiming anything.

**Resolution order (must hold everywhere a URL is accepted):**

1. **Existing person first.** Normalize through the existing person grammar
   (`linkedinUrl` in `src/utils/private-import/archive.mjs`, slugs compared
   percent-decoded via `normalizeLinkedinSlug` in
   `mcp-server/connection-identity.mjs`). Resolve in this order: the viewer's
   own people (`publishedPeopleFor` already maps rows to published persons),
   then the public index's slug lookup (the self-claims slug index used by
   find-me). A hit opens `/people/<id>` — the ordinary public page, with
   Connect/Message already on it.
2. **Live provider preview when absent.** When no person matches and the
   operator-configured signup lookup is available, reuse the
   `signup-profile-lookup.mjs` adapter contract (bounded quota, durable cache,
   adapter specifics out of this repo) to render a read-only preview card:
   name, headline, location, "Not on Unlinked yet", with two actions — *Add to
   my people* (the existing `/people/add` write, prefilled) and *Invite*.
   Lookup unavailable or over quota → fall back to the same two actions with
   just the slug shown. The preview is display-only: it never creates a public
   profile, person node or connection by itself.
3. **Never self-claim.** A pasted or scanned URL is evidence about a page, not
   about the person holding the phone. Ownership continues to flow only
   through the existing confirm flows (`/find-me` "Is this you?", legacy
   claim). The paste surface should not even offer a claim button; if the
   resolved person is the viewer's own profile, show "This is you · My
   profile" (the existing `connect.state === 'self'` affordance).

**Placement.** `/scan` gets a third affordance inside the existing Scan tab —
"Paste a link instead" with a single text input — rather than a new tab; it
submits to the same resolver the QR path uses, so `classifyMeetCode` stays the
single classifier and gains a `linkedin-url` kind beside the two existing ones.
`/meet` keeps its rule that nothing opens without an explicit confirm: the
resolved person (or preview) renders as the confirm card. Keep the current
visual language — card, avatar/initials, `profile-links` row — no new styling.

**Boundaries.** Rate-limit lookups per session like other public reads; log
nothing about pasted URLs beyond the existing request-diagnostics rules; the
paste field must accept only the LinkedIn person grammar and plain slugs —
free-text search already belongs to the header omni-search.

## 2. LinkedIn connection queue (plan only)

**Product shape.** A member marks people (resolved persons or previews from §1)
as "to connect on LinkedIn". The queue is ordinary durable member data — one
record per target per owner, mirroring `member-connections.mjs` patterns:
caps, cooldowns, explicit member review before anything sends, full removal
with the account. Ship the queue + review UI first; the *sending* transport is
pluggable and chosen per member later.

**Sending backends compared:**

| Option | How it sends | Strengths | Costs / risks |
|---|---|---|---|
| Agent skill check-in | The member's own agent (MCP grant) pulls queued targets and drives the member's logged-in browser locally | No new infra; reuses grant auth + consent; member's own session (cleanest ToS posture) | Needs a running agent + browser; UI-selector fragility; pacing must be enforced product-side |
| Chrome extension, "next open" | Extension holds a drained-slowly queue; acts only while the member is actually on linkedin.com | Most human-indistinguishable; action is visible to the member as it happens; works for non-agent members | Build/distribute/review an extension; only progresses when the browser is open; another codebase |
| Link Claw app | Native companion app owns the LinkedIn session and executes the queue | Deepest control; background operation; one place for session health | Separate app to install/maintain; platform-limited; concentrates session custody in our code |
| Unipile | Hosted third-party API (member connects LinkedIn account to vendor) | Fastest to ship; no client software; API-grade status/webhooks | Member's LinkedIn credentials/session held by a vendor — against the product's privacy posture; per-account cost; centralized ToS exposure |

**Recommendation.** Queue and review UI product-side now; execute member-side.
Primary: the Chrome-extension "next open" model (best detection and consent
story), with the agent-skill check-in as the second transport sharing the same
queue API — they are the same contract (pull N targets, report outcomes, honor
cooldowns). Treat Unipile as an explicitly opt-in managed lane only if a member
accepts vendor custody in its own consent step; do not make it the default.
Link Claw folds in as a transport if/when the app exists — it should speak the
same queue API rather than getting a bespoke one. Whatever transport, outcomes
write back as observations ("request sent on LinkedIn", date), never as
Unlinked member-connection state.

## 3. Agentbook (track only)

Chatting with another person's agent from their profile is tracked as its own
ticket and intentionally not designed here; it must not piggyback on the
connection queue or the messaging recipient service.
