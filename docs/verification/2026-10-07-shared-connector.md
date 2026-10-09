# Shared connector verification

Adapter release: b17b5cc4de17c10284c0cda67ee3ace0effd08d6, PR #111.
The runtime-only guarded rollout preserved graph/ingress containers and wiring.
A dedicated gateway secret was installed without exposing personal keys.

Production assertions verified at `/api/connector/mcp`:
- Valid but unmapped subject: 409 `account_link_required`.
- Replay, wrong audience, ungranted scope and changed body: 401.
- Public agents page and all discovery documents: 200, shared hub link present.

Browser verification: 1280×900 and compact 500×844 (Chrome minimum width); no
horizontal overflow, visible Connect an agent action. Evidence retained in
`/tmp/unlinked-nf4-agents-desktop.png` and `/tmp/unlinked-nf4-agents-phone.png`
on M4. The shared gateway end-to-end OAuth/tool test is a separate coordinated
release check; this receipt alone does not assert all three apps are live.

CI: 678 passed, 16 optional integration tests skipped. Focused adapter/OAuth/
composition/discovery suite: 29 passed; onboarding/adapter suite: 42 passed.
The full CI caught the Settings account row order; the connector card was moved
under Your agent, retaining the existing compact signed-in row without weakening
the test. Production review also labels the legacy direct connector optional.
