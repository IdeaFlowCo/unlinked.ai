# M5-only roster preparation package — UNRUN

Prepared for the M5 Beeper owner (`a62eb1a8`) to review and run later on M5.
This package has not been executed, including against fictional input. Only
syntax parsing/static review is allowed in this preparation task. No Mac behavior
has been verified by Linux. Do not run it on this cloud host. It uses Node.js
built-ins only and requires Node 20+ already present on the M5; it installs nothing.

WhatsApp source title is VERIFIED: **MIT Early-Stage Investors/Founders Group**,
1,024 participants, 1,023 with phones. No Beeper search or API fetch is needed.
The Unlinked display title **MIT Early Stage Investors & Founders** remains
provisional until Jacob confirms. No WhatsApp invite link is available via API.

## Boundaries

- The raw roster, HMAC key, salt, participant mapping and manifest stay on M5.
- The script runs offline. It has no network imports, Beeper access, upload,
  browser automation, messaging or import code. Its private key is held only by
  the M5-side process/files, never browser JavaScript or the Unlinked server.
- The script refuses non-macOS and requires the expected M5 hostname supplied
  explicitly by its owner. It refuses symlinked final files, hard-linked or
  non-private inputs, non-private state/export directories, mismatched state/key,
  and existing output files. It never overwrites the source or rotates a key.
- Only one prepared file may later travel: three fields exactly,
  `display_name`, `phone_hash`, `participant_id`. No manifest/key/salt, source id,
  raw phone, Beeper chat id or raw source file travels with it.
- Root GO is still required before transfer/real import. Actual import must be
  through **Jacob’s own in-app preview → private-retention acknowledgement**.
  Neither the M5 operator nor an agent should perform an automated server import.

## Local input, normalization and identity

Input is a private UTF-8 JSON array, at most 2 MiB. Each object has `display_name`
and optional `phone`; an optional source `participant_id` may identify the
provider row but is never exported as supplied. No other keys are accepted.
The original file is read only and never copied into state. It must be a regular
single-link mode-600 file owned by the M5 operator. Do not change permissions or
move the real source until its owner has reviewed the workflow.

Phones must already have an unambiguous international `+` country-code form.
The tool normalizes Unicode compatibility forms and strips spacing, parentheses,
periods and common dashes, then validates E.164 shape (7–15 digits). It never
infers a country or validates number ownership. Ambiguous local/numeric-only
numbers abort the whole preparation. Phone-like display names also abort; the
owner must review/redact those locally rather than transferring numbers as names.
The participant without a phone is retained with `phone_hash: null` in JSON or an
empty CSV field. The expected counts are mandatory, preventing silent truncation.

`phone_hash = HMAC-SHA-256(key, JSON.stringify([
  "unlinked-group-phone-v1", manifest.salt, normalizedE164
]))`.

Each roster state gets a random 32-byte secret and independent 32-byte salt.
HMAC outputs are 64 lowercase hex characters. Hashes are private pseudonymous
identifiers, not anonymized data. The salt/key are never sent to GCP/Noos; without
separately authorized compatible M5-side hashes there is no phone matching on
Unlinked. Unlinked’s MVP offers low-confidence name suggestions only.

Participant ids are random UUID v4 values, assigned locally and kept stable in
the private manifest. Its map keys are separately domain-separated HMACs of the
local provider id (if supplied), otherwise phone, otherwise name. Phone/provider identifiers never become output ids. Duplicate selected source identities abort the whole preparation; the M5 owner
must review them locally and provide distinct stable provider ids if they really
represent separate participants. No rows are silently merged/dropped, and
reordering unique source identities does not change UUIDs. With no provider id,
edits to phone-less names change their source identity. UUIDs are import row
identifiers, never proof of a person’s identity. Reuse the same state on subsequent
exports; do not recreate state to retry.

## Later M5-owner invocation — do not run now

The owner must first verify the actual M5 hostname and private local paths.
Use an existing mode-700 parent for the state, and a separate mode-700 export
directory. All paths below are placeholders, not instructions to create or access
anything in this task. The raw roster is never included in this repository.

```sh
node /ABSOLUTE/PACKAGE/prepare.mjs \
  --input /M5/PRIVATE/roster.json \
  --output /M5/PRIVATE/exports/prepared-roster.json \
  --state-dir /M5/PRIVATE/group-prep-state \
  --expected-hostname VERIFIED_M5_HOSTNAME \
  --expected-rows 1024 --expected-phones 1023 \
  --format json --initialize
```

For a later export, omit `--initialize`, reuse the exact state directory/key and
use a new output filename. Do not use `--initialize` to recover a failed run.
CSV is supported with `--format csv`; JSON is preferable to avoid spreadsheet
formula interpretation. The browser importer accepts either prepared format.
A per-state exclusive lock prevents simultaneous runs; after an interruption,
the M5 owner must inspect the stopped process and state before removing a stale
lock. There is no force/unlock/overwrite option.

The script durably saves UUID assignments and an expected output checksum before
creating a new mode-600 output file. `lastExport.state: prepared` means preparation
may have stopped before or during writing; `written` means the output write and
fsync completed. On failure, retain the key/manifest and inspect the output locally;
never upload a partial export. Successful stdout contains counts, output format
and output SHA-256 only, not names, phones, hashes, key or paths.

## Manifest and handoff

The M5 state contains `hmac.key` (32 raw bytes, mode 600), `manifest.json` (mode
600), and a transient `.prepare.lock`. Directory mode is 700. The manifest format
is [manifest.schema.json](manifest.schema.json). It holds algorithm/version,
SHA-256 key identifier, salt, M5 hostname, creation time, the private HMAC→UUID
map, and last-export provenance/checksums/counts. No raw phone is stored in it.
It and the key are kept together on M5 under the owner’s private handling policy;
losing them prevents stable repeat hashes/ids. Do not send them to root/GCP/Noos.

After separate root GO, the M5 owner can hand off only the prepared three-field
file and its output checksum/counts. Jacob must inspect its in-app preview and
acknowledge retention before committing. That import creates pending entries,
not joined memberships. All invitations remain draft-only until Jacob approves
exact recipients and text. No import, deploy, schema migration or outreach is
performed by this package.
