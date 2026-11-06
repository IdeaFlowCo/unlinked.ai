# Durable archive import

The standalone account runtime stages the original ZIP/CSV in owner-private assets
and commits its Noos `uploaded` receipt before redirecting the browser to `/profile`.
The upload action records a versioned retention/AI-processing disclosure; production shared People uploads use `public-professional-archive-openai-v2`, while older/private receipts remain narrow. There is no additional consent checkbox. Replays do not broaden older receipts.

A process-wide worker discovers pending imports through the trusted private Noos
store, runs up to eight jobs concurrently while serializing each owner's jobs,
obtains a fresh owner-authorized backend, and claims a CAS lease lasting 180 seconds. Jobs defer while account deletion holds the owner lock. Profile, Positions, Education and Skills observations are staged before
connection batches. The profile boundary has its own immutable chunk, so the own
profile can appear before connection ingestion. Browser navigation or closing the
browser does not cancel the worker. A restart resumes expired leases using the
same archive digest, parser version, owner, source and assertion IDs.

Every progress update increments the Noos revision and commits an immutable
receipt. Delayed publishers cannot overwrite a newer lease or tombstone. Progress
counts describe durably staged observations. `counts.indexed` remains zero until
one final publication fence makes all accepted observations searchable together.
The previous bounded parser and private per-owner assets remain authoritative;
there is no independent jobs/people database or live fixture substitution.

Authenticated `/imports/:id/status` returns only the caller's job status/progress.
`/profile` may read its own staged profile observations, with owner and live-job
checks before and after reads. Owner AI/MCP still require terminal publication and the
recorded upload disclosure. Before an uploaded profile is available, browser
identity follows the [profile source contract](signup-profile-lookup.md#public-projection-and-export-precedence), rechecked through the live owner binding.
Owner-network browsing/search can include confirmed recovered directed contacts even when the owner has no imports; revoked links disappear on read.
It can also include sanitized recovered Storage Connections observations for the same confirmed owner; original recovered files remain browser-only under Settings and never become agent-readable.
Everyone search uses only the separate public professional projection. `/network` and `/settings` rediscover pending jobs on
return; technical receipts remain accessible under Settings. Pending progress is
polled under the controller's CSP nonce and same-origin session.

The composition requires the Noos pending-job and owner job-history methods;
older Noos artifacts fail startup rather than silently reverting to synchronous
processing. Synthetic fixtures require the explicit synthetic environment. The
existing runtime must remain serving until reviewed source and Noos graph CI pass,
then an exact-artifact rollout with fresh paired backup proves live continuation.

Focused tests execute stage/reopen, crash after profile before connections,
1,001 complete connections plus two profile observations, lost response replay,
lease expiry, two owners, a deletion/publication race, and native HTTP upload with
the browser controller stopped before a replacement worker finishes. The local
filesystem contract fixture is not Noos/auth/model or live-browser evidence.
Noos graph-backed source CI separately verifies discovery, CAS/replay, active-owner
and tombstone boundaries. Actual live background continuation remains a release
acceptance, distinct from earlier synchronous full-archive receipts.

Successful/denied callbacks now emit a private bounded audit containing timestamp,
origin and owner hash or a fixed denial category. No email, subject, cookie, token,
authorization URL, query or archive content is logged. Audit availability does not
grant authority or block a valid callback.

## Several files and stacked imports

`/upload` accepts up to `MAX_UPLOAD_FILES` (10) `archive` files in one native multipart submission, within the same total request limit. The picker allows multiple selection; dropping files on the upload box adds them to the same file input (a later drop adds to the list, duplicates by name and non-ZIP/CSV files are ignored), so the form still submits natively without script. Each file is staged as its own import job with its own receipt. Imports stack: the owner network reads every published import together and shows one entry per person, so a Connections file split in two, a full export and a later export add up and nothing is replaced.

Parser `linkedin-archive-v7` added numbered Connections parts and headerless continuation parts. Receipts staged by v6 still run after an upgrade; they keep `parserVersion` and record `parsedWith`.


## Worker observability

The import worker reports to the private audit file (`audit/browser-events.jsonl`) and, as one JSON line
prefixed `unlinkedImportWorker`, to the runtime container log. Events carry only the opaque import id,
fixed lower-case codes and numbers; never names, emails, filenames or rows.

| Event | When |
|---|---|
| `import_job_finished` | A run ends terminal: `status`, `phase`, `durationMs`, `accepted`, `rejected`, `indexed`, `failedFiles`, `sources` (and `attemptsBeforeSuccess` after failures). Once per job per process. |
| `import_job_running_long` | A single run is still going after 10 minutes (`elapsedMs`). A long delay with no error. |
| `import_worker_retry` | A run threw: `reason` (fixed code or `unknown`), `attempt`, `failingForMs`. Reported at attempts 1, 2, 4, 8, ... |
| `import_worker_stuck` | The same job failed a fifth time in a row. Reported once. |
| `import_job_not_runnable` | Discovery keeps returning a job this worker never runs (unsupported `backgroundVersion`). |
| `import_worker_discovery_failed` | Listing pending jobs failed: `reason`, `attempt`, same 1, 2, 4, 8 throttle. |

When the audit file would pass 8 MiB it is renamed to `browser-events.1.jsonl` (one previous file kept)
and `private_audit_rotated` is logged. A single runtime process must own this audit file; it serializes
all appends and rotations through one in-process queue with an inode check. Do not share the audit
directory between runtime processes. The queue is limited to 64 writes, and each caller waits at most
five seconds; timeouts and dropped writes are counted in rate-limited `private_audit_dropped` logs. Worker event delivery never waits for
the audit write, and worker events remain available in the container log.

Operator triage for a slow import: `docker logs <runtime> 2>&1 | grep unlinkedImportWorker | grep <import id>`.
No `import_job_finished`, no retry and no `running_long` means the worker never picked the job up.
