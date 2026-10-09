# Signup profile lookup

`/find-me` can offer an optional, operator-configured public profile lookup.
It is off by default. When enabled, it only runs after the recovered legacy
slug/name lookup finds nothing. Only a validated `linkedin.com/in/<slug>` URL
can trigger it. Bare slugs still work for legacy lookup but never trigger a
lookup. Encoded and decoded Unicode slugs match the same way. A legacy match,
including one that is already claimed, never uses lookup budget.

The lookup itself is a private module on the host, not part of this
repository. `mcp-server/signup-profile-lookup.mjs` defines the adapter contract
and enforces every guardrail around it: URL validation, budgets, pacing,
caching, field whitelisting, confirmation and storage.

The card says **from your public LinkedIn profile** and shows the name,
headline, location, experience and education. The runtime CSP permits only
same-origin images, so the card uses initials and never keeps a photo. A lookup
is only a preview. **Yes, that's me**, with the current session's CSRF and
candidate tokens, confirms a self-asserted public professional profile. Adapter
errors and raw adapter output are never logged, audited, sent to the browser or
saved to the graph. Confirming or skipping returns to `/profile`.

LinkedIn **Share my profile** URLs may include tracking parameters or fragments; signup normalization drops these after validating the exact HTTPS LinkedIn origin, before legacy and provider lookup. Invalid/shortened links get an explicit validation message rather than being fetched or treated as a failed person search. Lookup failures retain the entered URL and distinguish disabled service, no result, timeout, provider refusal and temporary errors. A missing result never claims a profile or proves the person is absent from LinkedIn.

## Adapter contract

The adapter module's default export (or its named exports) must provide:

```js
lookup(slug, { signal }) -> Promise<{
  name,                       // required
  headline?, location?, about?,
  positions?: [{ title, company, startDate?, endDate?, description? }],
  education?: [{ institution, degree?, startDate?, endDate? }],
  skills?: [string],
} | null>
```

- `slug` is the normalized profile slug. `signal` aborts at the configured
  timeout. The runtime enforces that deadline even if the adapter ignores the
  signal.
- `null` means no public profile was found.
- Failures throw an `Error` whose `code` is `unavailable`, `timeout` or
  `refused` (`ProfileLookupError` in the module shows the shape). Any other
  error counts as `unavailable`.
- The runtime treats adapter output as untrusted. Only the fields above are
  kept, with length and count limits. Anything else, such as identifiers,
  contact details or photos, is dropped. The adapter gets no graph access,
  member identity or session data.

## Host setup

The runtime loads the adapter once at startup using a dynamic import. If any
check fails, lookups stay off and one fixed-code line is written to stderr
(`profile_lookup_disabled: <reason>`). Profiles that were already confirmed
stay readable.

1. Put the adapter module under the fixed private root
   `/srv/unlinked-private-guest-pilot-20261001/runtime/private/`. The runtime
   container already mounts that path read-only. The module must be a regular
   file. It cannot be a symlink or sit under a symlinked directory. It must be
   owned by the runtime user (`PILOT_UID`), with mode `600` or stricter. For
   example:

   ```bash
   R=/srv/unlinked-private-guest-pilot-20261001/runtime/private
   sudo install -d -m 700 -o "$PILOT_UID" -g "$PILOT_GID" "$R"
   sudo install -m 600 -o "$PILOT_UID" -g "$PILOT_GID" adapter.mjs "$R/profile-lookup-adapter.mjs"
   ```
2. Add the adapter's own settings to the private `runtime.env`, which Compose
   passes via `env_file`. The adapter documents those settings itself.
3. Set `UNLINKED_PROFILE_LOOKUP_ADAPTER` to the module's absolute path. You can
   also set limits:

| Variable | Required / default | Meaning |
| --- | --- | --- |
| `UNLINKED_PROFILE_LOOKUP_ADAPTER` | Required | Absolute, normalized path under the private root above. Missing means off |
| `UNLINKED_PROFILE_LOOKUP_DAILY_CAP` | `150` | Global lookups per UTC day, including failures. `0` blocks new lookups. Maximum `1000` |
| `UNLINKED_PROFILE_LOOKUP_PACING_MS` | `4000` | Minimum spacing between lookups. At least 4000, at most 60000 |
| `UNLINKED_PROFILE_LOOKUP_TIMEOUT_MS` | `12000` | Per-lookup deadline, 1000–30000 |

4. Restart the runtime. To turn the feature off, unset
   `UNLINKED_PROFILE_LOOKUP_ADAPTER` and restart.

No web build variables or public configuration are needed.

## Limits and failures

There is no automatic retry or background queue. A busy gate, cap, timeout,
not-found result, or adapter or storage failure returns a typed result with a
friendly notice. The member can continue with a name-only profile and add an
export later. They can retry manually, with at most three lookups per Unlinked
account (one attempt plus two retries). After one success, that account can
show the same result again but cannot look up a different profile.
Normalized slug results are cached across accounts and need no further lookup,
as long as no other active account has confirmed that slug.

Neo4j stores:

- quota reservations: `UnlinkedSignupGate` (gate id `profile-lookup`) and `UnlinkedSignupLookup`
- whitelisted profile caches: `UnlinkedSignupCache`
- confirmed self-asserted sources: `UnlinkedSignupProfile`, source `self-asserted-public-profile-v1`

A unique nullable `activeSlug` claim stops two accounts from confirming the
same normalized slug. Lookup refuses a slug that another active account has
confirmed before it serves the cache, and checks again when a lookup finishes.
Stale cards still fail at the durable confirmation transaction. Refusal audit
records contain an owner hash and a typed reason. They never contain the slug
or profile data.

