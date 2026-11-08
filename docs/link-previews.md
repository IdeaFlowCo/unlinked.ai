# Titles and link previews

Every page's tab title names what is open, specific thing first (`Jacob Cole · Unlinked`, `Results for “founders” · Unlinked`); views set it through `base(title, …)` in `mcp-server/private-onboarding-views.mjs`. Link previews (Open Graph and Twitter card tags) are written in the page head by `previewMeta` in `mcp-server/link-preview.mjs`.

## What a shared link previews as

| Page | Preview |
|---|---|
| `/` (signed out) | Unlinked, its one-line description |
| `/agents`, `/meet`, `/import-linkedin`, `/support`, `/data-liberation` | The page title and a fixed description |
| `/people/<handle>` read without a session | The person's name; headline (else current role) and location; their published photo when the page shows one; `og:url` and `rel=canonical` at the current handle |
| `/companies/<name>` read without a session | The company name |
| Everything else: signed-in pages, contact pages (`/network/contacts/…`), contact cards (`/c/<token>`), private context, shared lists, sign-in, errors and “busy” pages | The neutral site preview (`SITE_PREVIEW`): “Unlinked” and the site description |

A specific preview is opt-in: only a view that carries `view.preview` gets one, and the routes set it only for the public pages above. A person preview reads only fields the public profile page shows (`personPreview`); images and addresses are same-origin paths only. Contact details, owner notes, private imports and the viewer's own data never reach a preview. The tab title of a signed-in page can stay specific (it is shown only to that viewer); its unfurl stays neutral.

A contact card (`/c/<token>`) previews neutrally even though the person sharing it chose to: the card can carry contact details, and the preview would sit in the recipient's message thread. Changing that is a product decision.

## Link-unfurl lane

Unfurlers fetch one page head when someone shares a link. They all say so in their user agent, so `declaredAutomation` (`mcp-server/client-address.mjs`) keeps them on the shared anonymous fuse with SEO crawlers; while ShapBot, Semrush or DataForSeo hold that fuse, a profile link shared in iMessage previewed as “Unlinked is busy right now”.

Known unfurlers (`linkUnfurler`: `facebookexternalhit`/`Facebot` (also iMessage), `Twitterbot`, `Slackbot-LinkExpanding`, `Discordbot`, `LinkedInBot`, `WhatsApp`, `TelegramBot`, `SkypeUriPreview`, `Mastodon`) opening `/people/<handle>` without a session get a small lane of their own (`createLinkPreviewAdmission`): 60 reads a minute in total, 10 per visitor key, at most two at once, no queue. The lane serves a meta-only page (`previewDocument`) from one in-memory published-snapshot lookup (`reader.lookup`, 800 ms bound), never the full profile render. Over budget, slow or unreadable, the request continues on the ordinary path and shared fuse exactly as before.

Trade-off: anyone can claim an unfurler's user agent. A spoofer gains at most this bounded lane of name/headline/location reads that the public page already shows, and can exhaust it, in which case unfurls fall back to the shared fuse (the previous behavior). SEO and AI crawlers are deliberately not on the list. Admission aggregates record the lane as `preview` (`docs/request-diagnostics.md`). Connections, company and search pages are not on the lane.

Tests: `tests/link-previews.test.mjs`.
