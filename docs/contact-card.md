# Contact card

A member's card comes in two versions, both at `/card`, reached as **My card** in the Me menu, on Home, and as a tab of the Scan sheet behind the search field's QR button:

- **Public** (`/card?share=public`) — name, headline, location, the member's LinkedIn address (when their profile has one) and a QR code that opens the member's public profile (`/people/<id>`). Unchanged: no contact details.
- **With contact details** (default) — the business-card version. It carries the phone number, WhatsApp, email address and link the member switches on, and has its own QR code and link.

Implementation: `mcp-server/contact-card.mjs` (model, store, projection, vCard), routes in `mcp-server/private-browser.mjs`, pages in `mcp-server/private-onboarding-views.mjs` (`renderCard`, `renderContactCard`). Tests: `tests/contact-card.test.mjs` and `tests/card-signup.test.mjs`.

## Who can see what

| Surface | Contact details |
|---|---|
| Public profile, People index, company pages, search | Never |
| Model context, MCP tools, `/api/agent/v1` | Never |
| `/card?share=public` (Public version), `/scan`, `/profile`, Settings | Never |
| `/c/<token>` and `/c/<token>/contact.vcf` | Only the fields switched on |
| The member's own `/card` (also `/card?share=contact`) and `/export` | Everything they entered |

