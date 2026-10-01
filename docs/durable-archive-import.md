# Durable archive import

The standalone account runtime stages the original ZIP/CSV in owner-private assets
and commits its Noos `uploaded` receipt before redirecting the browser to `/profile`.
The upload action records the existing combined retention/AI-processing disclosure;
there is no additional consent checkbox. Replays do not broaden older receipts.

A process-wide worker discovers pending imports through the trusted private Noos
store, obtains a fresh owner-authorized backend, and claims a CAS lease lasting 180 seconds. Profile, Positions, Education and Skills observations are staged before
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
checks before and after reads. AI/MCP still require terminal publication and the
recorded upload disclosure. `/network` and `/settings` rediscover pending jobs on
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
