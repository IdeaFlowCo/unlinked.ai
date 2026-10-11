# Signed-in Home

`GET /` for a signed-in member (unlinked-5e5). Signed-out visitors keep the product landing page.

## Import status

`summarizeImports` (`src/utils/private-import/import-summary.mjs`) is the one answer to "has this member imported?" for Home, `/import`, `/profile` and Settings. It counts both sources that the agent `unlinked_whoami` tool and the export reminder email already count:

- uploads to this runtime (durable import jobs; hand-added people excluded);
- LinkedIn files recovered from the member's original Unlinked account (`readLegacyFiles`, with each file's original upload time), or, with no recovered files, the connections of the confirmed legacy profile.

States: `none`, `in_progress`, `complete`, `partial`, `failed`, and `unknown` (the recovered-files read failed, so absence is not known; Home says the status is unavailable rather than asking for an export). A newer failed or partial upload under an earlier finished import is shown as a notice beside `complete`. The summary only reads; it never changes an import or its status.

## What Home shows

| State | Home |
|---|---|
| `none`, reminder not hidden | The getting-started "Bring your LinkedIn export" step (default on), plus **Hide this from Home** |
| `none`, reminder hidden | Home with a "Not yet" import card, **Import my file**, and **Show the setup guide on Home** |
| `in_progress` | Home; the page's live import banner shows progress and reloads on completion |
| `complete` | Counts and date of the newest finished import (recovered imports name the original account), skipped rows, Import details, and a de-emphasized **Upload a newer export** |
| `partial` / `failed` | The plain-language reason, **Try another file**, Import details |
| `unknown` | "Your import status can't be checked right now" |

Every Home also has a network search, waiting connection requests / notifications / unread messages (the header counts), the five most recently connected people (from LinkedIn "connected on" dates or accepted Unlinked connections; a 2.5 s budget), and links to the profile, My card and agent setup. With an import, `/import` becomes "Upload a newer LinkedIn export" without the getting-started steps.

## Reminder preference

`POST /home/import-reminder` (`reminder=dismissed|shown`, session CSRF) stores one per-account display choice in `UnlinkedHomePreference {ownerId}` (`mcp-server/home-preferences.mjs`, unique on `ownerId`, user-checked on read). It is a UI preference only: it never touches imports, their status or the export reminder email, and it never hides a real import status. Delete everything removes it. The label is in the graph migration's `LABELS`; a runtime rolled back to a release without that label must have these nodes and the constraint dropped before its next shared export (the rollback script for this release does so).