The contact card is reached only through `/c/<token>`. The token is 24 random alphanumerics (about 143 bits), unrelated to any account or profile id, so it cannot be derived from a public page. The page is sent with `noindex`, `no-store` and `Referrer-Policy: same-origin` (the token never leaves the site; `no-referrer` would make browsers send `Origin: null` with the page's Join/Add form, which the same-origin POST check refuses), and requests are bounded for the whole site.

## Day-one card

Every member has a QR code from the moment they sign up. The first time their
card is needed (`/card`, the scan sheet, or the "share it back" screen after
joining from someone's card), a missing card is created as **their name
alone** (plus headline and public profile link when they have them),
`shareCard: true`, with no contact detail. Why this option: it needs no tap
and publishes nothing. The card is not in the People index or any search; only
someone the member shows the code or link to can open it, and it reveals only
the name they introduce themselves with. The sign-in email is offered with
one tap (**Add you@… to my card**, `POST /card/contact/email`; the address
comes from the session, never the form), never added silently. A display name
that is an email address never becomes an automatic card. Creation is
create-if-absent (`MERGE … ON CREATE`), so two tabs end with one card and one link.

`/card` shows the card with its QR code first (on phones the QR panel sits
above the details), then the link, then the explanation and the form. The link
block (`shareLink` in the views, `CARD_SHARE_SCRIPT` on every page) shows the
same URL the QR code encodes with **Copy link** and, where the browser has a
share sheet, **Share…**, so the card can be texted or emailed across any
platform. The public version and the Scan sheet's My card tab carry the same
block; the public one is the member's `/people/<handle>` permalink.
Scanning your own card says **This is your card**.

## Hiding

- **One detail:** switch off "Show on my contact card" and save. The value stays with the member; the card stops showing it.
- **Everything:** switch off **Share my card** (`shareCard: false`) and save; `/c/<token>` and its contact file answer 404, the same as an unknown token. A card saved before this switch existed has none and keeps the old rule: shared exactly while some detail is shown.
- **People who already have the link:** "Reset the link" issues a new token. Every earlier link and QR code stops working at once.
- Deleting the account deletes the card and its link.

## Fields

`save()` validates and normalizes; anything else is refused with a typed `ContactCardError`.

| Field | Switch | Rule |
|---|---|---|
| `phone` | `showPhone` | E.164: `+`, country code, 7–15 digits. Spaces, dots, dashes and brackets are dropped. |
| `whatsapp` | `showWhatsapp` | Same form. Empty with the switch on means "use the phone number". |
| `email` | `showEmail` | A plain address, up to 254 characters. |
| `link` | `showLink` | `https` only, no credentials, up to 200 characters. |

The card also keeps the member's `name`, `headline`, `location`, public `linkedinUrl` and public `profilePath`, refreshed whenever they open `/card`, so the link can be rendered without their session. The LinkedIn address is part of the already-public identity (it appears on the public profile), not a switched contact detail; both card versions and the vCard show it. If the member's profile rows, legacy profile and signup source have no LinkedIn address, the card falls back to the validated address from the published profile its QR code opens. This does not replace an existing address; it also covers recovered profiles whose LinkedIn slug is joined only into the published profile.

Storage: one `UnlinkedContactCard` node per account in the pilot graph (`ownerKey` and `token` unique). `projectContactCard` is the single consent projection; the page, the owner's preview and the vCard all render from it.

## Relation to OpenChat's card

OpenChat has the same idea: an AddMe card at `https://chat.ideaflow.app/c/<token>` (`apps/server/src/services/addMeCard.ts`). The two are deliberately aligned:

- Same route (`/c/<token>`) and token grammar (24 alphanumerics), so `src/utils/meet-scan.js` reads both kinds of QR code.
- Same consent convention: each optional field has a value plus a `show…` switch, and a pure projection decides what a stranger sees.
- Same reset model: rotating the token kills earlier links.
- Both offer `contact.vcf`. Unlinked's downloads as `<First Last>.vcf` (`Content-Disposition` with an ASCII fallback and the exact UTF-8 name) and carries a structured `N` (family name = the last word of the display name, the rest as given names; one word is a given name only).

Differences today: OpenChat's card carries `headline`, `linkedIn`, `x`, `link`, avatar and status, and states that phone and email never appear on it. Unlinked's contact card adds `phone`, `whatsapp` and `email`.

Direction: one card per person, not one per app. The private overlay on people is planned to live in Noos, with Unlinked and OpenChat as two views of it. The contact card belongs there too: the member's own details and `show…` switches stored once, keyed by their Ideaflow sign-in, and each app rendering its own `/c/<token>` from the same projection. Until then the field names above are the contract; OpenChat adding `phone`/`whatsapp`/`email` should use exactly these names and rules (tracked in OpenChat's tracker).

Finding a person by phone number across apps is a separate question (`unlinked-aaz`). Nothing here makes a number searchable.

## Sharing and joining from a card

The owner sees their full professional details alongside the card. Contact details remain behind the separate, revocable `/c/<token>` link.

A contact card offers **Join Unlinked & connect with [name]** to guests (plus **Save contact**, which needs no account) and **Add [name] to my connections** to members. Viewing or scanning alone never writes. A same-origin POST records the token in the existing one-use OIDC login transaction; after verified signup/sign-in, the callback rechecks card visibility, token validity and active owners, connects the two accounts, and returns to that card. No archive or published profile is required. A shared contact-card token is an invitation capability, so its holder can connect without a separate owner approval. Owners see this disclosure beside their QR. Ordinary public-profile URLs remain read-only and retain the normal connection-request flow.

Existing connections and own-card scans are harmless; pending requests settle through the existing connection service. Hidden, reset or deleted cards cannot be used. Failed additions preserve the login and offer retry. Contact-card tokens and owner identifiers never go into provider URLs, public projections or agent grants. Browser-only endpoint: `POST /c/<token>/add`, same-origin required and session CSRF required when signed in.

## Joining from a scan

- **Contact card** (`/c/<token>`): after Join/Add the visitor lands on
  `/c/<token>?added=1`: "You and [name] are connected. Here's your card, share
  it back", with their own day-one card and QR code above the card they scanned.
- **Public profile** (`/people/<id>` of a member, the public QR): signed out,
  **Join Unlinked & connect with [name]** is a same-origin `POST
  /people/<id>/join` with no fields. It records the profile in the one-use
  login transaction (never in a URL); after Ideaflow sign-up or sign-in the
  connection request is sent like any other (the member accepts it), and the
  visitor lands on `/people/<id>?connect=sent&joined=1` with their own card to
  share back. Only member profiles accept it.
- Both work in Safari and in the iOS app. Sign-in keeps the scan target:
  `returnPath` accepts `/c/<token>`, `/people/lookup`, `/scan`
  (`?tab=scan|card`) and `/meet`, and those pages' header **Sign in** carries it.


## Message after a scan

After Join & connect returns to a card, **Message [first name]** appears above
“Here’s your card, share it back.” Returning signed-in viewers also see the
button on the card. Guests sign in or join first; self cards omit the action.

The CSRF-protected `POST /c/:token/message` reopens the live card and resolves
its current owner server-side. Hidden, reset or removed cards cannot open an
inbox. The trusted Ideaflow exchange provisions the owner’s OpenChat inbox even
without a published profile; its credential is discarded, and only the viewer’s
credential is used to open/reuse the direct conversation. No identity, email or
recipient id is accepted from browser fields. Blocks apply. The card capability
never leaves Unlinked or enters the conversation URL. Opening does not send a
message; unavailable messaging leaves a retry action on the card.
