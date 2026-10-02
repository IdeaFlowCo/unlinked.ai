# Recovered legacy LinkedIn files

The offline `mcp-server/legacy-storage-operator.mjs` preserves every object in the pinned database/Storage backup before publishing one immutable private Noos manifest.
It never binds a user, resumes Supabase, changes the public People index or grants agent access to originals.

The verified source contains 592 CSV objects (27,415,960 expanded bytes): 182 map to 14 recovered legacy accounts; 410 belong to 10 source owners absent from the recovered accounts/profiles.
All 181 public upload references match their exact source object and legacy profile owner.
All 592 originals are retained, including 477 other categories and 30 professional files rejected for invalid UTF-8.
The 85 parseable professional files contain 30,320 accepted and 521 rejected records; these are observations, not additional public people or verified relationships.
Unknown owners remain private and inaccessible until separate authoritative mapping evidence exists.

## Publication and rollback

`createLegacyStoragePlan` checks database/ZIP digests, exact blob coverage, source-owner consistency and upload references before any write.
It records each storage row's ordinal, original fields, raw digest/length and parser counts/error; the original database backup preserves upload-row references.
Raw and sanitized JSON assets use the source digest plus original owner in their private key.
The operator writes and verifies all 505 owner-qualified assets before committing the <=1 MiB Noos manifest/fence.
Interrupted asset writes and lost graph responses replay without changing source receipts.
The operator `revoke <manifestSha256>` permanently fences recovery reads without deleting source bytes; graph/assets cold-pair backup and the previous runtime pair remain rollback evidence.

After the reviewed paired Noos/app rollout, run the offline operator only in the existing isolated runtime with private source files in its owned audit directory:

```sh
node mcp-server/legacy-storage-operator.mjs publish /srv/unlinked-private-guest-pilot-20261001/audit/source-database.backup.gz /srv/unlinked-private-guest-pilot-20261001/audit/source-storage.zip
```

No public operator route exists.
Production pins are the verified expanded database SHA and Storage ZIP SHA in `storage-plan.mjs`; a different source requires a separately reviewed plan.

## Owner recovery and search

Only an active exact issuer/subject owner with an explicitly confirmed recovered legacy profile can list/download its originals under Settings.
`GET /api/legacy-files` and `GET /legacy-files/:objectId` require the browser session; bearer agent grants do not authorize them.
The reader checks the current owner/link/publication again after loading bytes, including revocation during a delayed read.
Recovered Connections observations enter that same owner's existing account-network AI/MCP path with immutable object/raw-source provenance.
Only professional fields are eligible: original email/phone/private notes stay out of model context and search results.
Other professional categories remain recoverable originals and sanitized source assets; they do not override the current winning imported profile or become public by this operation.

Source/filesystem tests are distinct from the required Noos disposable real-graph CI and live 592-object publication/readback.
A personal legacy-confirmation/download/MCP receipt remains pending until a legitimate signed session is available.
