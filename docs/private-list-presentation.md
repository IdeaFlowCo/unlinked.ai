# Private list presentation

Open an owner-private graph list from **Lists**, then choose **List** or **Table**.
The standalone runtime supports `?view=list` (default) and `?view=table`.
Both use the same owner-authorized reader and stored membership
order. Table columns are Person and Context: no inferred schema, private-contact
columns, new sharing permission, or additional reads. Full context remains in a
native disclosure; the collapsed preview occupies at most two lines.
On narrow screens, Table stacks each person's name above their context.

View links preserve the current cursor and search. Search submission and Clear
search reset the cursor. Paging, view-switch restoration and Back behavior follow
the [progressive loading contract](private-list-loading.md).
The existing private search transport is unchanged by this presentation slice.

The page title identifies the list and active view. Anonymous access still goes
through authentication and cannot reveal the list title or private contents.
Public People, saved-search sharing, and Social lenses are separate surfaces.

Validation uses fictional records: renderer assertions, HTTP owner/other/anonymous
fixtures, controller paging tests, and desktop/mobile screenshots. This feature
PR alone is not a production release: reconcile it with the exact curated runtime
source, run the existing source-only release checks, and verify the live owner view
before reporting deployment. Never replace that runtime with main wholesale.
