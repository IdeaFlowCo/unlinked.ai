# Source CI

The public repository runs `Source CI / source` on disposable GitHub-hosted Linux runners for pull requests and main pushes.
Never assign public fork code to the private GCP or production deployment runners.
The workflow has read-only repository permissions, does not retain checkout credentials, and receives no provider or deployment secrets.

Both root and MCP dependencies install from their committed lockfiles with lifecycle scripts disabled.
The [workflow](../.github/workflows/source-ci.yml) uses Node 24, including native TypeScript support, to run the complete `npm test` suite.
Before the suite runs, a runtime import verifies the MCP SDK resolves. If `mcp-server/private-browser.mjs` exists, the preflight also imports it, `private-grants.mjs`, and `private-hosted.mjs`; any import failure fails the job.
Those private modules and their OIDC/grant tests are not yet on main. When the product branch receives this workflow, the preflight prevents missing runtime dependencies from silently skipping those tests.
The MCP TypeScript build is explicit.
Source CI also runs the private deployment consumer checks: `checks.py` with mocked Docker/process boundaries and `topology-check.py` through Docker Compose config normalization with synthetic images and no private env reads.
The real Docker parent-mount counterfactual remains a host acceptance check: `root-mount-check.py` runs a bounded network-none Node container with generated child bind fixtures to prove the unmounted parent would fail the private ownership guard and the explicit tmpfs parent passes it.
Tests use synthetic providers and local fixtures. CI does not provision a graph or call live models; any separate model acceptance evidence belongs to development validation.

No deployment, real account, production auth client, archive ingestion, key provisioning or paid activation is performed.
A registered workflow is not a successful check: report the exact head/check conclusion, including any hosted allocation or billing failure.
