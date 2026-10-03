# Public LinkedIn profile at signup

`/find-me` first uses the recovered legacy slug/name lookup. Only when neither
matches, a validated `linkedin.com/in/<slug>` URL can trigger the server-only
Unipile fallback (`mcp-server/signup-linkedin.mjs`). Bare slugs remain supported
for legacy lookup, but never trigger Unipile. Encoded and decoded Unicode slugs
are matched consistently. Existing or already claimed legacy matches do not
consume a provider read.

The card says **from your public LinkedIn profile** and shows the name, headline,
location, experience and education. The current runtime CSP permits only
same-origin images, so this flow uses initials and does not retain remote or
`data:` photos. There is no extra consent step. Lookup is only a preview;
**Yes, that's me** with the current session's CSRF and candidate tokens confirms
a self-asserted public professional profile. No key or raw provider response is
logged, audited, sent to the browser or saved to the graph. Provider responses
are streamed with a 1 MiB limit; only bounded professional fields are mapped.

## Runtime configuration

Set these in the standalone runtime's private `runtime.env` (already passed by
Compose `env_file`). No web build variables or public configuration are needed.
The fallback is off if any required value is absent or configuration is invalid.

| Variable | Required / default | Meaning |
| --- | --- | --- |
| `UNLINKED_UNIPILE_BASE` | Required | HTTPS workspace origin or existing `/api/v1` base; calls resolve to `/api/v1/users/<encoded-slug>` |
| `UNLINKED_UNIPILE_KEY` | Required | Workspace API key; sent only in server-side `X-API-KEY` |
| `UNLINKED_UNIPILE_ACCOUNT_ID` | Required | One shared connected LinkedIn account |
| `UNLINKED_UNIPILE_DAILY_CAP` | `150` | Global provider attempts per UTC day, including failures; `0` blocks new reads; maximum `1000` |
| `UNLINKED_UNIPILE_PACING_MS` | `4000` | Minimum spacing, cannot be less than 4000; maximum 60000 |
| `UNLINKED_UNIPILE_TIMEOUT_MS` | `12000` | Provider request/body timeout, 1000–30000 |

`account_id` and `linkedin_sections=*` are passed on the profile read. Redirects
are refused. No automatic retry or background queue runs. A busy gate, cap,
timeout or provider/storage failure returns a typed result with a friendly
notice; the member can continue with today's name-only profile and add an export.
They may retry manually, with at most three provider attempts per Unlinked
account (one attempt plus two retries). After one success, that account can
re-display that same result but cannot look up a different profile. Normalized
slug results are cached across accounts and require no further provider view.

Neo4j stores quota reservations (`UnlinkedSignupGate`, `UnlinkedSignupLookup`),
whitelisted profile caches (`UnlinkedSignupCache`), and confirmed self-asserted
sources (`UnlinkedSignupProfile`). Unique constraints and a locked singleton
serialize reservations across processes and restarts; in-flight leases prevent
concurrent reads, and pacing continues for at least the configured interval
following completion. Attempts are reserved before fetch, including failed or
crashed requests. Startup keeps source readers available even with the feature
disabled, so disabling new reads does not remove already confirmed profiles.

## Public projection and export precedence

Only confirmed sources with an active exact owner/user binding enter the live
shared People projection. They are members, appear immediately at the stable
`/people/member-linkedin-<account-hash>` address, and are distinct from recovered
legacy claim evidence and operator `curated-enrichment-v1` data.

A later public-consent LinkedIn export from that same owner/user supersedes the
signup profile, using the newest valid profile-bearing import. It keeps the
signup public id, maps connection edges onto it, and aliases `member-import-*`
ids onto it, avoiding duplicate member profiles. Unchanged import snapshots
remain immutable. Retraction of an import restores the signup source; owner
revocation excludes both from the live public index. A final source read fence
checks active source receipts before returning the combined snapshot.

The member card uses this source for identity when no import or legacy profile
is available. Its QR target must resolve in the published People snapshot.
Download everything includes the confirmed source and receipt, explicitly labeled
as public LinkedIn data confirmed by self-assertion. Account deletion erases the
confirmed source and retained account lookup profile, invalidates unfinished
lookups, and keeps only the hashed account key, attempt count and success flag.
That quota state prevents deletion or a new session from bypassing the lookup
budget; a deleted successful lookup cannot be recovered through the slug cache.

## Verification

`npm test` runs mocked Unipile reads and executable HTTP/card/projection tests,
including URL validation, legacy bypass, default-off configuration, account and
global budgets, pacing/concurrency, cache, typed failures, CSRF/candidate binding,
confirm writes, membership, revocation, aliases and export precedence.
No test calls live Unipile.

`tests/signup-linkedin-neo4j.test.mjs` additionally executes the production
Cypher against an explicitly supplied disposable loopback graph, following the
existing `UNLINKED_TEST_NEO4J_URI`, `UNLINKED_TEST_NEO4J_PASSWORD` and
`UNLINKED_TEST_NEO4J_DRIVER` opt-in contract. It verifies real concurrent
reservations, durable cross-instance cache/account limits, retry/cap behavior,
confirmation source writes and active-owner filtering. Never point it at a
shared runtime or production database.

## Upgrade to a recovered legacy profile

When another session confirms a legacy profile, that legacy profile becomes the
account’s single public identity. `profile-source-boundary.mjs` extends the
Noos managed write transaction for recovered confirmation and the self-claim
transaction: both acquire the same active owner row lock used by signup
confirmation, then retire the signup source in the legacy transaction. An error
in either the native confirmation or retirement rolls both writes back.

The retained signup record carries `retired`, retirement time, legacy profile
and receipt ids, and an explicit upgrade reason for audit/undo. It never enters
the public projection again; the owner’s account export includes the retired
source with that status. No signup fields merge onto the legacy profile.
Subsequent signup confirmation fails while the legacy claim exists. Undo is an
operator concern; this slice does not add an undo action or automatically revive
a retired source. Account deletion removes active and retired signup records.

The tests include two authenticated sessions holding different candidates,
concurrent legacy and signup confirmation, and a disposable real-Neo4j HTTP
race with rollback fault injection at both confirmation and retirement.
