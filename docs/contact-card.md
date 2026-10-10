# Contact card

A member's card comes in two versions, both at `/card`, directly accessible as **My card** in the main navigation:

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

The contact card is reached only through `/c/<token>`. The token is 24 random alphanumerics (about 143 bits), unrelated to any account or profile id, so it cannot be derived from a public page. The page is sent with `noindex`, `no-store` and `Referrer-Policy: no-referrer`, and requests are bounded for the whole site.

## Hiding

- **One detail:** switch off "Show on my contact card" and save. The value stays with the member; the card stops showing it.
- **Everything:** with every switch off, `/c/<token>` and its contact file answer 404, the same as an unknown token.
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

The card also keeps the member's `name`, `headline`, `location`, public `linkedinUrl` and public `profilePath`, refreshed whenever they open `/card`, so the link can be rendered without their session. The LinkedIn address is part of the already-public identity (it appears on the public profile), not a switched contact detail; both card versions and the vCard show it.

Storage: one `UnlinkedContactCard` node per account in the pilot graph (`ownerKey` and `token` unique). `projectContactCard` is the single consent projection; the page, the owner's preview and the vCard all render from it.

## Relation to OpenChat's card

OpenChat has the same idea: an AddMe card at `https://chat.ideaflow.app/c/<token>` (`apps/server/src/services/addMeCard.ts`). The two are deliberately aligned:

- Same route (`/c/<token>`) and token grammar (24 alphanumerics), so `src/utils/meet-scan.js` reads both kinds of QR code.
- Same consent convention: each optional field has a value plus a `show…` switch, and a pure projection decides what a stranger sees.
- Same reset model: rotating the token kills earlier links.
- Both offer `contact.vcf`.

Differences today: OpenChat's card carries `headline`, `linkedIn`, `x`, `link`, avatar and status, and states that phone and email never appear on it. Unlinked's contact card adds `phone`, `whatsapp` and `email`.

Direction: one card per person, not one per app. The private overlay on people is planned to live in Noos, with Unlinked and OpenChat as two views of it. The contact card belongs there too: the member's own details and `show…` switches stored once, keyed by their Ideaflow sign-in, and each app rendering its own `/c/<token>` from the same projection. Until then the field names above are the contract; OpenChat adding `phone`/`whatsapp`/`email` should use exactly these names and rules (tracked in OpenChat's tracker).

Finding a person by phone number across apps is a separate question (`unlinked-aaz`). Nothing here makes a number searchable.

## Sharing and joining from a card

The owner sees their full professional details alongside the card. Contact details remain behind the separate, revocable `/c/<token>` link.

A contact card offers **Sign up & add [name]** to guests and **Add [name] to my connections** to members. Viewing or scanning alone never writes. A same-origin POST records the token in the existing one-use OIDC login transaction; after verified signup/sign-in, the callback rechecks card visibility, token validity and active owners, connects the two accounts, and returns to that card. No archive or published profile is required. A shared contact-card token is an invitation capability, so its holder can connect without a separate owner approval. Owners see this disclosure beside their QR. Ordinary public-profile URLs remain read-only and retain the normal connection-request flow.

Existing connections and own-card scans are harmless; pending requests settle through the existing connection service. Hidden, reset or deleted cards cannot be used. Failed additions preserve the login and offer retry. Contact-card tokens and owner identifiers never go into provider URLs, public projections or agent grants. Browser-only endpoint: `POST /c/<token>/add`, same-origin required and session CSRF required when signed in.