Deleting the source releases the claim. A legacy upgrade clears `activeSlug`
inside the retirement transaction and keeps the record. When an owner becomes
inactive, their source is retired as the claim is cleared, so reactivating that
binding later cannot publish an identity someone else now holds. At startup,
existing active sources are backfilled under the uniqueness constraint. If
existing active claims conflict, startup fails closed rather than choosing a
winner. Unique constraints and a locked singleton serialize reservations across
processes and restarts. In-flight leases block concurrent lookups, and pacing
lasts at least the configured interval after each lookup completes. Attempts
are reserved before the adapter is called, so failed and crashed lookups still
count. Source readers stay available while the feature is off.

## Public projection and export precedence

Only confirmed sources with an active exact owner/user binding enter the live
shared People projection. They count as members and appear right away at the
stable `/people/member-signup-<account-hash>` address. They are separate from
recovered legacy claim evidence and from operator `curated-enrichment-v1` data.
Server-side account resolution recognizes confirmed legacy profiles, active
signup sources and public-consent member imports. An account's public identity
id is the first that exists of: its confirmed legacy id, its active signup id,
or its newest live public-consent import id. Shadows confer no account
authority. The signup source reader is limited to 1,000 active profiles. If
there are more, the shared read fails explicitly rather than publishing a
truncated list.

A later public-consent export from the same owner/user supersedes the signup
profile, using the newest valid import that includes a profile. It keeps the
signup public id, maps connection edges onto it, and aliases `member-import-*`
ids to it, so there are no duplicate member profiles. Import snapshots that
have not changed stay immutable. Retracting an import restores the signup
source. Owner revocation removes both from the live public index. Before the
combined snapshot is returned, a final read checks the active source receipts.
For a confirmed legacy identity, imports instead overlay the existing legacy
id and canonicalize their edges onto it while the link and import stay live.
Revoking the link removes that overlay and restores the recovered public
profile. Public upload overlays retain the prior LinkedIn address only when
the upload omits it; identity merges fill missing professional links without
overwriting the surviving profile's fields.

The browser `/profile` page and member card show the first available of: the
uploaded profile, a live confirmed legacy profile, the active signup source, or
the sign-in display name. On `/profile`, missing LinkedIn and website links
are filled from the live legacy profile, then the signup source, then the
owner's published profile. Published company, industry and location fill only
missing fields; a published company is not added when uploaded positions exist.
Optional legacy or signup read failures do not block a valid owner-authorized
upload on `/profile` or `/card`; owner/upload authorization failures still
reject the request. The HTTP regression is in `tests/profile-card.test.mjs`.
The card's QR target must resolve in the published People snapshot.
A failed source read never supplies an unverified public target. The OpenChat
failure boundary is also covered in `tests/openchat-profile-action.test.mjs`.
**Download everything** includes the confirmed source and its
receipt, labeled as a self-asserted public profile. Account deletion erases the
confirmed source and the stored lookup profile, invalidates unfinished lookups,
and keeps only the hashed account key, attempt count and success flag. That
quota state stops deletion or a new session from bypassing the lookup budget.
A deleted successful lookup cannot be recovered through the slug cache.

## Verification

`npm test` uses fake in-process adapters only and never performs a real lookup.
It covers adapter loading (path, file type, symlinks, owner, mode and contract),
startup wiring, field whitelisting, URL validation, legacy bypass, the
default-off setting, account and global budgets, pacing and concurrency, cache,
typed failures, deadline enforcement, CSRF/candidate binding, confirmation
writes, membership, revocation, aliases and export precedence, plus executable
HTTP, card and projection tests.

`tests/signup-profile-lookup-neo4j.test.mjs` also runs the production Cypher
against a disposable loopback graph that you supply explicitly. It uses the
existing `UNLINKED_TEST_NEO4J_URI`, `UNLINKED_TEST_NEO4J_PASSWORD` and
`UNLINKED_TEST_NEO4J_DRIVER` opt-in contract. It checks concurrent
reservations, durable cache and account limits across instances, retry and cap
behavior, confirmation writes and active-owner filtering. Never point it at a
shared runtime or production database.

## Upgrade to a recovered legacy profile

If another session confirms a non-test recovered legacy profile, that profile
becomes the account's single public identity. `profile-source-boundary.mjs`
extends the Noos managed write transaction used for recovered confirmation and
the self-claim transaction. Both take the same active owner row lock that
signup confirmation uses, then retire the signup source inside the legacy
transaction. An error in either the native confirmation or the retirement
rolls back both writes.

The retained signup record carries `retired`, the retirement time, the legacy
profile and receipt ids, and an explicit upgrade reason for audit and undo. It
never enters the public projection again. The owner's account export includes
the retired source with that status. No signup fields are merged onto the
legacy profile. Retirement clears the unique slug claim, so another eligible
account can claim the slug. Later signup confirmation fails while the legacy
claim exists. Undo is an operator task: this change adds no undo action and
never revives a retired source automatically. Account deletion removes both
active and retired signup records.

The tests cover two authenticated sessions holding different candidates,
concurrent legacy and signup confirmation, and a disposable real-Neo4j HTTP
race with rollback fault injection at both confirmation and retirement.

`tests/signup-slug-claims-neo4j.test.mjs` uses the same disposable loopback
contract to race two accounts with separate reservation gates. This proves the
unique constraint works on its own, apart from normal transaction locking. It
also checks that a second confirmation is rejected, that deletion and legacy
upgrade release the slug, initialization backfill, and constraint enforcement
against direct duplicate writes.
