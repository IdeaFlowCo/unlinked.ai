# Contact addresses (unlinked-uwqw)

A signed-in member's own contacts live at readable, owner-private addresses,
for example `/network/contacts/jamie-heywood`, instead of the connection row
id (`/network/contacts/<64-hex privateId>`). Public profile handles
(docs/profile-handles.md) cover only `/people/<handle>`; a contact page is not a
public page, so it gets its own address space.

## Rules

- **Owner-scoped.** A slug is unique within one owner (ownerId + userId) and
  means nothing to anyone else. Two owners can both have
  `/network/contacts/jamie-heywood`, each naming their own row. Another
  owner's slug or row id answers 404, exactly like an unknown id.
- **Private.** Slugs are never published, indexed, given to agent tools or
  shown to other members. Contact pages send `X-Robots-Tag: noindex`.
- **Row ids stay the keys.** Private context, enrichment, the agent contact
  lookup and every store keep using the row id; the slug is only an address.
  `/api/private-context/contacts/:id` keeps the id.
- **Sticky.** A row's slug is assigned once and never changes, so a renamed
  contact or a later public-handle change never breaks an address. A new
  contact that collides takes the next candidate; nobody is moved.
- **Old addresses.** The row-id address, and any other spelling of the slug
  (case), answer `301` to the slug for the same signed-in owner, with
  `Cache-Control: no-store` because the answer depends on who is signed in
  (and so a rollback never leaves a browser-cached redirect behind). A row
  without a slug (assignment pending or failed) keeps rendering at its id.
- **Auth unchanged.** Signed out, every address answers 401 with the sign-in
  page; nothing about the contact is revealed.

## Choosing a slug

The first free one (in this owner's namespace) of:

1. the person's public `/people/<handle>`, when the row resolves to a published
   profile that has one, so one person reads the same in both places;
2. a slug of the contact's name (`nameHandleBase`);
3. the LinkedIn vanity slug the row holds, or the address the owner privately
   attached (docs/contact-enrichment.md);
4. the name numbered: `-2`, `-3`, … `-99`.

The grammar is the handle grammar (`validateHandle`): lowercase, digits and
single hyphens, 3–60 characters, never reserved words or id shapes, so a
segment is either a 64-hex row id or a slug, never ambiguous. Rows whose
person has a public handle are assigned first; the rest go earliest connection
first.

A card whose person has a published profile still links to `/people/<handle>`
on Your people (that page shows the owner's private panel); the contact
page itself stays at its own slug and is not redirected to the public page, so
the private record, details and notes are never lost.

## Where it lives

- `mcp-server/contact-slugs.mjs`: candidates, the registry and the stores.
  Graph label `UnlinkedContactSlug` (`key` = hash of owner + slug, unique
  constraint `unlinked_contact_slug_key`), listed in graph-migration `LABELS`.
- Assignment runs after each account network read for the owner
  (`ensureContactSlugs` in `mcp-server/private-browser.mjs`), waiting at most
  2.5 s; the rest finishes in the background. If the public index is
  unavailable, nothing is assigned until the next read.
- Every emitted contact link goes through `contactPathFor(rowId)` (browser) or
  the private-context `contactPath` option, which fall back to the row id.
- `/export` includes `contactAddresses`; account deletion removes them.
