# Private list presentation

Owner-private graph lists in the standalone runtime support `?view=list` (default)
and `?view=table`. Both use the same owner-authorized reader and stored membership
order. Table columns are Person and Context: no inferred schema, private-contact
columns, new sharing permission, or additional reads. Full context remains in a
native disclosure; the collapsed preview occupies at most two lines.

View links preserve the current cursor and search. Search submission and Clear
search reset the cursor. Load more checks the list and presentation before
appending, retains native-link fallback, and restores authorized pages on Back.
Only page URLs and scroll position are stored in history, never member contents.
The existing private search transport is unchanged by this presentation slice.

The page title identifies the list and active view. Anonymous access still goes
through authentication and cannot reveal the list title or private contents.
Public People, saved-search sharing, and Social lenses are separate surfaces.

Validation uses fictional records: renderer assertions, HTTP owner/other/anonymous
fixtures, controller paging tests, and desktop/mobile screenshots. This feature
PR alone is not a production release: reconcile it with the exact curated runtime
source, run the existing source-only release checks, and verify the live owner view
before reporting deployment. Never replace that runtime with main wholesale.
