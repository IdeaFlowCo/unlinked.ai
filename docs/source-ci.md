# Source CI

The public repository runs `Source CI / source` on disposable GitHub-hosted Linux runners for pull requests and main pushes.
Never assign public fork code to the private GCP or production deployment runners.
The workflow has read-only repository permissions, does not retain checkout credentials, and receives no provider or deployment secrets.

Both root and MCP dependencies install from their committed lockfiles with lifecycle scripts disabled.
Runtime module imports verify that MCP dependencies and, when present, private browser/grant dependencies resolve before the complete Node test suite runs.
This prevents absent MCP dependencies from silently skipping the private OIDC, signed-grant and HTTP tests on the product branch.
The MCP TypeScript build is explicit.
Tests use synthetic providers and local fixtures; the separate disposable Neo4j/model acceptance receipt remains development evidence and never consumes an API key in CI.

No deployment, real account, production auth client, archive ingestion, key provisioning or paid activation is performed.
A registered workflow is not a successful check: report the exact head/check conclusion, including any hosted allocation or billing failure.
