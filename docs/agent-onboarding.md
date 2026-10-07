# Shared agent discovery and onboarding

Tracking: unlinked-ek0 (2026-10-07).

Default entry: https://id.ideaflow.app/agents?app=unlinked. The shared MCP endpoint is https://id.ideaflow.app/mcp. Client-specific routes and current verification status are owned by the identity gateway's `/agents/guide` and `/agents/clients.json` (source `src/connector-onboarding.js`). Both Unlinked setup renderers and all public discovery surfaces point there. The direct server card continues to describe the existing Unlinked-only endpoint; its `recommendedSetup` field points to shared setup. `unlinked.json.agentSetup` is the shared hub, and `directAgentSetup` retains the old Settings location.

An import is not a connection prerequisite. Public `/search-public` and `/api/people` require no account; actual web-reader compatibility remains separately unverified. Existing direct grants, tool catalogs, HTTP routes and OAuth permissions are unchanged. The Muse custom-API route is documented but untested in the real host. A direct Unlinked grant never authorizes OpenChat or Vision.

The [public agent brief](../public/AGENTS.md#connect-or-search-now) owns connection progress, read verification and data-readiness reporting guidance. Direct identity reads use `/api/agent/v1/whoami` or `unlinked_whoami`; existing typed errors are owned by the [agent API contract](agent-api.md). Do not invent a data-readiness field.

## Verification and limits

Deploy these cross-links only after the companion `ideaflow-auth` branch `feat/agent-onboarding-muse-dots` lands and its central guide routes are deployed. Directory publication and real dot/Muse host acceptance remain external gates; documented setup does not establish either.

- Serve the discovery JSON and setup pages anonymously; private `/mcp` and `/api/agent/v1/` keep their authentication.
- Check JSON URLs and import requirements as contracts, and exercise the actual runtime discovery handler and setup renderer.
- Existing account API tests cover owner isolation, revocation, tool versions, typed errors and read/write boundaries. This change adds no new permissions or transport.
- Check compact and desktop setup rendering and links. Public pages use the established Unlinked shell.
- Actual dot installation remains OpenChat-y650; actual Muse custom connector acceptance requires its authorized host session. Record the first identity/query evidence there before changing compatibility status. Backend tests are not real-host acceptance.
- No new auth scheme, universal API key, anonymous MCP gateway or callback allowlist expansion is required for this onboarding fix.
