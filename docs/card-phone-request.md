# Ask for their number when someone joins from your card

Design, 2026-10-31. Jacob: "There should be an option, when someone scans your
Unlinked card, to request their number for you when they're signing up."

Status: design and ticket (`unlinked-srk9`). Not built.

## The problem

Jacob hands over his card at an event. The person scans it, joins Unlinked and
is connected to him in one step ([Contact card](contact-card.md#sharing-and-joining-from-a-card)).
What Jacob gets back is a `member-connection` row carrying a first name and
nothing else: no profile, no LinkedIn, no number. Thirteen people joined this
way in the first days and every one of them is a name-only contact
([Private contact enrichment](contact-enrichment.md)). Jacob then has to ask
for a number out loud or by message, which is the step the card was supposed
to remove.

## The option

On **My card** (contact version), one switch, off by default:

> **Ask people who join from my card for their phone number.**
> After they join and connect, they're asked once to share their number with
> you. Sharing is optional for them. The number is shown only to you and never
> appears on their profile.

Stored on the owner's `UnlinkedContactCard` record as `askPhone: true`. The
card is the right home: the request is a property of the capability link the
owner hands out, it is read on the same page, and it is exported and deleted
with the card.

## The flow for the person who scans

Nothing changes until the connection exists. Today's path is:

1. Scan → `/c/<token>` → **Join Unlinked & connect with Jacob** (or **Add Jacob
   to my connections** for a member).
2. Ideaflow sign-up or sign-in; the callback runs `addCard` and lands on
   `/c/<token>?added=1`: "You and Jacob are connected", **Message Jacob**,
   "Here's your card, share it back".

The request goes at the top of that `?added=1` state, above the share-back
card, as one block:

> **Jacob would like your phone number.**
> It goes to Jacob only. It is not added to your profile or your card unless
> you choose that below.
> `[ +1 415 555 0123 ]` (type=tel, autocomplete=tel, so iPhone offers the
> person's own number in one tap)
> `[ ] Also put it on my card` (off; "shown to anyone you show your card to")
> **Share my number with Jacob** · Not now

When Jacob's own card shows his phone number, the heading becomes
**Jacob shared his number with you. Share yours back?** Reciprocity is the
honest frame and the one that converts; the owner-side copy says so
("People share more readily when your own number is on your card").

Why after sign-in and not before: a number typed before an account exists has
no sharer identity to attach to, cannot be revoked, and reads as a lead form.
Why on the card page and not in Ideaflow sign-up: Ideaflow ID is shared by
every app and must stay neutral; this is an Unlinked-to-Unlinked exchange
between two connected members.

Who sees the block: a signed-in viewer whose relation to the card's owner is
`connected`, when the owner's `askPhone` is on, the card is open (not hidden,
reset or suspended) and no share or "Not now" exists for the pair. That covers
the fresh joiner, a member who tapped Add, and a connected member who comes
back to the card later. "Not now" is recorded and the block is not shown again
for that pair; the owner cannot re-ask through the product (they can message).
`?add=failed` shows no request: there is no connection.

After sharing, the card shows a quiet line: "You shared your number with
Jacob. [Stop sharing]".

## Where the number goes

Not onto the sharer's card and not onto a profile. It is a directed disclosure
from one member to one member, like handing a business card back, so it gets
its own owner-private record:

`UnlinkedContactShare { key, requesterOwnerId, requesterUserId, sharerOwnerId,
sharerUserId, field: 'phone', value (E.164), sharedAt, via: 'card-join' }`,
one per (pair, field), `key` unique. Declines are the same record with
`declinedAt` and no value, so "asked once" is enforced by the same constraint.
The store follows `contact-card.mjs`: `createMemoryContactShareStore`,
`createNeo4jContactShareStore`, `initialize()` with the uniqueness constraint,
`exportOwner`, `removeOwner`. The new label goes into graph-migration `LABELS`
before the first rollout, or the rollout backup fails closed.

Value rules: `normalizePhone` from `contact-card.mjs` (E.164, 7–15 digits,
punctuation dropped), the same error copy as the card form. No SMS and no OTP:
Unlinked never texts this number, so verification buys nothing and costs a
Twilio message and a step. The owner's view says "as they typed it". The
`unlinked-pxwr.1` reminders flow keeps OTP because it does text.

Optional second write: with "Also put it on my card" checked, the sharer's own
card is saved with `phone` and `showPhone: true` through the existing
`contactCards.save`, so the share-back card below immediately carries it.

## What the owner sees

- **Notification** `contact_shared`: "Cecilia shared her phone number",
  linking to `/network/contacts/<privateId>` (the member-connection row id,
  since these people have no profile). Included in the existing notification
  email digest under the existing preference; no new email kind.
- **Contact page** `/network/contacts/<id>`: a **Contact details** block above
  Profile details: phone as a `tel:` link, "Shared with you when they joined
  from your card · Oct 31 · as they typed it", **Save contact** (vCard with the
  number, rendered by `renderContactVcard` from a private projection) and
  **Remove**.
- **Your people** rows: a small phone glyph on contacts with a shared number.
- **Export**: the owner's export carries received shares; the sharer's carries
  the ones they gave.

Not shown: public profile, People index, company pages, hover cards, search,
model context, MCP tools, `/api/agent/v1`. Settings already promises "Contact
email addresses and phone numbers are never sent" to OpenAI; this keeps it.
Whether Jacob's own agent should read numbers shared with him is an open
decision (below), not a default.

## Privacy and abuse

- Request gated on an accepted connection, the owner's switch, and an open
  card. Resetting the card link does not touch shares already given; they are
  separate records between two accounts.
- One record per pair and field; no repeat asks.
- Either side can delete: sharer **Stop sharing**, requester **Remove**.
  Deleting either account removes the record (the sharer's deletion removes
  what they handed out; a vCard the owner already downloaded is theirs).
- Blocks apply: a block between the pair hides the block and refuses the POST.
- Browser-only endpoint `POST /c/<token>/phone` with `csrf`, `phone`,
  optional `toCard=yes`, or `decline=1`; same-origin, session CSRF, card
  re-opened and owner resolved server-side, no identity from form fields.
  Mirrors `POST /c/<token>/message`.
- Hidden, reset, suspended or deleted cards answer 404, as today.
- Settings privacy copy gains one sentence: "A phone number you share with a
  member when joining from their card is shown only to that member."

## Later, not now

- **Ask for LinkedIn too.** The same block with `field: 'linkedin'` would end
  the empty contact page for card joiners by feeding the existing
  "Know their LinkedIn?" attach path ([contact enrichment](contact-enrichment.md))
  with the person's own word instead of the owner's guess. The record shape
  leaves room for it (`field`), and email. Ship phone first.
- **Agent access.** `unlinked_lookup_contact` and the private-context panel
  could carry the number for the owner only, which is what makes "text Cecilia"
  work from Jacob's agent. It breaks the current "no contact phone leaves"
  contract in `account-tools.mjs`, so it is a decision for Jacob.
- **One card per person.** When the card moves into Noos as the shared
  overlay, shares move with it; the record is keyed by Ideaflow owners already.

## Implementation map

| Piece | Where |
|---|---|
| `askPhone` on the card record and `/card/contact` form | `mcp-server/contact-card.mjs`, `renderCard` in `private-onboarding-views.mjs` |
| Share model and stores | new `mcp-server/contact-shares.mjs` |
| Request block, share/decline route, "shared" line | `renderContactCard`; `private-browser.mjs` beside `cardMessage` |
| Owner contact page block, row glyph, vCard | contact page renderer, `renderContactVcard` |
| Notification kind, export, delete, block check | `member-notifications.mjs`, export/delete handlers, graph-migration `LABELS` |
| Tests | `tests/card-signup.test.mjs` (request shown and hidden by state), new `tests/contact-shares.test.mjs` |
| Docs | this file; a short section in `contact-card.md` |

Effort: one session for the store, route and card block; a second for the
owner's contact page, notification, export and deletion. Rollout follows the
usual runtime packet with the new label in the graph migration.
