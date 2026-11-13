# Native community chat review, round 3

R6 was confirmed: awaiting the roster callback after committing a block/unblock
could throw away the returned record and prevent downstream OpenChat safety
operations. The member-block service now isolates only callback failures and
returns the committed result with its peer identity intact. Store add/remove
failures remain outside that error boundary and still reject.

Behavioral regressions cover rejecting async reconciliation through the actual
browser block and unblock routes, downstream OpenChat POST/DELETE operations,
connection-request removal, retained peer/account identity, synchronous callback
exceptions, and actual store failures. A community-chat regression proves the
existing periodic audit repairs both missed block and unblock roster changes.

One focused cloud run of `tests/community-chat.test.mjs` and
`tests/report-and-block.test.mjs` passed all **26 tests**, with no failures or
skips. Receipt: `evidence/review-round3-focused-tests.log`.

The run streamed current worktree modules in memory to the existing authorized
cloud job and used its matching installed dependencies and task-owned synthetic
Neo4j fixture at 8926. No cloud source checkout was modified. No production
mutation, restart, installation, complete repository suite, lint gate, push,
or pipeline-control command was performed. All other phases remain with the
outer executor.
