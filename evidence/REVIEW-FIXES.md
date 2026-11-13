# Native community chat review fixes

All reported defects were confirmed in the submitted source, except that this
HEAD already normalized flyer slugs inside the browser handler. Full readable
flyer login/signup regressions were added without changing authentication.

- R1: `UnlinkedGroupChatJob` is included in the real graph recovery domain,
  including its unique ID constraint and both pending and acknowledged state.
  Recovered group deletion detaches the migration ledger edge.
- R2: jobs contain only chat inputs; deletion immediately drops private group
  metadata and accepted roster. Acknowledgement removes documents, snapshots
  and retry state. Deleted receipts retain only ID, revision and completion.
- R3: the existing block authorization boundary is preserved. Block/unblock
  enqueue revisions through the member-block service; the worker also rotates
  through managed groups to version identity/account access changes and repair
  interrupted callbacks. The organizer binding cannot silently transfer.
- Lifecycle: snapshots are persisted once with revision CAS and replayed on
  retry. Existing groups stay unmanaged across startup and edits. The domain
  activation service requires the live organizer, verified existing conversation
  and backend/native health proof from a trusted injected adapter. New groups
  are automatically managed. Only managed groups show native entry. Boulder’s
  binding remains `44HsMDzl6YZ7l1AdNusAT` in the activation regression.

## Focused verification

One focused run passed: **25 tests, 0 failures, 0 skipped**.
Full TAP output: `evidence/review-focused-tests.log`.

The run used the existing cloud job
`/home/jacob/agent-jobs/native-community-chat-20261113` dependencies, the existing
Neo4j fixture at loopback port 8926, and the installed driver from the paired
OpenChat job. Worktree JavaScript modules were sent to a Node loader in memory;
no cloud source checkout was written. Recovery additionally used two disposable
cached `neo4j:5.26.0` containers with tmpfs data, removed by test teardown.

Executed tests from `community-chat`, `community-chat-recovery`,
`community-intake`, `collective-groups`, `report-and-block` and
`private-composition`, filtered to community lifecycle, flyer/auth, metadata
limits, block safety and launcher behavior. This was neither the complete
repository suite nor a lint gate. No production restart, deployment, push or
pipeline-control operation was performed. Production backend qualification and
post-health activation/migration remain the outer executor’s delivery work.
