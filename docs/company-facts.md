# Company facts: the `curated-companies-v1` dataset

Company pages (`/companies/<name>`, `/api/companies/<name>`) show reviewed facts
about a company next to the people who list it. Those facts come from two
layers, merged by `createCompanyFacts` in `mcp-server/company-metadata.mjs`:

1. **Static list**: the reviewed rows committed in `company-metadata.mjs`
   (fetched once from LinkedIn on 2026-10-02). This is the floor and the
   fallback.
2. **Graph dataset `curated-companies-v1`**: operator-published rows (for
   example from the scheduled provider company fetch). This layer is publishable
   data, so updating it needs no code rollout.

Names and aliases match by normalized key, so `Smartcar, Inc.` and
`smartcar inc` are the same key. A graph row wins over a static row that
shares any key with it, and supersedes that static row entirely. Any other
static aliases of the superseded row keep resolving, but to the graph row, so
stale static facts are never served. If another graph row claims one of those
aliases, that row keeps it.

The runtime caches the merged index for 60 s and runs one graph read at a time.
If the graph read fails, or the stored rows fail validation, pages serve the
static list (cached for the same 60 s). They never fail. The runtime prints one
`unlinked_company_facts_read_failed` line to stderr each time a read fails, so
at most once per cache period.

## Storage

Noos's `UnlinkedPublicPeopleStore` only accepts person-shaped rows, so company
rows have their own small labels in the pilot graph
(`mcp-server/company-facts-store.mjs`). The publication model is the same:

| Label | Key (unique constraint) | Role |
|---|---|---|
| `UnlinkedCompanyDataset` | `id` | Pointer to the live revision |
| `UnlinkedCompanyRevision` | `(dataset, revision)` | `staging`, `published` or `deleted`, plus a digest |
| `UnlinkedCompanyChunk` | `(dataset, revision, ordinal)` | Immutable JSON row chunks of up to 128 KiB each, with a SHA-256 |

A revision is `curated-companies-v1:<sha256 of the validated rows>`. Chunks
are written while the revision is in `staging`. One final transaction then
checks the chunk count and moves the pointer, guarded by the revision the
publisher last read. Every read and write is an index seek on these labels.
No query touches `OperationalResource` documents. Reads check each chunk's
hash, the revision digest and the row whitelist again.

## Row schema

The rows file is a JSON array of 1 to 5000 objects. Only these fields are
allowed:

| Field | Rule |
|---|---|
| `name` | **required** string, 1–200 chars |
| `tagline`, `description` | string, 1–2000 chars |
| `industry`, `headquarters`, `founded` | string, 1–200 chars (`founded` is a string, e.g. `"2006"`) |
| `employeeCount` | integer ≥ 0 |
| `website` | `https://` URL without credentials, ≤ 2000 chars |
| `linkedinUrl` | `https://www.linkedin.com/company/<slug>` with an optional trailing `/` |
| `aliases` | array of up to 50 strings, each 1–200 chars |

Every name and alias must normalize to a non-empty key, and no two rows may
claim the same key. Unknown fields, empty strings and `null` are rejected, so
omit a field you don't have.

## Publish (operator, offline)

Write the rows file under the pilot root as the operator, mode 600, and not as
a symlink. Then run the publisher inside the runtime container. Plan mode
validates the file and prints the revision and digests. It makes no graph
connection and no writes:

```sh
docker exec -i unlinked-private-guest-pilot-20261001-runtime node \
  /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/publish-company-facts.mjs \
  /srv/unlinked-private-guest-pilot-20261001/enrichment/companies.json \
  /srv/unlinked-private-guest-pilot-20261001
```

Add `--execute` to publish. The publisher reads back and verifies the
revision, then writes a mode-600 receipt to `audit/curated-companies-*.json`.
The report includes `previousRevision` and `rollback.command`. Running the same
file again is idempotent (`replayed: true`). Pages pick up the change within
60 s.

## Rollback

- **Back to the static list:** revoke the live revision. This marks it
  `deleted` and removes the pointer, and also writes a receipt to `audit/`:

  ```sh
  docker exec -i unlinked-private-guest-pilot-20261001-runtime node \
    /srv/unlinked-private-guest-pilot-20261001/runtime/unlinked/mcp-server/publish-company-facts.mjs \
    --revoke curated-companies-v1:<sha256> /srv/unlinked-private-guest-pilot-20261001
  ```

- **Back to an earlier publication:** run `--execute` again with that earlier
  rows file. Its revision is still `published`, so only the pointer moves.

A revoked revision can't be published again. Change the rows to get a new
revision.
