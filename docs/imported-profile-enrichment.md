# Imported profile enrichment

Imported profiles (the copies member uploads mint for each connection,
`public-<row>`, and unclaimed legacy rows) often carry only a name, a headline
and a company from someone's export, so they render as a basic profile.
Operator-published enrichment fills in the standard public fields of the
person's LinkedIn profile: headline, location, about, experience and education
(unlinked-3l8h).

## LinkedIn-keyed datasets

`curated-enrichment-li-1` through `-li-8` (`LINKEDIN_ENRICHMENT_DATASETS` in
`src/utils/public-people/member-projection.mjs`) are Noos public datasets like
the id-keyed `curated-enrichment-*` sets (docs/public-people-reader.md), except
that a row's id names a LinkedIn address, not a profile:
`li-<sha256 of the canonical slug>` (percent-decoded, lowercased), the same
reference suspensions use. The index computes that reference from each
published profile's `linkedinUrl` (`profileLinkedinRef`) and applies the row
when they match. Exact address only: names never match a row to a person.

One row reaches every published profile with that address, including copies
minted by imports published later, so a new member upload is enriched without
republishing.

## What it may change

Gaps only (`fillFromLinkedinEnrichment`): a field is filled only while the
profile leaves it empty, so its own source (a member's upload, an id-keyed
operator row) always wins. The name is never replaced. It runs on the profiles
shown, after every merge and decision, so members and historical members are
never filled in (not even through an absorbed copy), removed and suspended
profiles stay gone, and unlisting is unchanged. Enrichment never adds people or
edges. The rows may add at most 64 MiB of serialized data in all
(`LINKEDIN_ENRICHMENT_TEXT_BUDGET`); a row that would exceed the remaining
budget is skipped, leaving room for smaller rows. The reader's separate
[whole-index and field limits](public-people-reader.md) and the store's
[per-shard limit](public-people-reader.md) still apply.
Hosts can lower the enrichment budget with the in-process
`linkedinEnrichmentTextBudget` option (a safe integer from zero through the
default; zero disables filling). Rows carry only the standard public profile fields the
store accepts (`name`, `headline`, `location`, `about`, `company`, `positions`,
`education`, `skills`); nothing connection-level (dates connected, emails,
notes) exists in the row grammar.

The dataset revisions are part of the index revision, so a publication or
revocation reaches every page within the index freshness window
(docs/public-people-reader.md).

## Publishing

Offline, from a reviewed rows file under the runtime root, through the
runtime's own operator:

```
node mcp-server/publish-enrichment-people.mjs <rows.json> <root> --dataset=curated-enrichment-li-1 [--provenance=<provenance.json>] [--execute]
```

Rows must carry `li-<64 hex>` ids (and id-keyed datasets refuse them). The
revision is content-addressed, so re-running with unchanged rows writes nothing
(`UNCHANGED_NO_WRITES`). The private receipt in `audit/curated-enrichment-*.json`
records the dataset, revision, row count, keying and the optional provenance
record (its source and fetch dates); provenance never enters the public
dataset. Rollback: `UnlinkedPublicPeopleStore.revoke(<dataset>, <revision>)`
removes the whole overlay and the profiles show their own fields again.

The offline row builder and its re-run command live with the operator's
private data sources, not in this repository.
