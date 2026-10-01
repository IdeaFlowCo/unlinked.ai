# Bounded deployment preparation receipt

Bead: `unlinked-b3q`.
Base product commit: `55114ae338bb2c0c7527de8b14b45699a74760b6`.
Branch: `prep/unlinked-b3q-private-pilot-20261001`.
Worktree: `/Volumes/External_SSD/code-overflow/unlinked-private-pilot-deploy-prep-20261001`.
Only new `deploy/private-pilot/` files are owned by this change.

The default plan returns `status: blocked`, `mutations: false` and lists missing approved source receipts/checkouts, reviewed wiring, images, client/DNS/TLS/private inputs and actual operation approvals.
No deployment, provider registration, credential read/copy, DNS/TLS mutation, container/graph start, live guest claim, paid resource, push or merge occurred.
The consumer checks operate exclusively on temporary synthetic files and mock Docker subprocesses while exercising paired snapshot/restore, manifest/file integrity, canonical backup-root rehearsal targets, production-target and overwrite refusal, symlink rejection, parent-mode and racing-creation denial, unsafe target/image refusal, sudo-only Docker invocation, nonsecret Compose interpolation and foreign-container refusal.
`node --check deploy/private-pilot/runtime.mjs` passed.
`topology-check.py` consumed `compose.yaml` through Docker Compose config normalization with synthetic images and no private env reads; it confirmed the three owned services, internal/frontend bridges, no app/graph publication, graph `umask 077` entrypoint, private runtime parent tmpfs, private operations, non-root TLS port and zero added capabilities.
`root-mount-check.py` is the bounded real-Docker counterfactual for this topology: generated child bind fixtures persist, the runtime child remains read-only, the graph/provider/secrets/ports stay absent, and only the explicit parent tmpfs changes the root privacy guard from before=false to after=true.
Invoking `runtime.mjs` without approved env/composition returned exit 2 and only `private_pilot_runtime_dependencies_unavailable`.
No full service launch or nginx binary configuration test was performed, so actual image compatibility, nginx startup and runtime composition are not claimed.
Final graph/model/invitation receipts and the production composition adapter remain with the sole application writer and are not inferred from this packet.
Production provider/client registration remains with the identity owner; private DNS/TLS, exact persistent secret destinations and invitation activation still require their actual operation authority.
Real Javier acceptance and operational graph/blob restore readback remain `unlinked-9a9`.
